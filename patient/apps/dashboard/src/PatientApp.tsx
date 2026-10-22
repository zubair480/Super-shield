import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  CLASS_META,
  classOf,
  clean,
  fetchRecallDetail,
  firmPlace,
  fmtFdaDate,
  plainBulletin,
  reasonGist,
  rel,
  statusLabel,
  type DetailState,
} from "./lib";
import {
  checkDrug,
  createPatient,
  deliveryLabel,
  fetchMonitorStatus,
  fetchNotifications,
  fetchPatients,
  updateDrugs,
  type MonitorStatus,
  type Patient,
  type PatientNotification,
} from "./patientApi";
import "./patient.css";
import "./patient-sections.css";
import "./motion.css";
import { useReveal } from "./reveal";
import NightHero from "./NightHero";

// SuperShield — experiencia del paciente. Responde primero "¿estoy bien?",
// luego qué medicamento está afectado y qué hacer, paso a paso.

const POLL_MS = 5000;
const LS_KEY = "supershield.patient";
const MAX_DRUGS = 8;

type Sev = "I" | "II" | "III";
const SEV_WORD: Record<Sev, string> = { I: "Serious", II: "Moderate", III: "Low" };

/* ── utilidades ───────────────────────────────────────────────────────── */

function readStoredId(): string | null {
  const q = new URLSearchParams(location.search).get("patient");
  if (q) return q;
  try {
    return localStorage.getItem(LS_KEY);
  } catch {
    return null;
  }
}

function persistId(id: string | null) {
  const url = new URL(location.href);
  if (id) url.searchParams.set("patient", id);
  else url.searchParams.delete("patient");
  history.replaceState(null, "", url.toString());
  try {
    if (id) localStorage.setItem(LS_KEY, id);
    else localStorage.removeItem(LS_KEY);
  } catch {
    /* sin storage: la URL basta */
  }
}

function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function toDate(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Lotes legibles del texto libre de openFDA ("Lot # 1169752A, exp..."). */
function extractLots(code?: string): string[] {
  const s = clean(code);
  if (!s) return [];
  const out = new Set<string>();
  const re = /\blots?\b\s*(?:#|no\.?|numbers?)?\s*:?\s*([A-Z0-9][A-Z0-9-]{3,})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.add(m[1]!.toUpperCase());
  // Después de "Lot #", openFDA suele listar más códigos sueltos separados por espacio/coma.
  for (const tok of s.split(/[\s,;]+/)) {
    if (/^[A-Z]{0,3}\d{5,}[A-Z]?$/i.test(tok) && !/^20\d{6}$/.test(tok)) out.add(tok.toUpperCase());
  }
  return [...out].slice(0, 12);
}

function notifSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function sevRank(c: Sev): number {
  return c === "I" ? 0 : c === "II" ? 1 : 2;
}

/* ── raíz ─────────────────────────────────────────────────────────────── */

export default function PatientApp() {
  const [patients, setPatients] = useState<Patient[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [patientId, setPatientId] = useState<string | null>(readStoredId);
  const [showNew, setShowNew] = useState(false);

  const loadPatients = useCallback(async () => {
    try {
      const list = await fetchPatients();
      setPatients(list);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load profiles");
    }
  }, []);

  useEffect(() => {
    void loadPatients();
  }, [loadPatients]);

  useEffect(() => {
    if (!patients) return;
    if (patientId && patients.some((p) => p.id === patientId)) return;
    setPatientId(patients[0]?.id ?? null);
  }, [patients, patientId]);

  useEffect(() => {
    if (patients) persistId(patientId);
  }, [patientId, patients]);

  const patient = patients?.find((p) => p.id === patientId) ?? null;

  const onUpdated = (p: Patient) =>
    setPatients((list) => (list ? list.map((x) => (x.id === p.id ? p : x)) : [p]));

  const onCreated = (p: Patient) => {
    setShowNew(false);
    setPatients((list) => [...(list ?? []).filter((x) => x.id !== p.id), p]);
    setPatientId(p.id);
  };

  useReveal();

  return (
    <div className="ss">
      <div className="ss-night">
      <div className="ss-shell">
        <header className="ss-top">
          <a className="ss-brand" href="/">
            <ShieldMark />
            SuperShield
          </a>
          <div className="ss-top-right">
            <Pulse />
            {patients && patients.length > 0 && patient && (
              <label className="ss-profile" title="Switch profile">
                <span className="ss-avatar" aria-hidden="true">
                  {initials(patient.name)}
                </span>
                <select
                  value={patientId ?? ""}
                  onChange={(e) => setPatientId(e.target.value || null)}
                  aria-label="Profile"
                >
                  {patients.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button className="ss-icon-btn" onClick={() => setShowNew(true)} aria-label="New profile" title="New profile">
              +
            </button>
          </div>
        </header>
      </div>
      </div>
      <div className="ss-shell">

        {loadError && !patients && (
          <div className="ss-hero attention">
            <h1 className="ss-headline">We can’t reach SuperShield right now.</h1>
            <p className="ss-sub">{loadError}</p>
            <div className="ss-hero-actions">
              <button className="ss-btn primary" onClick={() => void loadPatients()}>
                Try again
              </button>
            </div>
          </div>
        )}

        {patients && patients.length === 0 && (
          <div className="ss-hero clear">
            <h1 className="ss-headline">
              Know the moment a medicine you take is <em>recalled.</em>
            </h1>
            <p className="ss-sub">
              Add your medications once. SuperShield watches the FDA’s recall reports around the clock
              and tells you — in plain language — if one of them is affected.
            </p>
            <div className="ss-hero-actions">
              <button className="ss-btn primary" onClick={() => setShowNew(true)}>
                Add my medications
              </button>
            </div>
          </div>
        )}

        {patient && <Home key={patient.id} patient={patient} onUpdated={onUpdated} />}

        <footer className="ss-foot">
          <span>
            Recall data from the U.S. FDA enforcement reports via openFDA. SuperShield is not a substitute
            for advice from your pharmacist or doctor.
          </span>
          <a href="/events">Activity log</a>
        </footer>
      </div>

      {showNew && <NewProfileSheet onClose={() => setShowNew(false)} onCreated={onCreated} />}
    </div>
  );
}

function ShieldMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M16 3 5 7v8.2c0 6.7 4.6 11.7 11 13.8 6.4-2.1 11-7.1 11-13.8V7L16 3Z"
        fill="var(--green)"
      />
      <path d="m11 16.2 3.4 3.4L21.5 12.5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── latido del monitor (barra superior) ───────────────────────────────── */

function Pulse() {
  const [st, setSt] = useState<MonitorStatus | null>(null);
  const [err, setErr] = useState(false);
  useNow(5000);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await fetchMonitorStatus();
        if (alive) {
          setSt(s);
          setErr(false);
        }
      } catch {
        if (alive) setErr(true);
      }
    };
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const live = !!st?.running && !err;
  const last = toDate(st?.lastRunAt);
  const title = st
    ? `Checks every ${st.intervalSec}s against ${st.dataSource === "openfda" ? "live openFDA" : "the demo fixture"} · ${st.patientsChecked} profiles${st.lastError ? ` · last error: ${st.lastError}` : ""}`
    : undefined;

  return (
    <span className={`ss-pulse ${live ? "" : "off"}`} title={title}>
      <span className="ss-pulse-dot" aria-hidden="true" />
      <span className="ss-pulse-text">
        {err ? (
          "Monitor unreachable"
        ) : !st ? (
          "Connecting…"
        ) : live ? (
          <>
            <b>Watching FDA</b> · checked {last ? rel(last) : "just now"}
          </>
        ) : (
          "Monitoring paused"
        )}
      </span>
    </span>
  );
}

/* ── inicio del paciente ──────────────────────────────────────────────── */

function Home({ patient, onUpdated }: { patient: Patient; onUpdated: (p: Patient) => void }) {
  const [notifs, setNotifs] = useState<PatientNotification[] | null>(null);
  const [notifErr, setNotifErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fresh, setFresh] = useState<PatientNotification | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const list = await fetchNotifications(patient.id);
        if (!alive) return;
        setNotifErr(null);
        setNotifs(list);
        if (seen.current === null) {
          seen.current = new Set(list.map((n) => n.id));
          return;
        }
        const added = list.filter((n) => !seen.current!.has(n.id));
        if (added.length) {
          added.forEach((n) => seen.current!.add(n.id));
          setFresh(added[0]!);
          if (notifSupported() && Notification.permission === "granted") {
            for (const n of added) {
              try {
                new Notification(`Recall alert: ${n.drug}`, {
                  body: `${SEV_WORD[classOf(n.classification)]} FDA recall — ${n.reason}`.slice(0, 200),
                  tag: n.id,
                });
              } catch {
                /* algunos navegadores exigen service worker */
              }
            }
          }
        }
      } catch (e) {
        if (alive) setNotifErr(e instanceof Error ? e.message : "Could not load alerts");
      }
    };
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [patient.id]);

  // Severidad primero, luego lo más reciente.
  const sorted = useMemo(
    () =>
      [...(notifs ?? [])].sort(
        (a, b) =>
          sevRank(classOf(a.classification)) - sevRank(classOf(b.classification)) ||
          b.createdAt.localeCompare(a.createdAt),
      ),
    [notifs],
  );

  const byDrug = useMemo(() => {
    const m = new Map<string, PatientNotification[]>();
    for (const n of sorted) {
      const k = n.drug.toLowerCase();
      m.set(k, [...(m.get(k) ?? []), n]);
    }
    return m;
  }, [sorted]);

  const visible = filter ? sorted.filter((n) => n.drug.toLowerCase() === filter) : sorted;

  useEffect(() => {
    if (!visible.length) return;
    if (!selectedId || !visible.some((n) => n.id === selectedId)) setSelectedId(visible[0]!.id);
  }, [visible, selectedId]);

  const selected = visible.find((n) => n.id === selectedId) ?? null;

  const open = (id: string) => {
    setSelectedId(id);
    setFresh(null);
    requestAnimationFrame(() =>
      document.getElementById("ss-alerts")?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  const affectedDrugs = [...byDrug.keys()].filter((k) =>
    patient.drugs.some((d) => d.toLowerCase() === k),
  );
  const top = sorted[0];
  const topSev = top ? classOf(top.classification) : null;

  return (
    <>
      {fresh && (
        <div className="ss-toast" role="alert" aria-live="assertive">
          <span className={`ss-toast-mark s${classOf(fresh.classification)}`} aria-hidden="true" />
          <div className="ss-toast-text">
            <b>New recall for {titleCase(fresh.drug)}</b>
            <span>{reasonGist(fresh.reason) ?? fresh.reason}</span>
          </div>
          <button className="ss-btn sm primary" onClick={() => open(fresh.id)}>
            See what to do
          </button>
          <button className="ss-toast-x" onClick={() => setFresh(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <NightHero patient={patient} sorted={sorted} loading={!notifs} onReview={() => top && open(top.id)} />

      <Medications
        patient={patient}
        onUpdated={onUpdated}
        byDrug={byDrug}
        filter={filter}
        onFilter={(k) => setFilter((cur) => (cur === k ? null : k))}
      />

      <section className="ss-section" id="ss-alerts">
        <div className="ss-section-head">
          <h2>Recall alerts</h2>
          <p>
            {filter
              ? `Showing ${titleCase(filter)} · `
              : notifs && notifs.length
                ? `${notifs.length} active · most serious first`
                : ""}
            {filter && (
              <button className="ss-linkbtn" onClick={() => setFilter(null)}>
                show all
              </button>
            )}
          </p>
          <span className="ss-right">
            <DesktopAlerts />
          </span>
        </div>

        {notifErr && <p className="ss-err">Couldn’t refresh alerts ({notifErr}).</p>}

        {notifs && notifs.length === 0 ? (
          <div className="ss-allclear">
            <ShieldMark />
            <div>
              <b>No recalls affect your medications.</b>
              <span>We’ll alert you here the moment the FDA reports one.</span>
            </div>
          </div>
        ) : (
          <div className="ss-split">
            <ul className="ss-list">
              {visible.map((n) => (
                <AlertRow key={n.id} n={n} on={n.id === selectedId} onClick={() => setSelectedId(n.id)} />
              ))}
            </ul>
            {selected && <Detail key={selected.id} n={selected} />}
          </div>
        )}
      </section>
    </>
  );
}

/* ── hero: "¿estoy bien?" ─────────────────────────────────────────────── */

function Hero({
  name,
  medCount,
  affected,
  topSev,
  loading,
  onReview,
}: {
  name: string;
  medCount: number;
  affected: string[];
  topSev: Sev | null;
  loading: boolean;
  onReview: () => void;
}) {
  const tone = loading ? "clear" : !affected.length ? "clear" : topSev === "I" ? "attention" : "watch";
  const list =
    affected.length <= 2
      ? affected.map(titleCase).join(" and ")
      : `${affected.slice(0, -1).map(titleCase).join(", ")} and ${titleCase(affected.at(-1)!)}`;

  return (
    <section className={`ss-hero ${tone}`}>
      <div className="ss-hero-aside" aria-hidden="true">
        <div className="ss-ring">
          <svg viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="52" className="track" />
            <circle
              cx="60"
              cy="60"
              r="52"
              className="arc"
              style={{ opacity: medCount - affected.length > 0 ? 1 : 0 }}
              strokeDasharray={`${(2 * Math.PI * 52 * (medCount - affected.length)) / Math.max(medCount, 1)} 999`}
            />
          </svg>
          <span>
            <b>
              {loading ? "–" : medCount - affected.length}/{medCount}
            </b>
            clear
          </span>
        </div>
      </div>
      <p className="ss-greet">
        {greeting()}, {firstName(name)}.
      </p>
      {loading ? (
        <h1 className="ss-headline">Checking your medications…</h1>
      ) : affected.length === 0 ? (
        <>
          <h1 className="ss-headline">
            Your medications are <em>clear.</em>
          </h1>
          <p className="ss-sub">
            None of your {medCount} medication{medCount === 1 ? "" : "s"} appear in an active FDA recall.
            We keep checking automatically — you don’t need to do anything.
          </p>
        </>
      ) : (
        <>
          <h1 className="ss-headline">
            {affected.length === 1 ? "One" : affected.length} of your medications{" "}
            {affected.length === 1 ? "has" : "have"} an <em>active recall.</em>
          </h1>
          <p className="ss-sub">
            {list} {affected.length === 1 ? "matches" : "match"} FDA recall reports. That doesn’t mean
            your bottle is affected — checking the lot number takes about a minute.
          </p>
          <div className="ss-hero-actions">
            <button className="ss-btn primary" onClick={onReview}>
              Check my {affected.length === 1 ? titleCase(affected[0]!) : "medications"}
            </button>
            <span className="ss-hero-meta">Keep taking your medicine unless your pharmacist says otherwise.</span>
          </div>
        </>
      )}
    </section>
  );
}

/* ── medicamentos ─────────────────────────────────────────────────────── */

function Medications({
  patient,
  onUpdated,
  byDrug,
  filter,
  onFilter,
}: {
  patient: Patient;
  onUpdated: (p: Patient) => void;
  byDrug: Map<string, PatientNotification[]>;
  filter: string | null;
  onFilter: (k: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);

  const save = async (drugs: string[]) => {
    setBusy(true);
    setMsg(null);
    try {
      onUpdated(await updateDrugs(patient.id, drugs));
      return true;
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not save.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const d = input.trim();
    if (!d || busy) return;
    if (patient.drugs.some((x) => x.toLowerCase() === d.toLowerCase())) {
      setMsg(`${titleCase(d)} is already on your list.`);
      return;
    }
    if (patient.drugs.length >= MAX_DRUGS) {
      setMsg(`You can track up to ${MAX_DRUGS} medications.`);
      return;
    }
    setBusy(true);
    let note: string | null = null;
    try {
      const res = await checkDrug(d);
      if (res.recalls.length) {
        note = `${titleCase(d)} has ${res.recalls.length} active FDA recall${res.recalls.length > 1 ? "s" : ""}. Details will appear below in a moment.`;
      }
    } catch {
      note = `Couldn’t reach openFDA to pre-check ${titleCase(d)} — it’s still being monitored.`;
    }
    if (await save([...patient.drugs, d])) {
      setInput("");
      setAdding(false);
      setMsg(note);
    }
  };

  const remove = async (d: string) => {
    if (busy) return;
    if (patient.drugs.length <= 1) {
      setMsg("Keep at least one medication on your profile.");
      return;
    }
    await save(patient.drugs.filter((x) => x !== d));
  };

  return (
    <section className="ss-section">
      <div className="ss-section-head">
        <h2>Your medications</h2>
        <p>Checked against every new FDA recall, automatically.</p>
        <span className="ss-right">
          <button className="ss-linkbtn" onClick={() => setEdit((v) => !v)}>
            {edit ? "Done" : "Edit"}
          </button>
        </span>
      </div>

      <div className="ss-meds">
        {patient.drugs.map((d) => {
          const hits = byDrug.get(d.toLowerCase()) ?? [];
          const worst = hits[0] ? classOf(hits[0].classification) : null;
          const on = filter === d.toLowerCase();
          return (
            <div key={d} className={`ss-med ${worst ? `s${worst}` : "ok"} ${on ? "on" : ""}`}>
              <button
                className="ss-med-hit"
                onClick={() => hits.length && onFilter(d.toLowerCase())}
                disabled={!hits.length}
                aria-pressed={on}
              >
                <span className="ss-med-glyph" aria-hidden="true">
                  <PillGlyph />
                </span>
                <span className="ss-med-name">{titleCase(d)}</span>
                <span className="ss-med-state">
                  <i aria-hidden="true" />
                  {worst
                    ? `${hits.length} recall${hits.length > 1 ? "s" : ""} · ${SEV_WORD[worst].toLowerCase()}`
                    : "No active recalls"}
                </span>
              </button>
              {edit && (
                <button className="ss-med-x" onClick={() => void remove(d)} disabled={busy} aria-label={`Remove ${d}`}>
                  Remove
                </button>
              )}
            </div>
          );
        })}

        {adding ? (
          <form className="ss-med ss-med-add on" onSubmit={add}>
            <input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. Metformin"
              aria-label="Medication name"
              disabled={busy}
            />
            <div className="ss-med-add-row">
              <button className="ss-btn sm primary" type="submit" disabled={busy || !input.trim()}>
                {busy ? "Checking FDA…" : "Add"}
              </button>
              <button className="ss-btn sm" type="button" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          patient.drugs.length < MAX_DRUGS && (
            <button className="ss-med ss-med-new" onClick={() => setAdding(true)}>
              <span>+</span>
              Add medication
            </button>
          )
        )}
      </div>
      {msg && <p className="ss-note">{msg}</p>}
    </section>
  );
}

function PillGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <g transform="rotate(-40 12 12)">
        <rect x="4" y="8" width="16" height="8" rx="4" />
        <path d="M12 8v8" />
        <path d="M12 8h4a4 4 0 0 1 0 8h-4z" fill="currentColor" fillOpacity="0.22" />
      </g>
    </svg>
  );
}

/* ── lista de alertas ─────────────────────────────────────────────────── */

function AlertRow({ n, on, onClick }: { n: PatientNotification; on: boolean; onClick: () => void }) {
  useNow(30000);
  const k = classOf(n.classification);
  const created = toDate(n.createdAt);
  const isNew = created ? Date.now() - created.getTime() < 10 * 60 * 1000 : false;
  return (
    <li>
      <button className={`ss-row s${k} ${on ? "on" : ""}`} onClick={onClick} aria-pressed={on}>
        <span className="ss-row-bar" aria-hidden="true" />
        <span className="ss-row-main">
          <span className="ss-row-top">
            <b>{titleCase(n.drug)}</b>
            <span className={`ss-sev s${k}`}>{SEV_WORD[k]}</span>
            {n.synthetic && <span className="ss-tag">Test recall</span>}
            {isNew && <span className="ss-new">New</span>}
          </span>
          <span className="ss-row-reason">{reasonGist(n.reason) ?? n.reason}</span>
        </span>
        <span className="ss-row-time">{created ? rel(created) : ""}</span>
      </button>
    </li>
  );
}

function DesktopAlerts() {
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">(() =>
    notifSupported() ? Notification.permission : "unsupported",
  );
  if (perm === "unsupported" || perm === "denied") return null;
  if (perm === "granted") return <span className="ss-muted ss-small">Desktop alerts on</span>;
  return (
    <button className="ss-btn sm" onClick={() => void Notification.requestPermission().then(setPerm)}>
      Turn on desktop alerts
    </button>
  );
}

/* ── detalle: qué hacer ───────────────────────────────────────────────── */

function Detail({ n }: { n: PatientNotification }) {
  const [detail, setDetail] = useState<DetailState>({ status: "loading" });
  const [more, setMore] = useState(false);

  useEffect(() => {
    let alive = true;
    if (n.synthetic) {
      setDetail({ status: "none" });
      return;
    }
    void fetchRecallDetail(n.recallId).then((res) => {
      if (alive) setDetail(res ? { status: "ready", source: res.source, record: res.record } : { status: "none" });
    });
    return () => {
      alive = false;
    };
  }, [n.recallId, n.synthetic]);

  const rec = detail.status === "ready" ? detail.record : null;
  const k = classOf(n.classification || rec?.classification);
  const product = clean(n.product) ?? clean(rec?.product_description);
  const code = clean(n.lotInfo) ?? clean(rec?.code_info);
  const lots = extractLots(code ?? undefined);
  const firm = clean(n.firm) ?? clean(rec?.recalling_firm);
  const place = rec ? firmPlace(rec) : null;
  const gist = reasonGist(n.reason);
  const bulletin = plainBulletin(n.bulletin);

  return (
    <article className={`ss-detail s${k}`} aria-labelledby="ss-detail-h">
      <header className="ss-detail-head">
        <span className={`ss-sev lg s${k}`}>
          {SEV_WORD[k]} · {CLASS_META[k].name} recall
        </span>
        {n.synthetic && <span className="ss-tag">Synthetic test record</span>}
        <h3 id="ss-detail-h">{titleCase(n.drug)}</h3>
        <p className="ss-detail-gist">{gist ?? n.reason}</p>
        <p className="ss-detail-def">{CLASS_META[k].def}</p>
      </header>

      <ol className="ss-steps">
        <li>
          <b>Find your bottle or box</b>
          <span>The lot number is usually printed near the expiration date.</span>
        </li>
        <li>
          <b>Compare the lot number</b>
          {lots.length > 0 ? (
            <>
              <span>Recalled lots:</span>
              <span className="ss-lots">
                {lots.map((l) => (
                  <code key={l}>{l}</code>
                ))}
              </span>
            </>
          ) : (
            <span>
              {detail.status === "loading"
                ? "Loading the FDA record…"
                : "The FDA record doesn’t list lot numbers — ask your pharmacist to check."}
            </span>
          )}
        </li>
        <li>
          <b>If it matches, call your pharmacist</b>
          <span>Don’t stop taking it on your own — they’ll arrange a replacement.</span>
        </li>
      </ol>

      <p className="ss-caveat">
        This alert matched your medication by name. It doesn’t confirm your specific package is recalled.
      </p>

      <dl className="ss-facts">
        <div>
          <dt>Why it was recalled</dt>
          <dd>{n.reason}</dd>
        </div>
        {product && (
          <div>
            <dt>Recalled product</dt>
            <dd>{product}</dd>
          </div>
        )}
        {firm && (
          <div>
            <dt>Manufacturer</dt>
            <dd>
              {firm}
              {place ? ` · ${place}` : ""}
            </dd>
          </div>
        )}
        <div className="ss-facts-row">
          <div>
            <dt>Status</dt>
            <dd>{statusLabel(n.status || rec?.status) ?? "—"}</dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>{fmtFdaDate(n.initiationDate ?? rec?.recall_initiation_date) ?? "—"}</dd>
          </div>
          <div>
            <dt>FDA recall no.</dt>
            <dd>
              <a href={n.sourceUrl} target="_blank" rel="noreferrer" className="ss-mono">
                {n.recallId}
              </a>
            </dd>
          </div>
        </div>
      </dl>

      {code && lots.length > 0 && (
        <details className="ss-raw">
          <summary>Full lot & code text from the FDA</summary>
          <pre>{code}</pre>
        </details>
      )}

      {bulletin && (
        <div className="ss-bulletin">
          <div className="ss-bulletin-head">
            <span>Summary written for you</span>
            <button className="ss-linkbtn" onClick={() => setMore((v) => !v)}>
              {more ? "Show less" : "Read all"}
            </button>
          </div>
          <p className={more ? "" : "clamp"}>{bulletin}</p>
        </div>
      )}

      <footer className="ss-detail-foot">
        {n.delivery.map((d, i) => {
          const l = deliveryLabel(d);
          return (
            <span key={i} className={`ss-deliv ${l.tone}`} title={d.ref}>
              {l.text}
            </span>
          );
        })}
        <a href={n.sourceUrl} target="_blank" rel="noreferrer">
          View FDA source ↗
        </a>
      </footer>
    </article>
  );
}

/* ── alta de perfil (hoja modal) ──────────────────────────────────────── */

function NewProfileSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Patient) => void }) {
  const [name, setName] = useState("");
  const [meds, setMeds] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const drugs = useMemo(() => {
    const seen = new Set<string>();
    return meds
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter((s) => s && !seen.has(s.toLowerCase()) && (seen.add(s.toLowerCase()), true));
  }, [meds]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (!name.trim()) return setErr("Add a name.");
    if (!drugs.length) return setErr("Add at least one medication.");
    if (drugs.length > MAX_DRUGS) return setErr(`Up to ${MAX_DRUGS} medications.`);
    setSaving(true);
    setErr(null);
    try {
      onCreated(await createPatient(name.trim(), drugs));
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not create the profile.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ss-scrim" onClick={onClose}>
      <form className="ss-sheet" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <h2>Start watching your medications</h2>
        <p className="ss-muted">We check them against every new FDA recall — no need to come back and scan.</p>
        <label>
          <span>Your name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Maria Lopez" />
        </label>
        <label>
          <span>Medications you take</span>
          <input value={meds} onChange={(e) => setMeds(e.target.value)} placeholder="Losartan, Metformin" />
        </label>
        {drugs.length > 0 && (
          <div className="ss-chips">
            {drugs.map((d) => (
              <span key={d}>{titleCase(d)}</span>
            ))}
          </div>
        )}
        {err && <p className="ss-err">{err}</p>}
        <div className="ss-sheet-actions">
          <button className="ss-btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="ss-btn primary" type="submit" disabled={saving}>
            {saving ? "Checking FDA…" : "Start monitoring"}
          </button>
        </div>
      </form>
    </div>
  );
}
