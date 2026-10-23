import { readMonitorStatus, loadSharedRecalls } from "@farmavigia/sources";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chTarget } from "./clickhouse";

// Estado real de cada pieza del sistema, para la diapositiva "Under the hood".
// Cada check hace una llamada de verdad (o lee el latido real) con timeout corto.

export type HealthState = "ok" | "warn" | "down";

export interface HealthCheck {
  id: string;
  name: string;
  role: string;
  side: "shared" | "patient" | "pharmacy";
  state: HealthState;
  detail: string;
  ms?: number;
}

export interface HealthReport {
  checkedAt: string;
  checks: HealthCheck[];
}

const NOTIFS_URL = new URL("../../../demo/seed-data/notifications.json", import.meta.url);

async function timed<T>(fn: () => Promise<T>): Promise<{ v: T; ms: number }> {
  const t = performance.now();
  const v = await fn();
  return { v, ms: Math.round(performance.now() - t) };
}

function ago(iso?: string): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

async function openFda(): Promise<HealthCheck> {
  const base: Omit<HealthCheck, "state" | "detail"> = {
    id: "openfda",
    name: "openFDA drug enforcement API",
    role: "Source of every recall (public, no key)",
    side: "shared",
  };
  try {
    const { v, ms } = await timed(async () => {
      const r = await fetch("https://api.fda.gov/drug/enforcement.json?sort=report_date:desc&limit=1", {
        signal: AbortSignal.timeout(6000),
      });
      if (r.status === 429) throw new Error("429 rate-limited · no API key (1,000 calls/day) · cached results in use");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as { meta?: { results?: { total?: number } }; results?: { report_date?: string }[] };
    });
    const d = v.results?.[0]?.report_date ?? "";
    const date = d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : "?";
    return {
      ...base,
      state: "ok",
      ms,
      detail: `${(v.meta?.results?.total ?? 0).toLocaleString("en-US")} reports · newest ${date}`,
    };
  } catch (e) {
    const m = (e as Error).message;
    return { ...base, state: m.startsWith("429") ? "warn" : "down", detail: m };
  }
}

function worker(): HealthCheck {
  const s = readMonitorStatus();
  const base = {
    id: "worker",
    name: "Patient monitor worker",
    role: "Re-checks every saved medication, no Scan button",
    side: "patient" as const,
  };
  if (!s) return { ...base, state: "down", detail: "no heartbeat yet" };
  return {
    ...base,
    state: s.running ? (s.lastError ? "warn" : "ok") : "down",
    detail: s.running
      ? `every ${s.intervalSec}s · ${s.patientsChecked} profiles · last ${ago(s.lastRunAt)} · ${s.dataSource === "openfda" ? "live openFDA" : "fixture"}`
      : `stopped · last run ${ago(s.lastRunAt)}`,
  };
}

async function clickhouse(): Promise<HealthCheck> {
  const base = {
    id: "clickhouse",
    name: "ClickHouse Cloud",
    role: "One store: alerts, events, pharmacy match tables",
    side: "shared" as const,
  };
  const url0 = process.env.CLICKHOUSE_URL;
  if (!url0) return { ...base, state: "down", detail: "CLICKHOUSE_URL not set" };
  try {
    const { url, headers } = chTarget(url0);
    url.searchParams.set(
      "query",
      "SELECT (SELECT count() FROM default.patient_notifications) AS a, (SELECT count() FROM default.events) AS e, (SELECT count() FROM system.tables WHERE database IN ('default','safetynet')) AS t FORMAT JSONEachRow",
    );
    const { v, ms } = await timed(async () => {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return JSON.parse(await r.text()) as { a: string; e: string; t: string };
    });
    return {
      ...base,
      state: "ok",
      ms,
      detail: `${Number(v.a).toLocaleString("en-US")} patient alerts · ${Number(v.e).toLocaleString("en-US")} events · ${v.t} tables`,
    };
  } catch (e) {
    return { ...base, state: "down", detail: (e as Error).message };
  }
}

async function claude(): Promise<HealthCheck> {
  const base = {
    id: "claude",
    name: "Claude (Anthropic API)",
    role: "Plain-language bulletin per alert (patient id only)",
    side: "patient" as const,
  };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ...base, state: "warn", detail: "no key · template fallback" };
  try {
    const { ms } = await timed(async () => {
      const r = await fetch("https://api.anthropic.com/v1/models?limit=1", {
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          ...(process.env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } : {}),
        },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    });
    return {
      ...base,
      state: "ok",
      ms,
      detail: `key verified · ${process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5"}`,
    };
  } catch (e) {
    return { ...base, state: "down", detail: `${(e as Error).message} · template fallback` };
  }
}

function composio(): HealthCheck {
  const base = {
    id: "composio",
    name: "Composio → Slack / Gmail",
    role: "Optional external delivery for patient alerts",
    side: "patient" as const,
  };
  const key = !!process.env.COMPOSIO_API_KEY;
  const gmail = process.env.NOTIFY_CHANNEL === "gmail";
  const target = gmail ? process.env.COMPOSIO_GMAIL_TO : process.env.COMPOSIO_SLACK_CHANNEL;
  if (process.env.DRY_RUN === "true") return { ...base, state: "warn", detail: "dry-run · labeled Simulated" };
  if (key && target) return { ...base, state: "ok", detail: `${gmail ? "Gmail" : "Slack"} configured` };
  return {
    ...base,
    state: "warn",
    detail: key ? `key set · no ${gmail ? "Gmail recipient" : "Slack channel"} · labeled Not configured` : "not configured · in-app only",
  };
}

function inApp(): HealthCheck {
  const base = {
    id: "inapp",
    name: "In-app patient alerts",
    role: "One alert per patient × recall_number",
    side: "patient" as const,
  };
  try {
    const rows = JSON.parse(readFileSync(fileURLToPath(NOTIFS_URL), "utf8")) as { createdAt: string }[];
    const newest = rows.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), "");
    return { ...base, state: "ok", detail: `${rows.length.toLocaleString("en-US")} delivered · newest ${ago(newest)}` };
  } catch {
    return { ...base, state: "ok", detail: "none yet" };
  }
}

function sharedFeed(): HealthCheck {
  const rows = loadSharedRecalls();
  const synth = rows.filter((r) => r.synthetic).length;
  return {
    id: "feed",
    name: "Shared demo recall feed",
    role: "Same openFDA-shaped record reaches both sides",
    side: "shared",
    state: "ok",
    detail: rows.length ? `${rows.length} record(s) · ${synth} labeled synthetic` : "empty (production mode)",
  };
}

async function pharmacy(): Promise<HealthCheck> {
  const base = {
    id: "pharmacy",
    name: "Pharmacy API (HawkSign · FastAPI)",
    role: "NDC match, US map, Telegram pharmacist push",
    side: "pharmacy" as const,
  };
  const url = (process.env.PHARMACY_URL || "http://localhost:8000").replace(/\/$/, "");
  try {
    const { v, ms } = await timed(async () => {
      const r = await fetch(`${url}/api/monitor/status`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as Record<string, unknown>;
    });
    const bits = Object.entries(v)
      .filter(([, x]) => typeof x === "number" || typeof x === "boolean" || (typeof x === "string" && x.length < 40))
      .slice(0, 3)
      .map(([k, x]) => `${k}: ${x}`)
      .join(" · ");
    return { ...base, state: "ok", ms, detail: bits || "responding" };
  } catch {
    return { ...base, state: "down", detail: `not reachable at ${url}` };
  }
}

export async function systemHealth(): Promise<HealthReport> {
  const checks = await Promise.all([
    openFda(),
    sharedFeed(),
    clickhouse(),
    Promise.resolve(worker()),
    claude(),
    Promise.resolve(inApp()),
    Promise.resolve(composio()),
    pharmacy(),
  ]);
  return { checkedAt: new Date().toISOString(), checks };
}
