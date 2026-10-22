import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  Alert,
  MonitorStatus,
  PatientNotification,
  PostAlert,
} from "@supershield/shared";
import { checkDrugSafety } from "./checkDrugSafety";

// SuperShield Patient: notificaciones in-app por paciente+recall.
// Se crean UNA vez por (paciente, recall_number), con o sin credenciales externas;
// la entrega externa (Slack/Gmail vía Composio) se registra con su estado real.
// Worker y server comparten estos archivos (read-merge-write, sin caché).

const NOTIFICATIONS_URL = new URL("../../../demo/seed-data/notifications.json", import.meta.url);
const STATUS_URL = new URL("../../../demo/seed-data/monitor-status.json", import.meta.url);
const MAX = 2000;

function notificationsPath(): string {
  return process.env.NOTIFICATIONS_FILE?.trim() || fileURLToPath(NOTIFICATIONS_URL);
}

function loadAll(): PatientNotification[] {
  try {
    const rows = JSON.parse(readFileSync(notificationsPath(), "utf8")) as PatientNotification[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function saveNew(fresh: PatientNotification[]): void {
  const rows = loadAll();
  const ids = new Set(rows.map((n) => n.id));
  for (const n of fresh) if (!ids.has(n.id)) rows.push(n);
  if (rows.length > MAX) rows.splice(0, rows.length - MAX);
  writeFileSync(notificationsPath(), JSON.stringify(rows, null, 2) + "\n");
}

/** Notificaciones de un paciente, más reciente primero. */
export function listNotifications(patientId: string): PatientNotification[] {
  return loadAll()
    .filter((n) => n.patientId === patientId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function notificationId(patientId: string, recallId: string): string {
  return `${patientId}:${recallId}`;
}

/* ── Estado del monitor (lo escribe el worker en cada pasada) ── */

export function writeMonitorStatus(status: MonitorStatus): void {
  try {
    writeFileSync(fileURLToPath(STATUS_URL), JSON.stringify(status, null, 2) + "\n");
  } catch {
    /* best-effort */
  }
}

export function readMonitorStatus(): (MonitorStatus & { running: boolean }) | null {
  try {
    const s = JSON.parse(readFileSync(fileURLToPath(STATUS_URL), "utf8")) as MonitorStatus;
    // "Corriendo" = la última pasada fue hace menos de 2 intervalos (+ margen).
    const age = s.lastRunAt ? Date.now() - Date.parse(s.lastRunAt) : Infinity;
    const running = s.intervalSec > 0 && age < (s.intervalSec * 2 + 30) * 1000;
    return { ...s, running };
  } catch {
    return null;
  }
}

export function dataSource(): MonitorStatus["dataSource"] {
  const v = process.env.USE_SEED;
  return v === "1" || v === "true" ? "seed" : "openfda";
}

/* ── Pipeline por paciente ── */

export interface MonitorPatient {
  id: string;
  name: string;
  drugs: string[];
}

export type EventLogger = (
  kind: "recall_detected" | "patient_matched" | "bulletin_generated" | "alert_sent",
  payload: unknown,
) => Promise<void>;

function externalChannel(): "slack" | "gmail" {
  return process.env.NOTIFY_CHANNEL === "gmail" ? "gmail" : "slack";
}

function externalConfigured(channel: "slack" | "gmail"): boolean {
  if (!process.env.COMPOSIO_API_KEY) return false;
  return channel === "gmail"
    ? !!process.env.COMPOSIO_GMAIL_TO
    : !!process.env.COMPOSIO_SLACK_CHANNEL;
}

/**
 * Revisa un paciente contra los recalls FDA y crea notificaciones solo para
 * recalls que aún no se le avisaron. Devuelve las nuevas (vacío = nada nuevo).
 */
export async function monitorPatient(
  patient: MonitorPatient,
  deps: { postAlert: PostAlert; log: EventLogger },
): Promise<PatientNotification[]> {
  if (patient.drugs.length === 0) return [];
  // Primero solo recalls (rápido, sin LLM). Claude escribe el boletín solo si hay algo nuevo.
  let report = await checkDrugSafety({ patientId: patient.id, drugs: patient.drugs, skipBulletin: true });

  const known = new Set(listNotifications(patient.id).map((n) => n.id));
  const createdAt = new Date().toISOString();
  const fresh: PatientNotification[] = [];
  for (const d of report.drugs) {
    for (const hit of d.activeRecalls) {
      const id = notificationId(patient.id, hit.recallId);
      if (known.has(id) || fresh.some((n) => n.id === id)) continue;
      fresh.push({
        ...hit,
        id,
        patientId: patient.id,
        drug: d.input,
        bulletin: report.bulletin,
        createdAt,
        matchType: "drug_name",
        delivery: [{ channel: "in-app", state: "sent" }],
      });
    }
  }
  if (fresh.length === 0) return [];

  report = await checkDrugSafety({ patientId: patient.id, drugs: patient.drugs });
  for (const n of fresh) n.bulletin = report.bulletin;

  for (const n of fresh) {
    await deps.log("recall_detected", {
      patientId: patient.id,
      drug: n.drug,
      recallId: n.recallId,
      classification: n.classification,
      reason: n.reason,
      status: n.status,
      sourceUrl: n.sourceUrl,
      synthetic: n.synthetic ?? false,
    });
  }
  await deps.log("patient_matched", {
    patientId: patient.id,
    name: patient.name,
    drugs: [...new Set(fresh.map((n) => n.drug))],
  });
  await deps.log("bulletin_generated", {
    patientId: patient.id,
    chars: report.bulletin.length,
    bulletin: report.bulletin,
  });

  // Entrega externa: estado honesto. DRY_RUN = simulado (no se entregó).
  const channel = externalChannel();
  let external: PatientNotification["delivery"][number];
  if (process.env.DRY_RUN === "true") {
    const alert = buildAlert(patient, report.bulletin, report.disclaimer, fresh, channel);
    const res = await deps.postAlert(alert);
    external = { channel, state: "simulated", ref: res.ref };
  } else if (!externalConfigured(channel)) {
    external = { channel, state: "not_configured" };
  } else {
    const alert = buildAlert(patient, report.bulletin, report.disclaimer, fresh, channel);
    const res = await deps.postAlert(alert);
    external = { channel, state: res.ok ? "sent" : "failed", ref: res.ref };
  }
  for (const n of fresh) n.delivery.push(external);

  saveNew(fresh);
  await mirrorToClickHouse(fresh);

  await deps.log("alert_sent", {
    patientId: patient.id,
    channel: external.channel,
    ok: external.state === "sent",
    state: external.state,
    ref: external.ref ?? "",
    inApp: true,
  });

  return fresh;
}

/* ── Espejo en ClickHouse (tabla default.patient_notifications) ── */

// Mismo esquema de conexión que el worker: CLICKHOUSE_URL (+ USER/PASSWORD).
// Sin URL o si falla, no rompe nada: el archivo local sigue siendo la fuente in-app.
async function mirrorToClickHouse(rows: PatientNotification[]): Promise<void> {
  const base = process.env.CLICKHOUSE_URL;
  if (!base || rows.length === 0) return;
  const url = new URL(base);
  const user = decodeURIComponent(url.username) || process.env.CLICKHOUSE_USER || "";
  const pass = decodeURIComponent(url.password) || process.env.CLICKHOUSE_PASSWORD || "";
  url.username = "";
  url.password = "";
  url.searchParams.set("query", "INSERT INTO patient_notifications FORMAT JSONEachRow");
  const body = rows
    .map((n) =>
      JSON.stringify({
        id: n.id,
        patient_id: n.patientId,
        recall_number: n.recallId,
        drug: n.drug,
        classification: n.classification,
        reason: n.reason,
        status: n.status,
        product: n.product ?? "",
        lot_info: n.lotInfo ?? "",
        firm: n.firm ?? "",
        source_url: n.sourceUrl,
        synthetic: n.synthetic ? 1 : 0,
        match_type: n.matchType,
        delivery: JSON.stringify(n.delivery),
        created_at: n.createdAt.replace("T", " ").replace("Z", ""),
      }),
    )
    .join("\n");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(user ? { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` } : {}),
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  } catch (e) {
    console.warn(`[clickhouse] patient_notifications write failed (${(e as Error).message})`);
  }
}

function buildAlert(
  patient: MonitorPatient,
  bulletin: string,
  disclaimer: string,
  fresh: PatientNotification[],
  channel: "slack" | "gmail",
): Alert {
  const lines = fresh.map(
    (n) =>
      `• ${n.drug}: FDA recall ${n.recallId} (Class ${n.classification})${n.synthetic ? " [SYNTHETIC TEST RECORD]" : ""}`,
  );
  return {
    // Solo el id del paciente sale del sistema (no el nombre).
    title: `⚠️ SuperShield: medication safety alert (${patient.id})`,
    body:
      `${lines.join("\n")}\n\n${bulletin}\n\n` +
      `This alert matched a medication by name. It does not confirm your specific package or lot is recalled. Compare the lot number on your label.\n\n${disclaimer}`,
    channel,
    provenance: fresh.map((n) => ({ url: n.sourceUrl })),
  };
}
