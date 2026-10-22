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
  statusTitle,
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
  type DrugCheckHit,
  type MonitorStatus,
  type Patient,
  type PatientNotification,
} from "./patientApi";

// Pantalla del paciente: perfil, medicamentos, estado del monitor automático,
// alertas de seguridad y detalle del recall. Todo con datos reales del server.

const POLL_MS = 5000;
const LS_KEY = "supershield.patient";
const MAX_DRUGS = 8;

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
    /* almacenamiento bloqueado: la URL basta */
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

function isoDate(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function fmtDateTime(s?: string): string {
  const d = isoDate(s);
  if (!d) return "";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function notifSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/* ── Raíz ─────────────────────────────────────────────────────────────── */

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
      return list;
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load profiles");
      return null;
    }
  }, []);

  useEffect(() => {
    void loadPatients();
  }, [loadPatients]);

  // Si el id guardado ya no existe, caer al primero disponible.
  useEffect(() => {
    if (!patients) return;
    if (patientId && patients.some((p) => p.id === patientId)) return;
    const next = patients[0]?.id ?? null;
    setPatientId(next);
  }, [patients, patientId]);

  useEffect(() => {
    if (patients) persistId(patientId);
  }, [patientId, patients]);

  const patient = patients?.find((p) => p.id === patientId) ?? null;

  const onPatientUpdated = (p: Patient) => {
    setPatients((list) => (list ? list.map((x) => (x.id === p.id ? p : x)) : [p]));
  };

  const onCreated = async (p: Patient) => {
    setShowNew(false);
    setPatients((list) => [...(list ?? []).filter((x) => x.id !== p.id), p]);
    setPatientId(p.id);
    void loadPatients();
  };

  return (
    <div className="pt-wrap">
      <header className="pt-head">
        <div className="pt-brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <h1>
              SuperShield <span className="pt-dot-sep">·</span> Patient
            </h1>
            <p>Automatic FDA recall monitoring for the medications you take.</p>
          </div>
        </div>
        <div className="pt-head-actions">
          {patients && patients.length > 0 && (
            <label className="pt-select">
              <span className="pt-cap">Profile</span>
              <select
                value={patientId ?? ""}
                onChange={(e) => setPatientId(e.target.value || null)}
                aria-label="Select patient profile"
              >
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className={`pt-btn ${showNew ? "" : "pt-btn-primary"}`}
            onClick={() => setShowNew((v) => !v)}
            aria-expanded={showNew}
          >
            {showNew ? "Cancel" : "New profile"}
          </button>
          <a className="pt-link" href="/events">
            Ops event log →
          </a>
        </div>
      </header>

      {showNew && <NewProfileForm onCreated={onCreated} />}

      {loadError && !patients && (
        <div className="pt-error" role="alert">
          Could not reach the SuperShield server ({loadError}).{" "}
          <button className="pt-btn pt-btn-sm" onClick={() => void loadPatients()}>
            Retry
          </button>
        </div>
      )}

      {!patients && !loadError && <p className="pt-muted pt-pad">Loading profiles…</p>}

      {patients && patients.length === 0 && !showNew && (
        <div className="pt-empty pt-empty-hero">
          <h2>No profile yet</h2>
          <p>
            Create a profile with the medications you take. SuperShield then checks the FDA
            enforcement reports automatically and alerts you if one of them is recalled.
          </p>
          <button className="pt-btn pt-btn-primary" onClick={() => setShowNew(true)}>
            Create your profile
          </button>
        </div>
      )}

      {patient && <PatientDashboard key={patient.id} patient={patient} onUpdated={onPatientUpdated} />}
    </div>
  );
}

/* ── Alta de perfil ───────────────────────────────────────────────────── */

function NewProfileForm({ onCreated }: { onCreated: (p: Patient) => void }) {
  const [name, setName] = useState("");
  const [meds, setMeds] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const drugs = useMemo(() => {
    const seen = new Set<string>();
    return meds
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter((s) => {
        const k = s.toLowerCase();
        if (!s || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  }, [meds]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (!name.trim()) return setErr("Enter a name.");
    if (drugs.length === 0) return setErr("Enter at least one medication.");
    if (drugs.length > MAX_DRUGS) return setErr(`At most ${MAX_DRUGS} medications.`);
    setSaving(true);
    setErr(null);
    try {
      const p = await createPatient(name.trim(), drugs);
      onCreated(p);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not create the profile.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="pt-card pt-new" onSubmit={submit}>
      <h2 className="pt-h2">New profile</h2>
      <div className="pt-new-grid">
        <label className="pt-field">
          <span className="pt-cap">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Maria Lopez" />
        </label>
        <label className="pt-field">
          <span className="pt-cap">Medications (comma-separated, up to {MAX_DRUGS})</span>
          <input
            value={meds}
            onChange={(e) => setMeds(e.target.value)}
            placeholder="e.g. losartan, metformin"
          />
        </label>
      </div>
      {err && <p className="pt-inline-err">{err}</p>}
      <div className="pt-row">
        <button className="pt-btn pt-btn-primary" type="submit" disabled={saving}>
          {saving ? "Creating…" : "Create profile"}
        </button>
        <span className="pt-muted">Monitoring starts automatically once the profile is saved.</span>
      </div>
    </form>
  );
}

/* ── Panel del paciente ───────────────────────────────────────────────── */

function PatientDashboard({ patient, onUpdated }: { patient: Patient; onUpdated: (p: Patient) => void }) {
  const [notifs, setNotifs] = useState<PatientNotification[] | null>(null);
  const [notifErr, setNotifErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<PatientNotification[]>([]);
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
          // Primera carga: línea base, sin avisos.
          seen.current = new Set(list.map((n) => n.id));
        } else {
          const fresh = list.filter((n) => !seen.current!.has(n.id));
          if (fresh.length) {
            fresh.forEach((n) => seen.current!.add(n.id));
            setToast((t) => [...fresh, ...t].slice(0, 3));
            setSelectedId((cur) => cur ?? fresh[0].id);
            if (notifSupported() && Notification.permission === "granted") {
              for (const n of fresh) {
                try {
                  new Notification(`Recall alert: ${n.drug}`, {
                    body: `${CLASS_META[classOf(n.classification)].name} (${
                      CLASS_META[classOf(n.classification)].risk
                    }) — ${n.reason}`.slice(0, 220),
                    tag: n.id,
                  });
                } catch {
                  /* algunos navegadores exigen service worker */
                }
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

  // Seleccionar la más reciente por defecto.
  useEffect(() => {
    if (!notifs?.length) return;
    if (!selectedId || !notifs.some((n) => n.id === selectedId)) setSelectedId(notifs[0].id);
  }, [notifs, selectedId]);

  const selected = notifs?.find((n) => n.id === selectedId) ?? null;

  const openAlert = (id: string) => {
    setSelectedId(id);
    setToast([]);
    requestAnimationFrame(() =>
      document.getElementById("pt-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  return (
    <>
      {toast.length > 0 && (
        <div className="pt-toast" role="alert" aria-live="assertive">
          <div className="pt-toast-body">
            <span className="pt-cap pt-red">New safety alert</span>
            <strong>
              {toast[0].drug}: {CLASS_META[classOf(toast[0].classification)].name} recall (
              {CLASS_META[classOf(toast[0].classification)].risk})
            </strong>
            <span className="pt-toast-reason">{toast[0].reason}</span>
            {toast.length > 1 && <span className="pt-muted">+{toast.length - 1} more</span>}
          </div>
          <div className="pt-toast-actions">
            <button className="pt-btn pt-btn-primary pt-btn-sm" onClick={() => openAlert(toast[0].id)}>
              View details
            </button>
            <button className="pt-btn pt-btn-sm" onClick={() => setToast([])} aria-label="Dismiss alert banner">
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="pt-grid">
        <div className="pt-col">
          <MedicationsCard patient={patient} onUpdated={onUpdated} />
          <MonitorCard />
        </div>
        <div className="pt-col pt-col-wide">
          <AlertsCard
            notifs={notifs}
            error={notifErr}
            selectedId={selectedId}
            onSelect={openAlert}
            hasMeds={patient.drugs.length > 0}
          />
          {selected && <RecallDetailPanel n={selected} />}
        </div>
      </div>
    </>
  );
}

/* ── Medicamentos ─────────────────────────────────────────────────────── */

function MedicationsCard({ patient, onUpdated }: { patient: Patient; onUpdated: (p: Patient) => void }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<Record<string, { hits: DrugCheckHit[]; source: string }>>({});
  const [unverified, setUnverified] = useState<string | null>(null);

  const save = async (drugs: string[]) => {
    setBusy(true);
    setErr(null);
    try {
      const p = await updateDrugs(patient.id, drugs);
      onUpdated(p);
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save medications.");
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
      setErr(`${d} is already on your list.`);
      return;
    }
    if (patient.drugs.length >= MAX_DRUGS) {
      setErr(`You can track up to ${MAX_DRUGS} medications.`);
      return;
    }
    setBusy(true);
    setErr(null);
    setUnverified(null);
    // Verificación previa: avisa si ya hay recalls, pero igual se agrega.
    try {
      const res = await checkDrug(d);
      if (res.recalls.length) {
        setWarnings((w) => ({ ...w, [d.toLowerCase()]: { hits: res.recalls, source: res.source } }));
      }
    } catch {
      setUnverified(d);
    }
    const ok = await save([...patient.drugs, d]);
    if (ok) setInput("");
  };

  const remove = async (d: string) => {
    if (busy) return;
    if (patient.drugs.length <= 1) {
      setErr("A profile needs at least one medication.");
      return;
    }
    const ok = await save(patient.drugs.filter((x) => x !== d));
    if (ok) {
      setWarnings((w) => {
        const next = { ...w };
        delete next[d.toLowerCase()];
        return next;
      });
    }
  };

  return (
    <section className="pt-card" aria-labelledby="pt-meds-h">
      <div className="pt-card-head">
        <h2 className="pt-h2" id="pt-meds-h">
          My medications
        </h2>
        <span className="pt-cap pt-muted">
          {patient.drugs.length}/{MAX_DRUGS}
        </span>
      </div>
      <p className="pt-muted pt-small">
        Monitoring is automatic: every medication here is checked against FDA recall reports on a
        schedule. Changes are saved immediately.
      </p>

      {patient.drugs.length === 0 ? (
        <div className="pt-empty">No medications yet. Add the ones you take below.</div>
      ) : (
        <ul className="pt-meds">
          {patient.drugs.map((d) => {
            const w = warnings[d.toLowerCase()];
            return (
              <li key={d} className="pt-med">
                <div className="pt-med-row">
                  <span className="pt-med-name">{d}</span>
                  <button
                    className="pt-btn pt-btn-sm pt-btn-ghost"
                    onClick={() => void remove(d)}
                    disabled={busy}
                    aria-label={`Remove ${d}`}
                  >
                    Remove
                  </button>
                </div>
                {w && (
                  <div className="pt-warn">
                    <strong>
                      {w.hits.length} FDA recall{w.hits.length > 1 ? "s" : ""} found for “{d}”
                      {w.source === "seed" ? " (demo fixture)" : ""}.
                    </strong>{" "}
                    It was still added; you'll get an alert with details.
                    <ul>
                      {w.hits.slice(0, 3).map((h) => (
                        <li key={h.recallId}>
                          <span className={`pt-class c${classOf(h.classification)}`}>
                            {CLASS_META[classOf(h.classification)].name}
                          </span>{" "}
                          <a href={h.sourceUrl} target="_blank" rel="noreferrer" className="pt-mono">
                            {h.recallId}
                          </a>{" "}
                          — {h.reason.length > 120 ? `${h.reason.slice(0, 120)}…` : h.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form className="pt-add" onSubmit={add}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Add a medication (e.g. valsartan)"
          aria-label="Medication name"
          disabled={busy}
        />
        <button className="pt-btn pt-btn-primary" type="submit" disabled={busy || !input.trim()}>
          {busy ? "Saving…" : "Add"}
        </button>
      </form>
      {unverified && (
        <p className="pt-muted pt-small">
          Could not check “{unverified}” against openFDA right now; it will still be monitored.
        </p>
      )}
      {err && <p className="pt-inline-err">{err}</p>}
    </section>
  );
}

/* ── Estado del monitor ───────────────────────────────────────────────── */

function MonitorCard() {
  const [st, setSt] = useState<MonitorStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const now = useNow(1000);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await fetchMonitorStatus();
        if (alive) {
          setSt(s);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "unreachable");
      }
    };
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const last = isoDate(st?.lastRunAt);
  const next = isoDate(st?.nextRunAt);
  const secsToNext = next ? Math.max(0, Math.round((next.getTime() - now) / 1000)) : null;
  const live = !!st?.running && !err;

  return (
    <section className="pt-card" aria-labelledby="pt-mon-h">
      <div className="pt-card-head">
        <h2 className="pt-h2" id="pt-mon-h">
          Monitoring status
        </h2>
        <span className={`pt-live ${live ? "on" : "off"}`}>
          <span className="pt-live-dot" aria-hidden="true" />
          {err ? "Unreachable" : st ? (st.running ? "Live" : "Stopped") : "…"}
        </span>
      </div>
      {err && <p className="pt-inline-err">Could not reach the monitor ({err}).</p>}
      {st && (
        <>
          <p className="pt-mon-line">
            {last ? `Last checked ${rel(last)}` : "Not checked yet"} · every {st.intervalSec}s · Source:{" "}
            {st.dataSource === "openfda" ? (
              <span className="pt-src-live">live openFDA</span>
            ) : (
              <span className="pt-src-demo">demo fixture</span>
            )}
          </p>
          <dl className="pt-kv">
            <div>
              <dt>Next check</dt>
              <dd className="pt-mono">
                {!st.running ? "—" : secsToNext === null ? "scheduling…" : secsToNext === 0 ? "running now" : `in ${secsToNext}s`}
              </dd>
            </div>
            <div>
              <dt>Profiles checked</dt>
              <dd className="pt-mono">{st.patientsChecked}</dd>
            </div>
          </dl>
          {st.lastError && (
            <p className="pt-inline-err">
              Last run error: <span className="pt-mono">{st.lastError}</span>
            </p>
          )}
        </>
      )}
      {!st && !err && <p className="pt-muted">Loading…</p>}
    </section>
  );
}

/* ── Alertas ──────────────────────────────────────────────────────────── */

function DesktopAlertsButton() {
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">(() =>
    notifSupported() ? Notification.permission : "unsupported",
  );
  if (perm === "unsupported") return null;
  if (perm === "granted") return <span className="pt-cap pt-muted">Desktop alerts on</span>;
  if (perm === "denied") return <span className="pt-cap pt-muted">Desktop alerts blocked</span>;
  return (
    <button
      className="pt-btn pt-btn-sm"
      onClick={() => void Notification.requestPermission().then((p) => setPerm(p))}
    >
      Enable desktop alerts
    </button>
  );
}

function AlertsCard({
  notifs,
  error,
  selectedId,
  onSelect,
  hasMeds,
}: {
  notifs: PatientNotification[] | null;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  hasMeds: boolean;
}) {
  useNow(15000); // refresca los "hace X"
  return (
    <section className="pt-card" aria-labelledby="pt-alerts-h">
      <div className="pt-card-head">
        <h2 className="pt-h2" id="pt-alerts-h">
          Safety alerts
          {notifs && notifs.length > 0 && <span className="pt-count">{notifs.length}</span>}
        </h2>
        <DesktopAlertsButton />
      </div>
      {error && <p className="pt-inline-err">Could not refresh alerts ({error}).</p>}
      {!notifs && !error && <p className="pt-muted">Loading…</p>}
      {notifs && notifs.length === 0 && (
        <div className="pt-empty">
          {hasMeds
            ? "No recall alerts for your medications. You'll be alerted here automatically if the FDA reports one."
            : "Add a medication to start receiving recall alerts."}
        </div>
      )}
      {notifs && notifs.length > 0 && (
        <ul className="pt-alerts">
          {notifs.map((n) => {
            const k = classOf(n.classification);
            const created = isoDate(n.createdAt);
            return (
              <li key={n.id}>
                <button
                  className={`pt-alert ${n.id === selectedId ? "on" : ""}`}
                  onClick={() => onSelect(n.id)}
                  aria-pressed={n.id === selectedId}
                >
                  <div className="pt-alert-top">
                    <span className={`pt-class c${k}`}>
                      {CLASS_META[k].name} · {CLASS_META[k].risk}
                    </span>
                    {n.synthetic && <span className="pt-badge pt-badge-synth">Synthetic test recall</span>}
                    <span className="pt-alert-time pt-mono" title={fmtDateTime(n.createdAt)}>
                      {created ? rel(created) : ""}
                    </span>
                  </div>
                  <div className="pt-alert-drug">{n.drug}</div>
                  <div className="pt-alert-reason">{n.reason}</div>
                  {n.delivery?.length > 0 && (
                    <div className="pt-badges">
                      {n.delivery.map((d, i) => {
                        const l = deliveryLabel(d);
                        return (
                          <span key={`${d.channel}-${i}`} className={`pt-badge pt-badge-${l.tone}`} title={d.ref}>
                            {l.text}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ── Detalle del recall ───────────────────────────────────────────────── */

function RecallDetailPanel({ n }: { n: PatientNotification }) {
  const [detail, setDetail] = useState<DetailState>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    setDetail({ status: "loading" });
    if (n.synthetic) {
      setDetail({ status: "none" });
      return;
    }
    void fetchRecallDetail(n.recallId).then((res) => {
      if (!alive) return;
      setDetail(res ? { status: "ready", source: res.source, record: res.record } : { status: "none" });
    });
    return () => {
      alive = false;
    };
  }, [n.recallId, n.synthetic]);

  const rec = detail.status === "ready" ? detail.record : null;
  const k = classOf(n.classification || rec?.classification);
  const status = statusLabel(n.status || rec?.status);
  const firm = clean(n.firm) ?? clean(rec?.recalling_firm);
  const place = rec ? firmPlace(rec) : null;
  const product = clean(n.product) ?? clean(rec?.product_description);
  const lots = clean(n.lotInfo) ?? clean(rec?.code_info);
  const reportDate = fmtFdaDate(n.reportDate ?? rec?.report_date);
  const initDate = fmtFdaDate(n.initiationDate ?? rec?.recall_initiation_date);
  const gist = reasonGist(n.reason);
  const bulletin = plainBulletin(n.bulletin);

  return (
    <section className="pt-card pt-detail" id="pt-detail" aria-labelledby="pt-detail-h">
      <div className="pt-card-head">
        <h2 className="pt-h2" id="pt-detail-h">
          Recall details · {n.drug}
        </h2>
        {n.synthetic && <span className="pt-badge pt-badge-synth">Synthetic test recall</span>}
      </div>

      <div className="pt-src-row">
        <span className="pt-cap pt-muted">FDA recall number</span>
        <a href={n.sourceUrl} target="_blank" rel="noreferrer" className="pt-mono pt-recall-no">
          {n.recallId}
        </a>
        <span className="pt-muted pt-small">
          Source:{" "}
          <a href={n.sourceUrl} target="_blank" rel="noreferrer">
            FDA openFDA enforcement report
          </a>
          {detail.status === "ready" && detail.source === "seed" ? " (demo fixture copy)" : ""}
        </span>
      </div>

      <div className={`pt-classbox c${k}`}>
        <div>
          <span className={`pt-class c${k}`}>{CLASS_META[k].name}</span>{" "}
          <strong>{CLASS_META[k].risk}</strong>
        </div>
        <p>{CLASS_META[k].def}</p>
      </div>

      <dl className="pt-facts">
        {status && (
          <div>
            <dt>Status</dt>
            <dd title={statusTitle(n.status || rec?.status)}>{status}</dd>
          </div>
        )}
        {firm && (
          <div>
            <dt>Recalling firm</dt>
            <dd>
              {firm}
              {place ? <span className="pt-muted"> · {place}</span> : null}
            </dd>
          </div>
        )}
        {initDate && (
          <div>
            <dt>Recall initiated</dt>
            <dd>{initDate}</dd>
          </div>
        )}
        {reportDate && (
          <div>
            <dt>FDA report date</dt>
            <dd>{reportDate}</dd>
          </div>
        )}
        <div>
          <dt>Alert created</dt>
          <dd>{fmtDateTime(n.createdAt)}</dd>
        </div>
      </dl>

      <div className="pt-block">
        <h3 className="pt-cap pt-muted">Reason for recall</h3>
        <p>{n.reason}</p>
        {gist && <p className="pt-muted pt-small">In short: {gist}</p>}
      </div>

      {product && (
        <div className="pt-block">
          <h3 className="pt-cap pt-muted">Product description</h3>
          <p>{product}</p>
        </div>
      )}

      <div className="pt-block">
        <h3 className="pt-cap pt-muted">Lot / code information</h3>
        {lots ? (
          <pre className="pt-lots">{lots}</pre>
        ) : (
          <p className="pt-muted">
            {detail.status === "loading" ? "Loading FDA record…" : "No lot information published in this record."}
          </p>
        )}
      </div>

      {bulletin && (
        <div className="pt-block">
          <h3 className="pt-cap pt-muted">What this means (plain-language summary by Claude)</h3>
          <div className="pt-bulletin">{bulletin}</div>
        </div>
      )}

      <div className="pt-verify" role="note">
        <h3>Verify your package</h3>
        <p>
          This alert matched your medication by name. It does NOT confirm your specific package is
          recalled. Compare the product and lot numbers above with your bottle's label. Do not stop
          taking your medication without talking to your pharmacist or doctor.
        </p>
      </div>
    </section>
  );
}
