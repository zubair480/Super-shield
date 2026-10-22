# SuperShield Patient — agent coordination board

Branch: `feat/patient`. Code lives in `patient/`. Real app: live openFDA by default.
Every agent: read this first, only edit files you own, append status under **Log** when done.

## Contract (frozen — change only via lead)
- Recall identifier: openFDA `recall_number` (same as Pharmacy).
- Shared FDA feed: `shared/fda/demo-recalls.json` (repo root), openFDA drug/enforcement shape. Synthetic test rows carry `"synthetic": true`. Empty array in production.
- Types: `packages/shared/src/types.ts` → `RecallHit` (+product, lotInfo, firm, reportDate, initiationDate, synthetic), `PatientNotification`, `MonitorStatus`.
- Runtime files (gitignored): `demo/seed-data/notifications.json`, `demo/seed-data/monitor-status.json`.
- HTTP API (dashboard server, port 3000):
  - `GET /api/patients`, `POST /api/patients`, `PUT /api/patients/:id/drugs {drugs}`
  - `GET /api/patients/:id/notifications` → `{notifications}` newest first
  - `GET /api/monitor/status` → MonitorStatus + `running`
  - `GET /api/recall/:id`, `GET /api/drug-check?name=`
- Delivery labels: in-app always; external = sent | simulated (DRY_RUN) | failed | not_configured. Never claim a lot match.

## Ownership
| Owner | Files |
|---|---|
| Lead | `packages/sources/src/{openfda,match,checkDrugSafety,notifications,index}.ts`, `packages/shared/*`, `apps/worker/*`, `apps/dashboard/server/*`, root `package.json` |
| UI agent | `apps/dashboard/src/*` |
| LLM agent | `packages/sources/src/llm.ts` + `buildBulletin` section in `checkDrugSafety.ts` (coordinate: lead is not touching buildBulletin) |
| Feed/Docs agent | `../shared/fda/*`, `patient/.env.example`, `patient/README.md`, repo-root `README` section "Patient workflow" |

## Log
- lead: imported the patient app, npm install ok, shared types + shared feed reader done.
- llm: buildBulletin now tries TrueFoundry FQN -> direct Anthropic (ANTHROPIC_API_KEY, ANTHROPIC_MODEL default claude-sonnet-5-5, plain fetch, 20s timeout) -> OpenAI-compatible llmComplete -> template. Patient-facing system prompt (6th-8th grade, recall no.+class+reason, compare lots/label, "name match does NOT confirm your package", never stop meds). Only patient id sent to LLM. New exports anthropicComplete/anthropicConfigured. tsc clean; template verified with USE_SEED=1.
- feed/docs: shared/fda/{demo-recalls.json ([]), inject-recall.mjs (--drug/--ndc/--class/--strength/--reset; prints D-SS-####-2026), README.md} done and tested; patient/.env.example (English; USE_SEED=0, WORKER_INTERVAL_SEC=60, DRY_RUN=true, ANTHROPIC_*, SHARED_RECALLS_FILE, NOTIFICATIONS_FILE; LLM_PROMPT_FQN now blank so direct Claude is default) ; patient/README.md rewritten in English; root README "Patient workflow (Developer 2)" section appended. NOTE lead: docs reference `npm run dev` (worker+dashboard) — root package.json has no "dev" script yet.
- lead: ClickHouse Cloud provisioned (service "My first service", host qstouvfciz.us-east-2.aws.clickhouse.cloud:8443). Tables created: default.events, default.patient_notifications, supershield.{fda_recalls,pharmacies,patient_ehr,patient_alerts,alert_geo_rollup} (pharmacy schema, ready for Dev 1). Patient worker mirrors every notification into default.patient_notifications once CLICKHOUSE_PASSWORD is set (`npm run ch:password` reads it from clipboard).
- lead: E2E verified on live openFDA: injected synthetic Class I Losartan recall at 21:28:38Z, PX-001 in-app alert at 21:29:47Z with no manual action.
