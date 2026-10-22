import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import { loadSharedRecalls } from "@farmavigia/sources";

// Alta de pacientes + verificación FDA previa ("Add a patient" del dashboard).
// El worker relee patients.json en cada pasada, así que lo que se agrega aquí
// entra a la vigilancia automáticamente.

export interface Patient {
  id: string;
  name: string;
  drugs: string[];
}

const REGISTRY_PATH = fileURLToPath(
  new URL("../../../demo/seed-data/patients.json", import.meta.url),
);
const SEED_RECALLS_URL = new URL("../../../demo/seed-data/recalls.json", import.meta.url);

export function loadRegistry(): Patient[] {
  try {
    const rows = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as Patient[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

const NAME_RE = /^[\p{L}][\p{L}\p{N} .,'-]{0,59}$/u;
const DRUG_RE = /^[\p{L}][\p{L}\p{N} /+.-]{0,39}$/u;

export function isValidDrugQuery(name: string): boolean {
  return DRUG_RE.test(name);
}

/** Valida el body del POST. Devuelve el paciente limpio o un mensaje de error. */
export function validateNewPatient(body: unknown): { name: string; drugs: string[] } | string {
  const b = (body ?? {}) as { name?: unknown; drugs?: unknown };
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!NAME_RE.test(name)) return "invalid patient name";
  if (!Array.isArray(b.drugs) || b.drugs.length < 1 || b.drugs.length > 8) {
    return "drugs must be a list of 1-8 medication names";
  }
  const drugs: string[] = [];
  for (const raw of b.drugs) {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (!DRUG_RE.test(s)) return "invalid medication name";
    if (!drugs.some((d) => d.toLowerCase() === s.toLowerCase())) drugs.push(s);
  }
  return { name, drugs };
}

/** Valida la lista de medicamentos (PUT /api/patients/:id/drugs). */
export function validateDrugs(body: unknown): string[] | string {
  const b = (body ?? {}) as { drugs?: unknown };
  if (!Array.isArray(b.drugs) || b.drugs.length > 8) {
    return "drugs must be a list of 0-8 medication names";
  }
  const drugs: string[] = [];
  for (const raw of b.drugs) {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (!DRUG_RE.test(s)) return "invalid medication name";
    if (!drugs.some((d) => d.toLowerCase() === s.toLowerCase())) drugs.push(s);
  }
  return drugs;
}

/** Reemplaza los medicamentos de un paciente; null si no existe. */
export function updateDrugs(id: string, drugs: string[]): Patient | null {
  const rows = loadRegistry();
  const p = rows.find((r) => r.id === id);
  if (!p) return null;
  p.drugs = drugs;
  writeFileSync(REGISTRY_PATH, JSON.stringify(rows, null, 2) + "\n");
  return p;
}

export function addPatient(name: string, drugs: string[]): Patient {
  const rows = loadRegistry();
  const next =
    rows.reduce((max, p) => Math.max(max, Number(/^PX-(\d+)$/.exec(p.id)?.[1] ?? 0)), 0) + 1;
  const patient: Patient = { id: `PX-${String(next).padStart(3, "0")}`, name, drugs };
  rows.push(patient);
  writeFileSync(REGISTRY_PATH, JSON.stringify(rows, null, 2) + "\n");
  return patient;
}

/** Lee un body JSON chico (el form de alta); rechaza payloads grandes o malformados. */
export function readJsonBody(req: IncomingMessage, maxBytes = 16_384): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/* ── Verificación FDA de un fármaco (espejo de la consulta del worker) ── */

interface EnforcementRecord {
  recall_number: string;
  classification: string;
  status: string;
  reason_for_recall: string;
  recalling_firm?: string;
  recall_initiation_date?: string;
  product_description?: string;
  openfda?: {
    brand_name?: string[];
    generic_name?: string[];
    substance_name?: string[];
  };
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
  recalls: DrugCheckHit[]; // solo activos (no Terminated), peor clase primero
}

function openFdaBase(): string {
  return (process.env.OPENFDA_BASE ?? "https://api.fda.gov").replace(/\/$/, "");
}

function severityRank(c: string): number {
  if (/III/i.test(c)) return 2;
  if (/II/i.test(c)) return 1;
  return 0;
}

function toHit(r: EnforcementRecord): DrugCheckHit {
  return {
    recallId: r.recall_number,
    classification: r.classification,
    status: r.status,
    reason: r.reason_for_recall,
    firm: r.recalling_firm,
    initiationDate: r.recall_initiation_date,
    sourceUrl: `${openFdaBase()}/drug/enforcement.json?search=recall_number:%22${encodeURIComponent(r.recall_number)}%22`,
  };
}

/** Activo = no Terminated (mismo criterio que el worker). */
function activeSorted(records: EnforcementRecord[]): DrugCheckHit[] {
  const seen = new Set<string>();
  return records
    .filter((r) => r.recall_number && (r.status ?? "").toLowerCase() !== "terminated")
    .filter((r) => (seen.has(r.recall_number) ? false : (seen.add(r.recall_number), true)))
    .map(toHit)
    .sort((a, b) => severityRank(a.classification) - severityRank(b.classification));
}

/** Feed compartido de SuperShield (shared/fda), filtrado por nombre. */
function sharedMatches(q: string): EnforcementRecord[] {
  const hit = (s?: string) => !!s && s.toLowerCase().includes(q);
  return (loadSharedRecalls() as EnforcementRecord[]).filter(
    (r) =>
      hit(r.product_description) ||
      r.openfda?.generic_name?.some(hit) ||
      r.openfda?.brand_name?.some(hit) ||
      r.openfda?.substance_name?.some(hit),
  );
}

function matchSeed(drug: string): EnforcementRecord[] {
  let rows: EnforcementRecord[];
  try {
    rows = JSON.parse(readFileSync(SEED_RECALLS_URL, "utf8")) as EnforcementRecord[];
  } catch {
    return [];
  }
  const q = drug.trim().toLowerCase();
  const hit = (s?: string) => !!s && s.toLowerCase().includes(q);
  return [...(loadSharedRecalls() as EnforcementRecord[]), ...rows].filter(
    (r) =>
      hit(r.product_description) ||
      r.openfda?.generic_name?.some(hit) ||
      r.openfda?.brand_name?.some(hit) ||
      r.openfda?.substance_name?.some(hit),
  );
}

// La consulta es interactiva (cada "Check + add"): caché corto para no
// castigar el rate limit de openFDA con teclazos repetidos.
const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: DrugCheckResult }>();

export async function checkDrug(drug: string): Promise<DrugCheckResult> {
  const key = drug.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value: DrugCheckResult;
  try {
    const v = encodeURIComponent(key);
    const search =
      `(openfda.generic_name:"${v}"+OR+openfda.brand_name:"${v}"` +
      `+OR+openfda.substance_name:"${v}"+OR+product_description:"${v}")`;
    const apiKey = process.env.OPENFDA_API_KEY;
    const auth = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : "";
    // limit=10 + sort: el mismo corte que usa el pipeline de alertas (packages/sources),
    // para que el modal nunca advierta de un recall que luego no se alertaría.
    const url = `${openFdaBase()}/drug/enforcement.json?search=${search}&sort=report_date:desc&limit=10${auth}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.status === 404) {
      // openFDA responde 404 cuando no hay coincidencias: fármaco sin recalls.
      value = { drug, source: "openfda", recalls: activeSorted(sharedMatches(key)) };
    } else if (!res.ok) {
      throw new Error(`openFDA ${res.status}`);
    } else {
      const data = (await res.json()) as { results?: EnforcementRecord[] };
      value = { drug, source: "openfda", recalls: activeSorted([...sharedMatches(key), ...(data.results ?? [])]) };
    }
  } catch {
    // Sin red: el fixture local decide (mismo Plan B que el worker).
    value = { drug, source: "seed", recalls: activeSorted(matchSeed(key)) };
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}
