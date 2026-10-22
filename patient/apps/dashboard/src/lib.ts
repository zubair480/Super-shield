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

export type EventPayload = Record<string, unknown> & {
  drug?: string;
  recallId?: string;
  classification?: string;
  reason?: string;
  status?: string;
  sourceUrl?: string;
  patientId?: string;
  name?: string;
  drugs?: string[];
  chars?: number;
  bulletin?: string;
  channel?: string;
  ok?: boolean;
  ref?: string;
};

export const KIND: Record<string, { label: string; code: string; cls: string }> = {
  recall_detected: { label: "Recall detected on openFDA", code: "Recall", cls: "k-recall" },
  patient_matched: { label: "Patient taking a recalled drug", code: "Patient", cls: "k-patient" },
  bulletin_generated: { label: "Plain-language bulletin by Claude", code: "Bulletin", cls: "k-bulletin" },
  alert_sent: { label: "Alert delivered to the patient", code: "Alert", cls: "k-alert" },
};

// Severidad FDA explicada en palabras llanas: la fuente de verdad del "qué significa".
export const CLASS_META: Record<"I" | "II" | "III", { name: string; risk: string; def: string }> = {
  I: {
    name: "Class I",
    risk: "serious risk",
    def: "Reasonable probability of serious harm to health, or death.",
  },
  II: {
    name: "Class II",
    risk: "moderate risk",
    def: "May cause temporary or reversible harm; serious harm is unlikely.",
  },
  III: {
    name: "Class III",
    risk: "low risk",
    def: "Unlikely to cause harm; violates an FDA regulation.",
  },
};

/** "Class II" | "II" -> "II" (acepta ambas formas, payload y openFDA). */
export function classOf(c?: string): "I" | "II" | "III" {
  const s = c ?? "";
  if (/III/i.test(s)) return "III";
  if (/II/i.test(s)) return "II";
  return "I";
}

export function parse(p: string): EventPayload {
  try {
    const v = typeof p === "string" ? JSON.parse(p) : p;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as EventPayload) : {};
  } catch {
    return {};
  }
}

export function toDate(ts: string): Date {
  const s = String(ts);
  const d = new Date(s.replace(" ", "T") + (s.includes("Z") ? "" : "Z"));
  return isNaN(d.getTime()) ? new Date(ts) : d;
}

export function hms(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function rel(d: Date): string {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 0) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return d.toLocaleDateString("en-US");
}

export async function fetchEvents(): Promise<EventsResult> {
  const r = await fetch("/api/events", {
    cache: "no-store",
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error("API " + r.status);
  return (await r.json()) as EventsResult;
}

/* ── Detalle de recall (dossier openFDA) ─────────────────────────────── */

export interface RecallDetail {
  recall_number: string;
  classification?: string;
  status?: string;
  reason_for_recall?: string;
  product_description?: string;
  recalling_firm?: string;
  city?: string;
  state?: string;
  country?: string;
  voluntary_mandated?: string;
  initial_firm_notification?: string;
  distribution_pattern?: string;
  product_quantity?: string;
  recall_initiation_date?: string;
  center_classification_date?: string;
  report_date?: string;
  code_info?: string;
}

export interface RecallDetailResult {
  source: "seed" | "openfda";
  record: RecallDetail;
}

export type DetailState =
  | { status: "loading" }
  | { status: "ready"; source: "seed" | "openfda"; record: RecallDetail }
  | { status: "none" };

const detailCache = new Map<string, Promise<RecallDetailResult | null>>();

/** Pide el dossier al server (fixture local u openFDA en vivo). null = sin detalle. */
export function fetchRecallDetail(id: string): Promise<RecallDetailResult | null> {
  const hit = detailCache.get(id);
  if (hit) return hit;
  const p = fetch(`/api/recall/${encodeURIComponent(id)}`, {
    signal: AbortSignal.timeout(10000),
  })
    .then((r) => (r.ok ? (r.json() as Promise<RecallDetailResult>) : null))
    .catch(() => null)
    .then((res) => {
      // No cachear fallas: si vuelve la red, el próximo intento reintenta.
      if (!res) detailCache.delete(id);
      return res;
    });
  detailCache.set(id, p);
  return p;
}

/* ── Cable openFDA: últimos recalls publicados, registro o no ────────── */

export interface WireRecall extends RecallDetail {
  openfda?: {
    brand_name?: string[];
    generic_name?: string[];
    substance_name?: string[];
  };
}

export interface RecallWireResult {
  source: "seed" | "openfda";
  recalls: WireRecall[];
}

/** Los últimos recalls que publicó la FDA (con fixture local como respaldo). */
export async function fetchRecallWire(): Promise<RecallWireResult> {
  const r = await fetch("/api/recalls/latest?limit=1000", {
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error("API " + r.status);
  return (await r.json()) as RecallWireResult;
}

/** URL de provenance del registro (misma forma que produce el worker). */
export function recallSourceUrl(recallNumber: string): string {
  return `https://api.fda.gov/drug/enforcement.json?search=recall_number:%22${encodeURIComponent(recallNumber)}%22`;
}

/** "LOSARTAN POTASSIUM" -> "Losartan Potassium" (los nombres openFDA gritan). */
function unshout(s: string): string {
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Nombre corto del fármaco de un recall: openfda primero, descripción después. */
export function recallDrugName(r: WireRecall): string {
  const named =
    r.openfda?.generic_name?.[0] ?? r.openfda?.brand_name?.[0] ?? r.openfda?.substance_name?.[0];
  if (named) return unshout(named.trim());
  const desc = clean(r.product_description) ?? "";
  // El nombre suele venir antes de la dosis/presentación: cortamos en la coma o el "mg".
  const head = desc.split(/,|\d+\s*(?:mg|mcg|ml)\b/i)[0]?.trim() ?? "";
  const short = head.length > 44 ? `${head.slice(0, 44).trimEnd()}…` : head;
  return short ? unshout(short) : "Unidentified drug";
}

/** Limpia valores tipo "N/A" / "unknown" / vacío -> null. */
export function clean(v?: string): string | null {
  const s = (v ?? "").trim();
  if (!s || /^(n\/?a|unknown|none)\.?$/i.test(s)) return null;
  return s;
}

export function statusLabel(s?: string): string | null {
  const v = clean(s);
  if (!v) return null;
  const map: Record<string, string> = {
    ongoing: "Ongoing",
    completed: "Completed",
    terminated: "Terminated",
    pending: "Pending",
  };
  return map[v.toLowerCase()] ?? v;
}

export function statusTitle(s?: string): string | undefined {
  if ((s ?? "").toLowerCase() === "ongoing") {
    return "The recall is still active: affected product may still be in circulation.";
  }
  return undefined;
}

export function voluntaryLabel(v?: string): string | null {
  const s = clean(v);
  if (!s) return null;
  if (/mandated|ordered/i.test(s)) return "Mandated by the FDA";
  if (/voluntary/i.test(s)) return "Voluntary, initiated by the firm";
  return s;
}

export function notificationLabel(n?: string): string | null {
  const s = clean(n);
  if (!s) return null;
  if (/two or more/i.test(s)) return "notified through several channels";
  const map: Record<string, string> = {
    letter: "notified by letter",
    "press release": "notified by press release",
    "e-mail": "notified by e-mail",
    email: "notified by e-mail",
    telephone: "notified by phone",
    fax: "notified by fax",
    visit: "notified in person",
  };
  return map[s.toLowerCase()] ?? `notified by ${s}`;
}

export function countryShort(c?: string): string | null {
  const s = clean(c);
  if (!s) return null;
  const map: Record<string, string> = {
    "united states": "USA",
    "united kingdom": "UK",
  };
  return map[s.toLowerCase()] ?? s;
}

/** Ciudad/estado/país del fabricante -> "North Wales, PA (USA)". */
export function firmPlace(d: RecallDetail): string | null {
  const parts = [clean(d.city), clean(d.state)].filter(Boolean).join(", ");
  const country = countryShort(d.country);
  if (parts && country) return `${parts} (${country})`;
  return parts || country;
}

/** "20181127" -> "Nov 27, 2018" (sin sorpresas de zona horaria). */
export function fmtFdaDate(s?: string): string | null {
  const v = clean(s);
  if (!v) return null;
  if (!/^\d{8}$/.test(v)) return v;
  const d = new Date(Number(v.slice(0, 4)), Number(v.slice(4, 6)) - 1, Number(v.slice(6, 8)));
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** La cantidad de openFDA ya viene en inglés; solo se limpia "N/A"/"unknown". */
export function quantityLabel(q?: string): string | null {
  return clean(q);
}

/** Patrón de distribución en una frase corta; el texto crudo va en title=. */
export function distributionLabel(d?: string): string | null {
  const s = clean(d);
  if (!s) return null;
  if (/nationwide/i.test(s)) {
    return /puerto rico/i.test(s)
      ? "All of the U.S., including Puerto Rico"
      : "All of the U.S. (nationwide)";
  }
  if (/^[A-Z]{2}(?:\s*,\s*[A-Z]{2})*\.?$/.test(s)) {
    return `Only some U.S. states: ${s.replace(/\.$/, "")}`;
  }
  return s;
}

/**
 * El "en pocas palabras" del motivo: mapea las causas más comunes de recall
 * a una frase llana. Conservador: si no reconoce el patrón, no inventa.
 */
export function reasonGist(r?: string): string | null {
  const s = clean(r);
  if (!s) return null;
  if (/N-?nitros|NDMA|NDEA|NMBA/i.test(s)) {
    return "A nitrosamine-class impurity was detected — linked to cancer risk with prolonged exposure.";
  }
  if (/declared strength/i.test(s)) {
    return "The strength printed on the package may not be the real one; check both carton and blister.";
  }
  if (/label/i.test(s)) {
    return "Labeling error: what is printed may not match the contents.";
  }
  if (/salmonella/i.test(s)) {
    return "Salmonella contamination detected by the FDA.";
  }
  if (/microb/i.test(s)) {
    return "Possible microbial contamination of the product.";
  }
  if (/foreign (tablet|capsule|substance|material)/i.test(s)) {
    return "Foreign product or material was found inside the package.";
  }
  if (/steril/i.test(s)) {
    return "Sterility of the product cannot be assured.";
  }
  if (/subpotent|superpotent|potency/i.test(s)) {
    return "The drug's strength is out of specification.";
  }
  if (/dissolution/i.test(s)) {
    return "Tablets do not dissolve as intended, which alters the delivered dose.";
  }
  if (/stability/i.test(s)) {
    return "Failed stability testing (may not last through its shelf life).";
  }
  if (/cgmp/i.test(s)) {
    return "The FDA found deviations from good manufacturing practices.";
  }
  return null;
}

/** Extrae lotes y códigos NDC del campo libre code_info. */
export function parseCodeInfo(s?: string): { lots: string[]; ndcs: string[] } {
  const text = clean(s) ?? "";
  const ndcs = [
    ...new Set([...text.matchAll(/\b\d{4,5}-\d{3,4}(?:-\d{1,2})?\b/g)].map((m) => m[0])),
  ];
  let rest = text;
  for (const n of ndcs) rest = rest.split(n).join(" ");
  const lots = [
    ...new Set(
      [...rest.matchAll(/\b[A-Z0-9]{6,10}\b/g)]
        .map((m) => m[0])
        .filter((t) => (t.match(/\d/g)?.length ?? 0) >= 4),
    ),
  ];
  return { lots, ndcs };
}

export function channelLabel(c?: string): string {
  const map: Record<string, string> = { slack: "Slack", gmail: "Gmail" };
  return map[(c ?? "").toLowerCase()] ?? (c ?? "");
}

/**
 * Los boletines llegan con markdown de Slack (#, **, `). Para el dashboard
 * los aplanamos a texto llano; el emoji/encabezado inicial también se quita.
 */
export function plainBulletin(s?: string): string {
  return (s ?? "")
    .replace(/^[#\s\p{Extended_Pictographic}️]+/u, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/** Palabras de un boletín (preferimos contar el texto; chars/6 como aproximación). */
export function wordsOf(bulletin?: string, chars?: number): number {
  if (bulletin?.trim()) return bulletin.trim().split(/\s+/).length;
  if (chars) return Math.round(chars / 6);
  return 0;
}
