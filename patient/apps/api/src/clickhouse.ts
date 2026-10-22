import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { EventKind } from '@farmavigia/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/api/src -> raíz del repo
const SCHEMA_PATH = resolve(__dirname, '../../../analytics/schema.sql');

let _client: ClickHouseClient | null = null;
let _ready = false;

export interface EventRow {
  ts: string;
  kind: string;
  payload: string;
}

// Respaldo en memoria: si ClickHouse no responde, el dashboard sigue mostrando
// los últimos eventos de esta sesión (Plan B del TEAMPLAN).
const fallbackBuffer: EventRow[] = [];
const FALLBACK_MAX = 200;

export function clickhouseEnabled(): boolean {
  return Boolean(process.env.CLICKHOUSE_URL);
}

function getClient(): ClickHouseClient {
  if (!_client) {
    const url = process.env.CLICKHOUSE_URL!;
    _client = createClient({
      url,
      username: process.env.CLICKHOUSE_USER || undefined,
      password: process.env.CLICKHOUSE_PASSWORD || undefined,
      database: process.env.CLICKHOUSE_DATABASE || undefined,
    });
  }
  return _client;
}

// Corre schema.sql al arrancar (idempotente: CREATE TABLE IF NOT EXISTS).
export async function initSchema(): Promise<void> {
  if (!clickhouseEnabled()) {
    console.warn('[clickhouse] CLICKHOUSE_URL vacío — usando respaldo en memoria.');
    return;
  }
  const raw = readFileSync(SCHEMA_PATH, 'utf8');
  // Quita líneas de comentario antes de partir por ';' (si no, un bloque que
  // empieza con '--' se filtraría entero y el CREATE no se ejecutaría).
  const sql = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await getClient().command({ query: stmt });
  }
  _ready = true;
  console.log('[clickhouse] schema listo.');
}

export async function writeEvent(kind: EventKind, payload: unknown): Promise<void> {
  const row: EventRow = {
    ts: new Date().toISOString().slice(0, 19).replace('T', ' '),
    kind,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
  // Siempre guarda en respaldo para que el dashboard nunca quede vacío.
  fallbackBuffer.unshift(row);
  if (fallbackBuffer.length > FALLBACK_MAX) fallbackBuffer.pop();

  if (!clickhouseEnabled()) return;
  try {
    await getClient().insert({
      table: 'events',
      values: [{ kind: row.kind, payload: row.payload }],
      format: 'JSONEachRow',
    });
  } catch (err) {
    console.error('[clickhouse] insert falló, queda en respaldo:', err);
  }
}

export async function queryEvents(limit = 50): Promise<EventRow[]> {
  if (!clickhouseEnabled() || !_ready) {
    return fallbackBuffer.slice(0, limit);
  }
  try {
    const rs = await getClient().query({
      query:
        'SELECT toString(ts) AS ts, kind, payload FROM events ORDER BY ts DESC LIMIT {limit:UInt32}',
      query_params: { limit },
      format: 'JSONEachRow',
    });
    return (await rs.json()) as EventRow[];
  } catch (err) {
    console.error('[clickhouse] query falló, usando respaldo:', err);
    return fallbackBuffer.slice(0, limit);
  }
}
