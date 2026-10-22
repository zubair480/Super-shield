import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { monitorPatient } from "@supershield/sources";
import { postAlert } from "@supershield/notifier";
import { chTarget } from "./clickhouse";
import type { Patient } from "./registry";

// Alerta inmediata al guardar medicamentos: el mismo pipeline del worker
// (monitorPatient) sin esperar su pasada. Comparten estado vía los archivos
// espejo (read-merge-write), así que el worker no repite estas alertas.

const LIVE_PATH = fileURLToPath(
  new URL("../../../demo/seed-data/events-live.json", import.meta.url),
);
const MAX_ROWS = 500;

interface Row {
  ts: string;
  kind: string;
  payload: string;
}

function nowDateTime(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

async function logClickHouse(row: Row): Promise<void> {
  const base = process.env.CLICKHOUSE_URL;
  if (!base) return;
  const { url, headers } = chTarget(base);
  url.searchParams.set("query", "INSERT INTO events FORMAT JSONEachRow");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`${res.status}`);
  } catch (e) {
    console.warn(`[instant-alert] ClickHouse write failed (${(e as Error).message})`);
  }
}

async function recordEvent(kind: string, payload: unknown): Promise<void> {
  const row: Row = { ts: nowDateTime(), kind, payload: JSON.stringify(payload) };
  await logClickHouse(row);
  let rows: Row[];
  try {
    rows = JSON.parse(readFileSync(LIVE_PATH, "utf8")) as Row[];
  } catch {
    rows = [];
  }
  rows.push(row);
  if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
  try {
    writeFileSync(LIVE_PATH, JSON.stringify(rows, null, 2));
  } catch {
    /* el espejo local es best-effort */
  }
}

export interface InstantAlertResult {
  alerted: boolean;
  count?: number;
  flaggedDrugs?: string[];
  error?: string;
}

/** Corre el pipeline del worker para un paciente recién guardado. */
export async function alertNewPatient(patient: Patient): Promise<InstantAlertResult> {
  const fresh = await monitorPatient(patient, { postAlert, log: recordEvent });
  if (fresh.length === 0) return { alerted: false };
  return {
    alerted: true,
    count: fresh.length,
    flaggedDrugs: [...new Set(fresh.map((n) => n.drug))],
  };
}
