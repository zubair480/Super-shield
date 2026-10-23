import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalDrug, normalize } from "./synonyms";

// Forma (parcial) de un registro del endpoint openFDA "drug enforcement".
export interface OpenFdaRecall {
  recall_number: string;
  classification: string; // "Class I" | "Class II" | "Class III"
  reason_for_recall: string;
  status: string; // "Ongoing" | "Completed" | "Terminated"
  product_description: string;
  recall_initiation_date?: string; // "YYYYMMDD"
  report_date?: string; // "YYYYMMDD"
  synthetic?: boolean; // solo en el feed compartido de pruebas (shared/fda)
  recalling_firm?: string;
  state?: string;
  country?: string;
  code_info?: string; // lote(s) afectados
  distribution_pattern?: string;
  openfda?: {
    brand_name?: string[];
    generic_name?: string[];
    substance_name?: string[];
  };
}

interface OpenFdaResponse {
  results?: OpenFdaRecall[];
}

const SEED_URL = new URL("../../../demo/seed-data/recalls.json", import.meta.url);

export function openFdaBase(): string {
  return (process.env.OPENFDA_BASE ?? "https://api.fda.gov").replace(/\/$/, "");
}

/** Recalls sembrados (fixture determinista para el demo, Plan B). */
export function loadSeedRecalls(): OpenFdaRecall[] {
  return JSON.parse(readFileSync(SEED_URL, "utf8")) as OpenFdaRecall[];
}

// Feed compartido de SuperShield (Pharmacy + Patient leen el mismo archivo, misma
// forma que openFDA drug/enforcement). Para el demo se inyecta ahí un recall de
// prueba marcado `synthetic: true`; en producción queda vacío y solo cuenta openFDA.
const SHARED_URL = new URL("../../../../shared/fda/demo-recalls.json", import.meta.url);

export function sharedRecallsPath(): string {
  return process.env.SHARED_RECALLS_FILE?.trim() || fileURLToPath(SHARED_URL);
}

export function loadSharedRecalls(): OpenFdaRecall[] {
  try {
    const rows = JSON.parse(readFileSync(sharedRecallsPath(), "utf8")) as OpenFdaRecall[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function matchIn(rows: OpenFdaRecall[], drug: string): OpenFdaRecall[] {
  const q = normalize(canonicalDrug(drug));
  const hit = (s?: string) => !!s && normalize(s).includes(q);
  return rows.filter(
    (r) =>
      hit(r.product_description) ||
      r.openfda?.generic_name?.some(hit) ||
      r.openfda?.brand_name?.some(hit) ||
      r.openfda?.substance_name?.some(hit),
  );
}

/** Recalls del feed compartido que coinciden con el fármaco. */
export function matchShared(drug: string): OpenFdaRecall[] {
  return matchIn(loadSharedRecalls(), drug);
}

/** Filtra el fixture por nombre de fármaco (normalizado: sin acentos, ES->EN). */
export function matchSeed(drug: string): OpenFdaRecall[] {
  return matchIn(loadSeedRecalls(), drug);
}

/** Consulta en vivo el endpoint drug enforcement de openFDA para un fármaco. */
// Caché por fármaco: 32 perfiles repiten los mismos fármacos y openFDA sin key
// permite ~1,000 llamadas/día. El feed compartido se lee aparte en cada pasada,
// así que un recall inyectado sigue llegando de inmediato.
const CACHE_MS = Math.max(0, Number(process.env.OPENFDA_CACHE_SEC ?? 300)) * 1000;
const recallCache = new Map<string, { at: number; rows: OpenFdaRecall[] }>();

/** Último error de openFDA (p. ej. 429), para que el estado no mienta "live". */
export let lastOpenFdaError: { at: string; message: string } | null = null;

export async function fetchRecalls(drug: string, limit = 10): Promise<OpenFdaRecall[]> {
  const ck = `${canonicalDrug(drug).toLowerCase()}|${limit}`;
  const hit = recallCache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  try {
    const rows = await fetchRecallsLive(drug, limit);
    recallCache.set(ck, { at: Date.now(), rows });
    lastOpenFdaError = null;
    return rows;
  } catch (e) {
    lastOpenFdaError = { at: new Date().toISOString(), message: (e as Error).message.slice(0, 120) };
    // Mejor el último dato real que el fixture, si lo tenemos.
    if (hit) return hit.rows;
    throw e;
  }
}

async function fetchRecallsLive(drug: string, limit: number): Promise<OpenFdaRecall[]> {
  const v = encodeURIComponent(canonicalDrug(drug).toLowerCase());
  const search =
    `(openfda.generic_name:"${v}"+OR+openfda.brand_name:"${v}"` +
    `+OR+openfda.substance_name:"${v}"+OR+product_description:"${v}")`;
  // API key opcional: sin ella openFDA permite uso básico; con ella sube el rate limit.
  const key = process.env.OPENFDA_API_KEY;
  const auth = key ? `&api_key=${encodeURIComponent(key)}` : "";
  const url = `${openFdaBase()}/drug/enforcement.json?search=${search}&sort=report_date:desc&limit=${limit}${auth}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  // openFDA devuelve 404 cuando no hay coincidencias.
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`openFDA ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as OpenFdaResponse;
  return data.results ?? [];
}

/** URL de provenance estable para un recall concreto. */
export function recallSourceUrl(recallNumber: string): string {
  return `${openFdaBase()}/drug/enforcement.json?search=recall_number:%22${encodeURIComponent(recallNumber)}%22`;
}
