import type { RecallHit } from "@farmavigia/shared";
import { recallSourceUrl, type OpenFdaRecall } from "./openfda";

/** "Class III" -> 'III', "Class II" -> 'II', resto -> 'I'. */
export function mapClassification(c: string): RecallHit["classification"] {
  if (/III/i.test(c)) return "III";
  if (/II/i.test(c)) return "II";
  return "I";
}

/** Un recall cuenta como "activo" si no está terminado. */
export function isActive(r: OpenFdaRecall): boolean {
  return (r.status ?? "").toLowerCase() !== "terminated";
}

/** Orden de severidad: Clase I (más grave) primero. */
export function severityRank(c: RecallHit["classification"]): number {
  return c === "I" ? 0 : c === "II" ? 1 : 2;
}

/** Quita recalls duplicados por recall_number. */
export function dedupeByRecall(rs: OpenFdaRecall[]): OpenFdaRecall[] {
  const seen = new Set<string>();
  const out: OpenFdaRecall[] = [];
  for (const r of rs) {
    if (r.recall_number && !seen.has(r.recall_number)) {
      seen.add(r.recall_number);
      out.push(r);
    }
  }
  return out;
}

export function toRecallHit(r: OpenFdaRecall): RecallHit {
  return {
    recallId: r.recall_number,
    classification: mapClassification(r.classification),
    reason: r.reason_for_recall,
    status: r.status,
    sourceUrl: recallSourceUrl(r.recall_number),
    product: r.product_description,
    lotInfo: r.code_info,
    firm: r.recalling_firm,
    reportDate: r.report_date,
    initiationDate: r.recall_initiation_date,
    ...(r.synthetic ? { synthetic: true } : {}),
  };
}
