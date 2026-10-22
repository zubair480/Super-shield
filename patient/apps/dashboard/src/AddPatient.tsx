import { useEffect, useRef, useState } from "react";
import { CLASS_META, classOf, clean, reasonGist, statusLabel } from "./lib";

// Alta de pacientes con verificación FDA previa: cada medicamento se consulta
// contra openFDA antes de entrar a la lista; si tiene un recall activo, un
// modal pide confirmación explícita ("Add anyway") antes de aceptarlo.

interface DrugCheckHit {
  recallId: string;
  classification: string;
  status: string;
  reason: string;
  firm?: string;
  sourceUrl: string;
}

interface DrugCheckResult {
  drug: string;
  source: "openfda" | "seed";
  recalls: DrugCheckHit[];
}

interface DrugEntry {
  name: string;
  hits: DrugCheckHit[];
  unverified?: boolean;
}

type Note = { tone: "ok" | "warn"; text: string };

async function fetchDrugCheck(name: string): Promise<DrugCheckResult> {
  const r = await fetch(`/api/drug-check?name=${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`check failed (${r.status})`);
  return (await r.json()) as DrugCheckResult;
}

export default function AddPatient() {
  const [name, setName] = useState("");
  const [drugInput, setDrugInput] = useState("");
  const [drugs, setDrugs] = useState<DrugEntry[]>([]);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<{ name: string; hits: DrugCheckHit[] } | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  const addDrug = async () => {
    const d = drugInput.trim();
    if (!d || checking) return;
    if (drugs.some((x) => x.name.toLowerCase() === d.toLowerCase())) {
      setNote({ tone: "warn", text: `${d} is already on the list.` });
      return;
    }
    setChecking(true);
    setNote(null);
    try {
      const res = await fetchDrugCheck(d);
      if (res.recalls.length > 0) {
        // Hay recall activo: el modal decide si entra o no.
        setPending({ name: d, hits: res.recalls });
      } else {
        setDrugs((prev) => [...prev, { name: d, hits: [] }]);
        setDrugInput("");
        setNote({ tone: "ok", text: `${d} — no active FDA recalls.` });
      }
    } catch {
      setDrugs((prev) => [...prev, { name: d, hits: [], unverified: true }]);
      setDrugInput("");
      setNote({ tone: "warn", text: `FDA check unreachable — ${d} added unverified.` });
    } finally {
      setChecking(false);
    }
  };

  const confirmPending = () => {
    if (!pending) return;
    setDrugs((prev) => [...prev, { name: pending.name, hits: pending.hits }]);
    setDrugInput("");
    setNote({
      tone: "warn",
      text: `${pending.name} added — it has an active FDA recall.`,
    });
    setPending(null);
  };

  const cancelPending = () => {
    if (pending) setNote({ tone: "ok", text: `${pending.name} was not added.` });
    setPending(null);
  };

  const removeDrug = (n: string) =>
    setDrugs((prev) => prev.filter((d) => d.name !== n));

  const submit = async () => {
    if (saving || !name.trim() || drugs.length === 0) return;
    setSaving(true);
    setNote(null);
    try {
      // El POST corre el pipeline completo si hay recall (boletín + Slack):
      // puede tardar varios segundos, de ahí el timeout largo.
      const r = await fetch("/api/patients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), drugs: drugs.map((d) => d.name) }),
        signal: AbortSignal.timeout(45000),
      });
      const data = (await r.json()) as {
        patient?: { id: string; name: string };
        alert?: { alerted: boolean; ok?: boolean; ref?: string; error?: string };
        error?: string;
      };
      if (!r.ok || !data.patient) throw new Error(data.error ?? `API ${r.status}`);
      const who = `${data.patient.name} saved as ${data.patient.id}`;
      const a = data.alert;
      if (a?.alerted && a.ok) {
        const dry = a.ref?.startsWith("dry-run") ? " (dry run)" : "";
        setNote({ tone: "ok", text: `${who} — recall alert sent to Slack ✓${dry}` });
      } else if (a?.alerted) {
        setNote({
          tone: "warn",
          text: `${who}, but the Slack alert failed — the watcher will retry on its next pass.`,
        });
      } else if (a?.error) {
        setNote({
          tone: "warn",
          text: `${who}, but the recall check failed — the watcher will alert on its next pass.`,
        });
      } else {
        setNote({ tone: "ok", text: `${who} — no active recalls; the watcher keeps checking.` });
      }
      setName("");
      setDrugs([]);
      setDrugInput("");
    } catch (e) {
      setNote({ tone: "warn", text: `Could not save: ${(e as Error).message}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <h2>Add a patient</h2>
      <form
        className="addp"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Full name"
          aria-label="Patient name"
          maxLength={60}
        />
        <div className="drugrow">
          <input
            value={drugInput}
            onChange={(e) => setDrugInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addDrug();
              }
            }}
            placeholder="Medication, e.g. Losartan"
            aria-label="Medication"
            maxLength={40}
          />
          <button
            type="button"
            className="btn"
            onClick={addDrug}
            disabled={checking || !drugInput.trim()}
          >
            {checking ? "Checking…" : "Check + add"}
          </button>
        </div>

        {drugs.length > 0 && (
          <ul className="dchips">
            {drugs.map((d) => {
              const worst = d.hits[0];
              const cls = worst ? classOf(worst.classification) : null;
              return (
                <li key={d.name} className="dchip">
                  {cls && (
                    <span
                      className={`rn rn-${cls}`}
                      title={`Active recall — Class ${cls}: ${CLASS_META[cls].risk}`}
                    >
                      {cls}
                    </span>
                  )}
                  {d.name}
                  {d.unverified && <span className="faint">unverified</span>}
                  <button
                    type="button"
                    className="x"
                    aria-label={`Remove ${d.name}`}
                    onClick={() => removeDrug(d.name)}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <button
          type="submit"
          className="btn solid"
          disabled={saving || !name.trim() || drugs.length === 0}
        >
          {saving ? "Saving + alerting…" : "Add to registry"}
        </button>

        {note && <p className={`addp-note ${note.tone}`}>{note.text}</p>}
        <p className="addp-hint">
          Each medication is checked against FDA recalls before joining the registry.
        </p>
      </form>

      {pending && (
        <RecallGate
          drug={pending.name}
          hits={pending.hits}
          onCancel={cancelPending}
          onConfirm={confirmPending}
        />
      )}
    </section>
  );
}

/** El modal de advertencia: el fármaco tiene recall activo; confirmar o desistir. */
function RecallGate({
  drug,
  hits,
  onCancel,
  onConfirm,
}: {
  drug: string;
  hits: DrugCheckHit[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const worst = hits[0];
  const cls = classOf(worst.classification);
  const meta = CLASS_META[cls];
  const gist = reasonGist(worst.reason) ?? clean(worst.reason);
  const status = statusLabel(worst.status);

  return (
    <div className="veil" onClick={onCancel}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gate-title"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="gate-cap">FDA registry check</p>
        <h3 id="gate-title">{drug} is under an active FDA recall</h3>
        <p className="gate-meta">
          <span className={`cls cls-${cls}`} title={meta.def}>
            Class {cls}
          </span>
          <span className="gate-risk">{meta.risk}</span>
          {hits.length > 1 && <span className="faint">+{hits.length - 1} more active</span>}
        </p>
        <p className="gate-def">{meta.def}</p>
        {gist && <p className="gate-why">{gist}</p>}
        <p className="gate-rec">
          {worst.recallId}
          {worst.firm ? ` · ${worst.firm}` : ""}
          {status ? ` · ${status}` : ""}
          {" · "}
          <a className="lnk" href={worst.sourceUrl} target="_blank" rel="noreferrer">
            openFDA
            <span className="ext" aria-hidden="true">
              ↗
            </span>
          </a>
        </p>
        <div className="gate-btns">
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel}>
            Don&rsquo;t add
          </button>
          <button type="button" className="btn danger" onClick={onConfirm}>
            Add anyway
          </button>
        </div>
        <p className="gate-foot">
          If you add it and save the patient, the recall alert goes out immediately.
        </p>
      </div>
    </div>
  );
}
