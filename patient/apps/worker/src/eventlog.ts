import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { logEvent, type EventKind } from "./clickhouse";

// Espejo local de eventos: permite que el dashboard se vea "vivo" con datos reales
// SIN depender de ClickHouse (que aún no entrega Person B). Es un log rotativo.
//
// Sin buffer en memoria: el server del dashboard también escribe este archivo
// (alertas inmediatas), así que cada evento se registra con read-merge-write
// para no clobberear lo que escribió el otro proceso.
const LIVE_PATH = fileURLToPath(
  new URL("../../../demo/seed-data/events-live.json", import.meta.url),
);
const MAX = 500;

interface Row {
  ts: string;
  kind: string;
  payload: string;
}

function load(): Row[] {
  try {
    return JSON.parse(readFileSync(LIVE_PATH, "utf8")) as Row[];
  } catch {
    return [];
  }
}

function nowDateTime(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/** Registra un evento en ClickHouse (si está configurado) y en el espejo local. */
export async function recordEvent(kind: EventKind, payload: unknown): Promise<void> {
  await logEvent(kind, payload);

  const rows = load();
  rows.push({ ts: nowDateTime(), kind, payload: JSON.stringify(payload) });
  if (rows.length > MAX) rows.splice(0, rows.length - MAX);
  try {
    writeFileSync(LIVE_PATH, JSON.stringify(rows, null, 2));
  } catch {
    /* si no se puede escribir el espejo, no es fatal */
  }
}
