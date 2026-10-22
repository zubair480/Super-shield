// Cliente tipado de la API de SuperShield Patient (contrato del server).

export interface Patient {
  id: string;
  name: string;
  drugs: string[];
}

export interface DrugCheckHit {
  recallId: string;
  classification: string;
  status: string;
  reason: string;
  firm?: string;
  initiationDate?: string;
  sourceUrl: string;
}

export interface DrugCheckResult {
  drug: string;
  source: "openfda" | "seed";
  recalls: DrugCheckHit[];
}

export type DeliveryChannel = "in-app" | "slack" | "gmail";
export type DeliveryState = "sent" | "simulated" | "failed" | "not_configured";

export interface Delivery {
  channel: DeliveryChannel;
  state: DeliveryState;
  ref?: string;
}

export interface PatientNotification {
  id: string;
  patientId: string;
  recallId: string;
  drug: string;
  classification: "I" | "II" | "III";
  reason: string;
  status: string;
  product?: string;
  lotInfo?: string;
  firm?: string;
  state?: string;
  country?: string;
  reportDate?: string;
  initiationDate?: string;
  sourceUrl: string;
  bulletin: string;
  createdAt: string;
  matchType: "drug_name";
  synthetic?: boolean;
  delivery: Delivery[];
}

export interface MonitorStatus {
  running: boolean;
  intervalSec: number;
  lastRunAt?: string;
  nextRunAt?: string;
  dataSource: "openfda" | "seed";
  patientsChecked: number;
  lastError?: string;
}

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `API ${r.status}`;
    try {
      const body = (await r.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      /* cuerpo no-JSON */
    }
    throw new Error(msg);
  }
  return (await r.json()) as T;
}

export async function fetchPatients(): Promise<Patient[]> {
  const r = await fetch("/api/patients", { cache: "no-store", signal: AbortSignal.timeout(8000) });
  return json<Patient[]>(r);
}

export async function createPatient(name: string, drugs: string[]): Promise<Patient> {
  const r = await fetch("/api/patients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, drugs }),
    signal: AbortSignal.timeout(15000),
  });
  const res = await json<{ patient: Patient; alert?: unknown }>(r);
  return res.patient;
}

export async function updateDrugs(id: string, drugs: string[]): Promise<Patient> {
  const r = await fetch(`/api/patients/${encodeURIComponent(id)}/drugs`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ drugs }),
    signal: AbortSignal.timeout(15000),
  });
  return json<Patient>(r);
}

export async function checkDrug(name: string): Promise<DrugCheckResult> {
  const r = await fetch(`/api/drug-check?name=${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(12000),
  });
  return json<DrugCheckResult>(r);
}

export async function fetchNotifications(id: string): Promise<PatientNotification[]> {
  const r = await fetch(`/api/patients/${encodeURIComponent(id)}/notifications`, {
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  const res = await json<{ notifications: PatientNotification[] }>(r);
  return Array.isArray(res.notifications) ? res.notifications : [];
}

export async function fetchMonitorStatus(): Promise<MonitorStatus> {
  const r = await fetch("/api/monitor/status", {
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  return json<MonitorStatus>(r);
}

/** Etiquetas honestas de entrega: nunca decir "enviado" si fue simulado. */
export function deliveryLabel(d: Delivery): { text: string; tone: "ok" | "warn" | "bad" | "muted" } {
  if (d.channel === "in-app") return { text: "In-app", tone: "ok" };
  const ch = d.channel === "slack" ? "Slack" : "Gmail";
  switch (d.state) {
    case "sent":
      return { text: `Sent via ${ch}`, tone: "ok" };
    case "simulated":
      return { text: `${ch}: Simulated (dry-run, not delivered)`, tone: "warn" };
    case "failed":
      return { text: `${ch}: Delivery failed`, tone: "bad" };
    case "not_configured":
    default:
      return { text: `${ch}: Not configured`, tone: "muted" };
  }
}
