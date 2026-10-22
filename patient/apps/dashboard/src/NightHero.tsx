import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { classOf, fetchRecallDetail, fetchRecallWire, rel } from "./lib";
import { fetchMonitorStatus, type MonitorStatus, type Patient, type PatientNotification } from "./patientApi";
import { COUNTRY_LL, STATE_LL, type GlobeMarker } from "./globeData";
import type { GlobeHandle } from "./Globe";
import RecallTicker from "./RecallTicker";
import "./hero.css";
import "./hero2.css";

// Hero nocturno: la vigilancia en vivo hecha visible. El globo ocupa todo el hero;
// el texto flota encima a la izquierda. Puntos verdes = fabricantes con recalls
// recientes en openFDA; rojo/ámbar = los recalls que tocan los medicamentos del paciente.

const Globe = lazy(() => import("./Globe"));

type Sev = "I" | "II" | "III";
const SEV_WORD: Record<Sev, string> = { I: "Serious", II: "Moderate", III: "Low" };

function locate(state?: string, country?: string): [number, number] | null {
  const s = (state ?? "").trim().toUpperCase();
  if (s && STATE_LL[s]) return STATE_LL[s]!;
  const c = (country ?? "").trim();
  if (c && COUNTRY_LL[c]) return COUNTRY_LL[c]!;
  return null;
}

function useCountUp(target: number, ms = 1600): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!target) return;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setV(Math.round(target * (1 - Math.pow(1 - k, 4))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

/** Texto que se "descifra" letra por letra al cambiar. */
function Scramble({ text }: { text: string }) {
  const [out, setOut] = useState(text);
  useEffect(() => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
    let frame = 0;
    const total = 18;
    const id = setInterval(() => {
      frame++;
      const done = Math.floor((frame / total) * text.length);
      setOut(
        text
          .split("")
          .map((c, i) => (i < done || c === " " ? c : chars[Math.floor(Math.random() * chars.length)]))
          .join(""),
      );
      if (frame >= total) {
        setOut(text);
        clearInterval(id);
      }
    }, 34);
    return () => clearInterval(id);
  }, [text]);
  return <span className="nh-scramble">{out}</span>;
}

function Words({ text, accent, delay = 0 }: { text: string; accent?: string; delay?: number }) {
  const words = text.split(" ");
  const acc = accent ? accent.split(" ") : [];
  return (
    <>
      {words.map((w, i) => (
        <span key={`${w}-${i}`} className="nh-w" style={{ animationDelay: `${delay + i * 70}ms` }}>
          {w}&nbsp;
        </span>
      ))}
      {acc.map((w, i) => (
        <span key={`a-${w}-${i}`} className="nh-w nh-accent" style={{ animationDelay: `${delay + (words.length + i) * 70}ms` }}>
          {w}
          {i < acc.length - 1 ? " " : ""}
        </span>
      ))}
    </>
  );
}

const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const sevRank = (c: Sev) => (c === "I" ? 0 : c === "II" ? 1 : 2);

function PillIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <g transform="rotate(-40 12 12)">
        <rect x="4" y="8" width="16" height="8" rx="4" />
        <path d="M12 8v8" />
        <path d="M12 8h4a4 4 0 0 1 0 8h-4z" fill="currentColor" fillOpacity="0.25" />
      </g>
    </svg>
  );
}

interface MineMarker extends GlobeMarker {
  n: PatientNotification;
  place: string;
}

export default function NightHero({
  patient,
  sorted,
  loading,
  onReview,
}: {
  patient: Patient;
  sorted: PatientNotification[];
  loading: boolean;
  onReview: (id?: string) => void;
}) {
  const [wire, setWire] = useState<{ n: number; markers: GlobeMarker[] }>({ n: 0, markers: [] });
  const [mine, setMine] = useState<MineMarker[]>([]);
  const [st, setSt] = useState<MonitorStatus | null>(null);
  const [focus, setFocus] = useState<GlobeMarker | null | undefined>(undefined);
  const [picked, setPicked] = useState<MineMarker | null>(null);
  const [scanIdx, setScanIdx] = useState(0);
  const [, force] = useState(0);
  const control = useRef<GlobeHandle | null>(null);
  const [wide, setWide] = useState(() => matchMedia("(min-width: 901px)").matches);

  useEffect(() => {
    const mq = matchMedia("(min-width: 901px)");
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const w = await fetchRecallWire();
        if (!alive) return;
        const seen = new Set<string>();
        const markers: GlobeMarker[] = [];
        for (const r of w.recalls) {
          const ll = locate(r.state, r.country);
          if (!ll) continue;
          const k = ll.join();
          if (seen.has(k)) continue;
          seen.add(k);
          markers.push({ lat: ll[0], lon: ll[1], tone: "bg" });
        }
        setWire({ n: w.recalls.length, markers });
      } catch {
        /* sin cable, el globo sigue */
      }
    };
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const ids = sorted.map((n) => n.id).join("|");
  useEffect(() => {
    let alive = true;
    void (async () => {
      const out: MineMarker[] = [];
      const seen = new Set<string>();
      for (const n of sorted.slice(0, 12)) {
        let state = n.state;
        let country = n.country;
        if (!locate(state, country) && !n.synthetic) {
          const d = await fetchRecallDetail(n.recallId);
          state = d?.record.state as string | undefined;
          country = d?.record.country as string | undefined;
        }
        const ll = locate(state, country);
        if (!ll) continue;
        const k = `${ll.join()}:${n.classification}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
          lat: ll[0],
          lon: ll[1],
          tone: classOf(n.classification) as Sev,
          id: n.recallId,
          n,
          place: (state && STATE_LL[state.toUpperCase()] ? state.toUpperCase() : country) ?? "",
        });
      }
      if (alive) setMine(out);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await fetchMonitorStatus();
        if (alive) setSt(s);
      } catch {
        /* sin latido */
      }
    };
    void tick();
    const a = setInterval(tick, 5000);
    const b = setInterval(() => force((x) => x + 1), 1000);
    const c = setInterval(() => setScanIdx((i) => i + 1), 2600);
    return () => {
      alive = false;
      clearInterval(a);
      clearInterval(b);
      clearInterval(c);
    };
  }, []);

  const markers = useMemo(() => [...wire.markers, ...mine], [wire.markers, mine]);
  const watched = useCountUp(wire.n);
  const tracked = useCountUp(patient.drugs.length, 900);

  const worstByDrug = useMemo(() => {
    const m = new Map<string, { sev: Sev; count: number; first: PatientNotification }>();
    for (const n of sorted) {
      const k = n.drug.toLowerCase();
      const c = classOf(n.classification) as Sev;
      const cur = m.get(k);
      if (!cur) m.set(k, { sev: c, count: 1, first: n });
      else m.set(k, { sev: sevRank(c) < sevRank(cur.sev) ? c : cur.sev, count: cur.count + 1, first: cur.first });
    }
    return m;
  }, [sorted]);

  const first = patient.name.split(/\s+/)[0];
  const h = new Date().getHours();
  const greet = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const last = st?.lastRunAt ? new Date(st.lastRunAt) : null;
  const next = st?.nextRunAt ? Math.max(0, Math.round((Date.parse(st.nextRunAt) - Date.now()) / 1000)) : null;
  const nAff = patient.drugs.filter((d) => worstByDrug.has(d.toLowerCase())).length;
  const worst = sorted[0] ? (classOf(sorted[0].classification) as Sev) : null;
  const tone = loading || nAff === 0 ? "clear" : worst === "I" ? "alert" : "watch";
  const scanning = patient.drugs.length ? patient.drugs[scanIdx % patient.drugs.length]! : "";

  const flyToDrug = (d: string) => {
    const m = mine.find((x) => x.n.drug.toLowerCase() === d.toLowerCase());
    if (m) {
      setFocus({ ...m });
      setPicked(m);
    }
  };

  const floating = mine.slice(0, 3);

  return (
    <section className={`nh nh-${tone}`}>
      <div className="nh-bg" aria-hidden="true">
        <div className="nh-gridlines" />
        <div className="nh-rings">
          <i />
          <i />
          <i />
        </div>
        <div className="nh-grain" />
      </div>

      <div className="nh-stage">
        <Suspense fallback={<div className="ss-globe" />}>
          <Globe
            markers={markers}
            arcs={mine}
            focus={focus}
            shift={wide ? 0.27 : 0}
            control={control}
            onPick={(m) => {
              const hit = m ? mine.find((x) => x.lat === m.lat && x.lon === m.lon) : null;
              setPicked(hit ?? null);
              if (!m) setFocus(null);
            }}
          />
        </Suspense>
      </div>

      <div className="nh-inner">
        <div className="nh-copy">
          <p className="nh-greet">
            {greet}, {first}.
          </p>
          <h1 className="nh-title" key={`${tone}-${nAff}`}>
            {loading ? (
              <Words text="Checking your medicines" />
            ) : nAff === 0 ? (
              <Words text="Every medicine you take is" accent="clear." />
            ) : (
              <Words text={`${nAff === 1 ? "One" : nAff} of your medicines ${nAff === 1 ? "is" : "are"} in an`} accent="active recall." />
            )}
          </h1>
          <p className="nh-sub">
            {nAff === 0
              ? "We check each one against every new FDA recall, day and night. Nothing for you to do."
              : "A name match is not proof your bottle is affected. Checking the lot number takes about a minute, and we will walk you through it."}
          </p>

          <div className="nh-meds">
            {patient.drugs.map((d, i) => {
              const w = worstByDrug.get(d.toLowerCase());
              return (
                <button
                  key={d}
                  className={`nh-med ${w ? `s${w.sev}` : "ok"}`}
                  style={{ animationDelay: `${700 + i * 90}ms` }}
                  onClick={() => (w ? flyToDrug(d) : undefined)}
                  title={w ? "Show on the map" : undefined}
                >
                  <span className="nh-med-ico">
                    <PillIcon />
                  </span>
                  <span className="nh-med-txt">
                    <b>{titleCase(d)}</b>
                    <small>{w ? `${w.count} recall${w.count > 1 ? "s" : ""}, ${SEV_WORD[w.sev].toLowerCase()}` : "No active recalls"}</small>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="nh-actions">
            {nAff > 0 && (
              <button className="nh-cta" onClick={() => onReview()}>
                <span>Check my lot numbers</span>
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M4 10h11m-4-4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>

          <dl className="nh-stats">
            <div>
              <dt>FDA reports watched</dt>
              <dd>{watched.toLocaleString("en-US")}</dd>
            </div>
            <div>
              <dt>Medicines tracked</dt>
              <dd>{tracked}</dd>
            </div>
            <div>
              <dt>Next sweep</dt>
              <dd>
                {st?.running && next !== null ? (
                  <>
                    {next}
                    <span>s</span>
                  </>
                ) : (
                  "Soon"
                )}
              </dd>
            </div>
          </dl>
          <p className="nh-scan">
            <span className="nh-scan-dot" aria-hidden="true" />
            Now checking <Scramble text={titleCase(scanning).toUpperCase()} />
            <em>{last ? `Last sweep ${rel(last)}` : ""}</em>
          </p>
        </div>
      </div>

      {floating.map((m, i) => (
        <button
          key={`${m.id}-${i}`}
          className={`nh-float f${i} s${m.tone}`}
          onClick={() => {
            setFocus({ ...m });
            setPicked(m);
          }}
        >
          <span className="nh-float-dot" />
          <span className="nh-float-txt">
            <b>{titleCase(m.n.drug)}</b>
            <small>
              {SEV_WORD[m.tone as Sev]} recall{m.place ? `, made in ${m.place}` : ""}
            </small>
          </span>
        </button>
      ))}

      <div className="nh-zoom" role="group" aria-label="Globe controls">
        <button onClick={() => control.current?.zoom(1)} aria-label="Zoom in">+</button>
        <button onClick={() => control.current?.zoom(-1)} aria-label="Zoom out">−</button>
        <button
          onClick={() => {
            control.current?.reset();
            setPicked(null);
          }}
          aria-label="Reset view"
          className="nh-reset"
        >
          ⟲
        </button>
      </div>

      <div className="nh-legend">
        <span>
          <i className="bg" />
          Recent FDA recalls
        </span>
        <span>
          <i className="mine" />
          Your medicines
        </span>
        <span className="nh-hint">Drag to spin. Double click to zoom in.</span>
      </div>

      {picked && (
        <div className={`nh-card s${picked.tone}`} role="dialog" aria-label="Recall on the map">
          <button className="nh-card-x" onClick={() => setPicked(null)} aria-label="Close">
            ×
          </button>
          <span className="nh-card-sev">{SEV_WORD[picked.tone as Sev]} recall</span>
          <b>{titleCase(picked.n.drug)}</b>
          <p>{picked.n.reason}</p>
          <small>
            {picked.n.firm ?? "Manufacturer not listed"}
            {picked.place ? `, ${picked.place}` : ""} · {picked.n.recallId}
          </small>
          <button className="nh-card-cta" onClick={() => onReview(picked.n.id)}>
            See what to do
          </button>
        </div>
      )}

      <RecallTicker />
    </section>
  );
}
