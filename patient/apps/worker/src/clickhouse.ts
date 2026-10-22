// Helper para loggear eventos a ClickHouse vía interfaz HTTP (sin dependencias).
// Persona B lee esta misma tabla `events` para el dashboard.
// Si CLICKHOUSE_URL no está definido o falla, hace fallback a consola (no rompe el worker).

export type EventKind =
  | "recall_detected"
  | "patient_matched"
  | "bulletin_generated"
  | "alert_sent";

function nowDateTime(): string {
  // Formato DateTime de ClickHouse: 'YYYY-MM-DD HH:MM:SS' (UTC).
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// fetch() rechaza URLs con credenciales embebidas (https://user:pass@host),
// así que las separamos a un header Basic. También acepta CLICKHOUSE_USER/PASSWORD.
function chTarget(base: string): { url: URL; headers: Record<string, string> } {
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

export async function logEvent(kind: EventKind, payload: unknown): Promise<void> {
  const row = { ts: nowDateTime(), kind, payload: JSON.stringify(payload) };
  const base = process.env.CLICKHOUSE_URL;

  if (!base) {
    console.log(`[event:${kind}]`, payload);
    return;
  }

  const { url, headers } = chTarget(base);
  url.searchParams.set("query", "INSERT INTO events FORMAT JSONEachRow");

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  } catch (e) {
    console.warn(
      `[event:${kind}] could not write to ClickHouse (${(e as Error).message}). Payload:`,
      payload,
    );
  }
}
