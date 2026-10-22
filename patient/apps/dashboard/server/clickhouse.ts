import { readFileSync } from "node:fs";

export interface EventRow {
  ts: string;
  kind: string;
  payload: string;
}

export interface EventsResult {
  source: "clickhouse" | "local" | "backup";
  events: EventRow[];
  error?: string;
}

// Espejo local que escribe el worker (datos reales, sin depender de ClickHouse).
const LIVE_URL = new URL(
  "../../../demo/seed-data/events-live.json",
  import.meta.url,
);
// Respaldo estático (Plan B) por si no hay ni ClickHouse ni espejo local.
const BACKUP_URL = new URL(
  "../../../demo/seed-data/events-backup.json",
  import.meta.url,
);

function readJson(url: URL): EventRow[] {
  try {
    return JSON.parse(readFileSync(url, "utf8")) as EventRow[];
  } catch {
    return [];
  }
}

function fallback(error?: string): EventsResult {
  const live = readJson(LIVE_URL);
  if (live.length) return { source: "local", events: live, error };
  return { source: "backup", events: readJson(BACKUP_URL), error };
}

// fetch() rechaza URLs con credenciales embebidas (https://user:pass@host),
// así que las separamos a un header Basic. También acepta CLICKHOUSE_USER/PASSWORD.
export function chTarget(base: string): { url: URL; headers: Record<string, string> } {
  const url = new URL(base);
  const user = decodeURIComponent(url.username) || process.env.CLICKHOUSE_USER || "";
  const pass = decodeURIComponent(url.password) || process.env.CLICKHOUSE_PASSWORD || "";
  url.username = "";
  url.password = "";
  const headers: Record<string, string> = {};
  if (user) {
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  }
  return { url, headers };
}

/** Lee los eventos de ClickHouse vía HTTP; cae a espejo local o respaldo si falla. */
export async function fetchEvents(limit = 200): Promise<EventsResult> {
  const base = process.env.CLICKHOUSE_URL;
  if (!base) {
    return fallback("CLICKHOUSE_URL no configurado");
  }

  const sql = `SELECT ts, kind, payload FROM events ORDER BY ts DESC LIMIT ${limit} FORMAT JSON`;
  const { url, headers } = chTarget(base);
  url.searchParams.set("query", sql);

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { data?: EventRow[] };
    return { source: "clickhouse", events: data.data ?? [] };
  } catch (e) {
    return fallback((e as Error).message);
  }
}
