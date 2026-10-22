# SuperShield Pharmacy — coordination board (Developer 1)

Last updated: 2026-10-22 15:30 PDT. Branch: `feat/pharmacy`. Counterpart of `STATUS.md` /
`patient/COORDINATION.md` on `feat/patient`.

**Purpose:** tell the Patient side (Developer 2, `feat/patient`) exactly what Pharmacy owns, so the
two workflows never edit the same files, tables, or ports. If you need something from this list,
ask instead of editing it.

## What Pharmacy owns

| Area | Owned by Pharmacy | Patient side touches it? |
|---|---|---|
| Code | `phase1_data/`, `phase2_ingest/`, `phase3_lakehouse/`, `phase4_ml/`, `phase5_orchestration/`, `phase6_agents/`, `phase7_monitor/`, `config/`, `settings.py`, `requirements.txt`, root `.env.example` | No |
| ClickHouse database | `supershield.*`: `fda_recalls`, `pharmacies`, `patient_ehr`, `patient_alerts`, `alert_geo_rollup`, `pharmacist_alerts`, `customer_followups`, MVs `mv_patient_matches`, `mv_alert_geo_rollup` | No (Patient uses `default.patient_notifications`, `default.events`) |
| Port | `8000` (FastAPI + live US map) | No (Patient dashboard is `3000` / `5173`) |
| Secrets | root `.env` (gitignored) | No (Patient uses `patient/.env`) |

**Pharmacy never edits:** `patient/**`, `shared/fda/**`, `STATUS.md`, the root `README.md` section
"Patient workflow", or `default.*` tables.

## Shared contract (follows Patient's `shared/fda/README.md`)

- Common identifier: openFDA **`recall_number`**.
- One FDA source: live openFDA `drug/enforcement` (no key), ingested by a direct HTTP call (`fetch_direct()`) into `supershield.fda_recalls`. PyAirbyte was removed (no added value).
- Synthetic demo recalls: **uses** `shared/fda/demo-recalls.json` + `node shared/fda/inject-recall.mjs`
  (`D-SS-####-2026`, `"synthetic": true`). The pharmacy monitor reads the file every 15s
  (`SHARED_RECALLS_FILE`) and loads new records into `supershield.fda_recalls`. Package NDCs
  (`00093-1048-01`) are normalised to product NDCs (`00093-1048`) to match dispensing records.
  - Joint-demo recall that hits **both** sides: `node shared/fda/inject-recall.mjs --drug Levothyroxine --ndc 16729-447 --class "Class I"`
    (238 pharmacy customers fill NDC 16729-447; Levothyroxine is on the patient demo list).
  - Until `feat/patient` is merged, `shared/fda/` is absent on this branch, so `POST /api/demo/recall`
    falls back to a pharmacy-only `DEMO-…` recall (still labelled synthetic).
- Match honesty: Pharmacy matches by **NDC = candidate**, never a verified lot match. Customer
  names/phones never enter LLM prompts or public map events.

## Pharmacy HTTP API (port 8000)

| Endpoint | Purpose | State |
|---|---|---|
| `GET /api/stats`, `GET /api/recalls`, `GET /api/pharmacies`, `POST /api/run`, `WS /stream` | Pharmacy base (map, trace) | Committed |
| `GET /api/monitor/status` | Poller health (FDA poll every `FDA_POLL_SEC`=300s, alert scan every `MONITOR_INTERVAL_SEC`=15s) | Done, tested live |
| `GET /api/pharmacy/alerts` | Pharmacist alert list | Done, tested live |
| `POST /api/pharmacy/alerts/{recall_number}/status` | new → reviewing → resolved | Done, tested live |
| `GET /api/pharmacy/alerts/{recall_number}/customers` | Affected-customer review list | Done, tested live |
| `POST /api/pharmacy/alerts/{recall_number}/customers/{customer_id}` | contacted / lot_verified / not_affected | Done, tested live |
| `POST /api/demo/recall?drug=&ndc=&classification=` | Runs the shared injector (default Levothyroxine / 16729-447 / Class I) | Done, tested live (detected in 14s, 257 customers) |
| `GET /api/shared/recalls` | Recall feed without PII; Patient doesn't need it (reads openFDA directly) | In progress, may be dropped |

## Integrations

| Service | State |
|---|---|
| openFDA | Live, no key |
| ClickHouse Cloud (`qstouvfciz.us-east-2.aws.clickhouse.cloud:8443`) | Live: 5,000 pharmacies, 1,000,000 customers, 648 recalls, 136,209 NDC matches |
| Claude (alert cards) | Code switched from OpenAI; key needs a workspace ID (same blocker as Patient) |
| Telegram (pharmacist phone push) | **Live, chosen channel** (`ALERT_CHANNEL=telegram`), delivered in the E2E test |
| Composio (Slack/Gmail) | Code path ready, same env names as Patient; not in use (key rejected as invalid) |
| Twilio / TrueFoundry / Senso | Not used |

## Danger notes

- `python phase3_lakehouse/clickhouse_bootstrap.py --reset` drops **only** `supershield`. It never
  touches `default.*`, but do not run it during the other side's demo.
- Merge check (2026-10-22 15:15): one trivial conflict in root `README.md`. Both branches appended
  a section after the last line ("Running SuperShield Pharmacy" vs "Patient workflow"). Resolve
  by keeping both sections. No other conflicts.
