import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { classOf, fetchRecallDetail, fetchRecallWire, rel } from "./lib";
import { fetchMonitorStatus, type MonitorStatus, type Patient, type PatientNotification } from "./patientApi";
import { COUNTRY_LL, STATE_LL, type GlobeMarker } from "./globeData";
import "./hero.css";

// Hero nocturno: la vigilancia en vivo hecha visible. Globo 3D con los recalls
// reales de openFDA (puntos verdes = fabricantes con recalls recientes; rojo/ámbar
// = los recalls que tocan los medicamentos del paciente, con arcos desde "casa").

const Globe = lazy(() => import("./Globe"));

type Sev = "I" | "II" | "III";

function locate(state?: string, country?: string): [number, number] | null {
  const s = (state ?? "").trim().toUpperCase();
  if (s && STATE_LL[s]) return STATE_LL[s]!;
  const c = (country ?? "").trim();
  if (c && COUNTRY_LL[c]) return COUNTRY_LL[c]!;
  return null;
}

function useCountUp(target: number, ms = 1400): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!target) return;
    const from = 0;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setV(Math.round(from + (target - from) * (1 - Math.pow(1 - k, 4))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
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
        <span
          key={`a-${w}-${i}`}
          className="nh-w nh-accent"
          style={{ animationDelay: `${delay + (words.length + i) * 70}ms` }}
        >
          {w}
          {i < acc.length - 1 ? " " : ""}
        </span>
      ))}
    </>
  );
}

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
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
  onReview: () => void;
}) {
  const [wire, setWire] = useState<{ n: number; markers: GlobeMarker[] }>({ n: 0, markers: [] });
  const [mine, setMine] = useState<GlobeMarker[]>([]);
  const [st, setSt] = useState<MonitorStatus | null>(null);
  const [, force] = useState(0);

  // Fabricantes con recalls recientes en openFDA (todos los pacientes).
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
        /* el hero sigue sin el cable */
      }
    };
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Recalls del paciente: ubicación del fabricante (del aviso o del registro FDA).
  const ids = sorted.map((n) => n.id).join("|");
  useEffect(() => {
    let alive = true;
    void (async () => {
      const out: GlobeMarker[] = [];
      const seen = new Set<string>();
      for (const n of sorted.slice(0, 12)) {
        let ll = locate(n.state, n.country);
        if (!ll && !n.synthetic) {
          const d = await fetchRecallDetail(n.recallId);
          ll = d ? locate(d.record.state as string | undefined, d.record.country as string | undefined) : null;
        }
        if (!ll) continue;
        const k = `${ll.join()}:${n.classification}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ lat: ll[0], lon: ll[1], tone: classOf(n.classification) as Sev });
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
    return () => {
      alive = false;
      clearInterval(a);
      clearInterval(b);
    };
  }, []);

  const markers = useMemo(() => [...wire.markers, ...mine], [wire.markers, mine]);
  const watched = useCountUp(wire.n);
  const affected = useMemo(() => {
    const m = new Map<string, Sev>();
    for (const n of sorted) {
      const k = n.drug.toLowerCase();
      const c = classOf(n.classification) as Sev;
      const cur = m.get(k);
      if (!cur || (c === "I" ? 0 : c === "II" ? 1 : 2) < (cur === "I" ? 0 : cur === "II" ? 1 : 2)) m.set(k, c);
    }
    return m;
  }, [sorted]);

  const first = patient.name.split(/\s+/)[0];
  const h = new Date().getHours();
  const greet = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const last = st?.lastRunAt ? new Date(st.lastRunAt) : null;
  const next = st?.nextRunAt ? Math.max(0, Math.round((Date.parse(st.nextRunAt) - Date.now()) / 1000)) : null;
  const nAff = [...affected.keys()].filter((k) => patient.drugs.some((d) => d.toLowerCase() === k)).length;
  const worst = sorted[0] ? (classOf(sorted[0].classification) as Sev) : null;
  const tone = loading || nAff === 0 ? "clear" : worst === "I" ? "alert" : "watch";

  return (
    <section className={`nh nh-${tone}`}>
      <div className="nh-grain" aria-hidden="true" />
      <div className="nh-inner">
        <div className="nh-copy">
          <p className="nh-live">
            <span className="nh-live-dot" aria-hidden="true" />
            {st?.running ? "Live" : "Connecting"} · watching{" "}
            <b className="nh-num">{watched.toLocaleString("en-US")}</b> FDA recall reports
          </p>

          <p className="nh-greet">
            {greet}, {first}.
          </p>
          <h1 className="nh-title" key={`${tone}-${nAff}`}>
            {loading ? (
              <Words text="Checking your medications…" />
            ) : nAff === 0 ? (
              <Words text="Every medicine you take is" accent="clear." />
            ) : (
              <Words
                text={`${nAff === 1 ? "One" : nAff} of your medicines ${nAff === 1 ? "is" : "are"} in an`}
                accent="active recall."
              />
            )}
          </h1>
          <p className="nh-sub">
            {nAff === 0
              ? "SuperShield checks each one against every new FDA recall, around the clock. Nothing to do."
              : "A name match isn’t proof your bottle is affected. Checking the lot number takes about a minute — we’ll walk you through it."}
          </p>

          <div className="nh-meds">
            {patient.drugs.map((d, i) => {
              const s = affected.get(d.toLowerCase());
              return (
                <span key={d} className={`nh-med ${s ? `s${s}` : "ok"}`} style={{ animationDelay: `${600 + i * 90}ms` }}>
                  <i aria-hidden="true" />
                  {titleCase(d)}
                </span>
              );
            })}
          </div>

          <div className="nh-actions">
            {nAff > 0 && (
              <button className="nh-cta" onClick={onReview}>
                <span>Check my lot numbers</span>
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M4 10h11m-4-4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            <span className="nh-meta">
              {last ? `Last sweep ${rel(last)}` : "First sweep starting"}
              {st?.running && next !== null ? ` · next in ${next}s` : ""}
            </span>
          </div>
        </div>

        <div className="nh-globe-wrap">
          <Suspense fallback={<div className="ss-globe" />}>
            <Globe markers={markers} arcs={mine} />
          </Suspense>
          <div className="nh-legend" aria-hidden="true">
            <span><i className="bg" />Recalls in the last FDA reports</span>
            {mine.length > 0 && <span><i className="mine" />Affecting your medicines</span>}
          </div>
        </div>
      </div>
    </section>
  );
}
