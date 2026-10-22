// Copies existing local state (notifications + event log) into ClickHouse once.
// Safe to re-run: patient_notifications is a ReplacingMergeTree keyed by (patient, recall).
// Usage: npm run ch:backfill
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
try {
  process.loadEnvFile(root(".env"));
} catch {
  /* env from process */
}

const base = process.env.CLICKHOUSE_URL;
if (!base) {
  console.error("CLICKHOUSE_URL not set");
  process.exit(1);
}
const auth = `Basic ${Buffer.from(`${process.env.CLICKHOUSE_USER || "default"}:${process.env.CLICKHOUSE_PASSWORD || ""}`).toString("base64")}`;

const read = (p) => {
  try {
    return JSON.parse(readFileSync(root(p), "utf8"));
  } catch {
    return [];
  }
};

async function insert(table, rows) {
  if (!rows.length) return 0;
  const url = new URL(base);
  url.searchParams.set("query", `INSERT INTO ${table} FORMAT JSONEachRow`);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: rows.map((r) => JSON.stringify(r)).join("\n"),
  });
  if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
  return rows.length;
}

const notifs = read("demo/seed-data/notifications.json").map((n) => ({
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
}));
const events = read("demo/seed-data/events-live.json");

console.log(`patient_notifications: ${await insert("patient_notifications", notifs)} rows`);
console.log(`events: ${await insert("events", events)} rows`);
