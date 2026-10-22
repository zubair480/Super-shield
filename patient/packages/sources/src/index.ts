// Punto de entrada de packages/sources (dominio + datos de Persona A).
// Contrato A -> B: `checkDrugSafety` (la consume apps/api de Persona B).
export { checkDrugSafety } from "./checkDrugSafety";
export {
  llmComplete,
  llmPromptComplete,
  anthropicComplete,
  anthropicConfigured,
  type LlmMessage,
} from "./llm";
export {
  fetchRecalls,
  matchSeed,
  loadSeedRecalls,
  recallSourceUrl,
  openFdaBase,
  type OpenFdaRecall,
} from "./openfda";
export { mapClassification, isActive, toRecallHit, severityRank, dedupeByRecall } from "./match";
export { canonicalDrug, normalize, stripAccents } from "./synonyms";
export { loadSharedRecalls, matchShared, sharedRecallsPath } from "./openfda";
export {
  monitorPatient,
  listNotifications,
  notificationId,
  writeMonitorStatus,
  readMonitorStatus,
  dataSource,
  type MonitorPatient,
  type EventLogger,
} from "./notifications";
