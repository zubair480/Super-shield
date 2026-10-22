import type {
  CheckDrugSafety,
  SafetyCheckRequest,
  SafetyReport,
} from "@farmavigia/shared";
import { fetchRecalls, matchSeed, matchShared, type OpenFdaRecall } from "./openfda";
import { isActive, toRecallHit, severityRank, dedupeByRecall } from "./match";
import { mapClassification } from "./match";
import { llmPromptComplete, llmComplete, anthropicComplete } from "./llm";

const DISCLAIMER =
  "Automatically generated pharmacovigilance information based on public FDA (openFDA) data. It does not replace clinical judgment or consultation with a healthcare professional.";

function useSeed(): boolean {
  const v = process.env.USE_SEED;
  return v === "1" || v === "true";
}

/** Obtiene recalls para un fármaco: seed forzado, o en vivo con fallback a seed si falla. */
// SuperShield: el feed compartido (shared/fda) se suma siempre, primero, para que
// un recall recién publicado ahí lo detecten Pharmacy y Patient por igual.
async function recallsForDrug(drug: string): Promise<OpenFdaRecall[]> {
  const shared = matchShared(drug);
  if (useSeed()) return [...shared, ...matchSeed(drug)];
  try {
    return [...shared, ...(await fetchRecalls(drug))];
  } catch {
    // openFDA caído en vivo -> no rompemos el demo, usamos el fixture.
    return [...shared, ...matchSeed(drug)];
  }
}

interface FlaggedRaw {
  input: string;
  records: OpenFdaRecall[];
}

export const checkDrugSafety: CheckDrugSafety = async (req) => {
  const sources = new Set<string>();
  const drugs: SafetyReport["drugs"] = [];
  const raw: FlaggedRaw[] = [];

  for (const input of req.drugs) {
    const records = dedupeByRecall(await recallsForDrug(input)).filter(isActive);
    const activeRecalls = records
      .map(toRecallHit)
      .sort((a, b) => severityRank(a.classification) - severityRank(b.classification));
    activeRecalls.forEach((h) => sources.add(h.sourceUrl));
    drugs.push({ input, activeRecalls });
    if (records.length) raw.push({ input, records });
  }

  const bulletin = await buildBulletin(req, drugs, raw);

  return {
    drugs,
    bulletin,
    sources: [...sources],
    generatedAt: new Date().toISOString(),
    disclaimer: DISCLAIMER,
  };
};

function fmtDate(d?: string): string {
  if (!d) return "";
  if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return d;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function oneFact(r: OpenFdaRecall): string {
  const cls = mapClassification(r.classification);
  const date = fmtDate(r.recall_initiation_date);
  const firm = r.recalling_firm ? `, manufacturer ${r.recalling_firm}` : "";
  const when = date ? `, initiated ${date}` : "";
  const lot = r.code_info ? `, lot(s): ${truncate(r.code_info.replace(/\s+/g, " "), 70)}` : "";
  return `recall ${r.recall_number} (Class ${cls}, ${r.status}${when}${firm}) — ${r.reason_for_recall}${lot}`;
}

async function buildBulletin(
  req: SafetyCheckRequest,
  drugs: SafetyReport["drugs"],
  raw: FlaggedRaw[],
): Promise<string> {
  if (raw.length === 0) {
    const who = req.patientId ? ` for patient ${req.patientId}` : "";
    return `No active FDA recalls were detected${who} for the reviewed medications: ${drugs
      .map((d) => d.input)
      .join(", ")}.`;
  }

  const facts = raw
    .map((d) => `- ${d.input}: ${d.records.map(oneFact).join("; ")}`)
    .join("\n");

  const model = process.env.LLM_MODEL ?? "claude-sonnet-4-6";
  const promptFqn = process.env.LLM_PROMPT_FQN ?? "";
  const gateway = !!(process.env.LLM_BASE_URL && process.env.LLM_API_KEY);
  // Only the patient id is sent to the LLM — never the patient name.
  const patientId = req.patientId ?? "unknown";
  const userPrompt = bulletinUserPrompt(patientId, facts);

  // (1) TrueFoundry Prompt Registry (LLM_PROMPT_FQN). Variables: {{patient_id}}, {{facts}}.
  if (promptFqn && gateway) {
    try {
      return await llmPromptComplete(promptFqn, { patient_id: patientId, facts }, { model });
    } catch {
      /* fall through */
    }
  }
  // (2) Direct Anthropic Messages API.
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await anthropicComplete(userPrompt, { system: BULLETIN_SYSTEM_PROMPT });
    } catch {
      /* fall through */
    }
  }
  // (3) Generic OpenAI-compatible endpoint (no registry prompt).
  if (gateway && !promptFqn) {
    try {
      return await llmComplete(model, userPrompt, { system: BULLETIN_SYSTEM_PROMPT });
    } catch {
      /* fall through */
    }
  }
  // (4) Deterministic template.
  return templateBulletin(req, facts);
}

const BULLETIN_SYSTEM_PROMPT = `You write short medication safety notices for patients, based only on FDA recall data you are given.

Rules:
- Use plain, calm language at a 6th to 8th grade reading level. Short sentences. Explain any medical word you must use.
- For each recall, state the recall number, the FDA class (Class I, II or III) and the reason for the recall, exactly as given. Do not invent facts, lot numbers, dates or risks.
- Briefly explain what the FDA class means (Class I: most serious, could cause serious harm; Class II: could cause temporary or reversible health problems; Class III: unlikely to cause harm).
- Tell the patient to compare the product description and the lot numbers in the recall with the label on their own bottle or package.
- Say clearly that a match on the medicine name does NOT confirm that their package is affected. Only the lot number and product details can tell.
- Never tell the patient to stop, skip or change their medication. Tell them to keep taking it as prescribed unless their pharmacist or doctor says otherwise, and to contact their pharmacist or doctor with questions.
- Refer to the patient only by the patient ID given. Do not guess a name.
- Output plain text only (no markdown headings or tables), under about 200 words.`;

function bulletinUserPrompt(patientId: string, facts: string): string {
  return (
    `Patient ID: ${patientId}\n\n` +
    `Active FDA recalls matched by medication name:\n${facts}\n\n` +
    `Write the patient notice now.`
  );
}

function templateBulletin(req: SafetyCheckRequest, facts: string): string {
  const who = req.patientId ? ` (patient ${req.patientId})` : "";
  return (
    `⚠️ Medication safety notice${who}\n` +
    `The FDA has active recalls for a medicine with the same name as one of yours:\n` +
    `${facts}\n\n` +
    `A name match does NOT confirm that your package is affected. ` +
    `Please compare the product description and lot numbers above with the label on your bottle or package. ` +
    `Class I is the most serious recall type; Class II and III carry lower risk. ` +
    `IMPORTANT: do not stop taking your medicine on your own. ` +
    `Contact your pharmacist or doctor to check your lot and ask what to do next.`
  );
}
