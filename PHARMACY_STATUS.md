# SuperShield Pharmacy — coordination board (Developer 1)

Last updated: 2026-10-22 22:00 PDT. Branch: `feat/pharmacy`. Counterpart of `STATUS.md` /
`patient/COORDINATION.md` on `feat/patient`.

**Purpose:** tell the Patient side (Developer 2, `feat/patient`) exactly what Pharmacy owns, so the
two workflows never edit the same files, tables, or ports. If you need something from this list,
ask instead of editing it.

## What Pharmacy owns

| Area | Owned by Pharmacy | Patient side touches it? |
|---|---|---|
| Code | `phase1_data/`, `phase2_ingest/`, `phase3_lakehouse/`, `phase4_ml/`, `phase5_orchestration/`, `phase6_agents/`, `phase7_monitor/`, `config/`, `settings.py`, `requirements.txt`, root `.env.example` | No |
| ClickHouse database | `safetynet.*`: `fda_recalls`, `pharmacies`, `patient_ehr`, `patient_alerts`, `alert_geo_rollup`, `pharmacist_alerts`, `customer_followups`, MVs `mv_patient_matches`, `mv_alert_geo_rollup` | No (Patient uses `default.patient_notifications`, `default.events`) |
| Port | `8000` (FastAPI + live US map) | No (Patient dashboard is `3000` / `5173`) |
| Secrets | root `.env` (gitignored) | No (Patient uses `patient/.env`) |

**Pharmacy never edits:** `patient/**`, `shared/fda/**`, `STATUS.md`, the root `README.md` section
"Patient workflow", or `default.*` tables.

## Shared contract (follows Patient's `shared/fda/README.md`)

- Common identifier: openFDA **`recall_number`**.
- One FDA source: live openFDA `drug/enforcement` (no key), ingested by PyAirbyte into `safetynet.fda_recalls`.
- Synthetic demo recalls: **adopting** `shared/fda/demo-recalls.json` + `node shared/fda/inject-recall.mjs`
  (`D-SS-####-2026`, `"synthetic": true`). Pharmacy will load that file into `safetynet.fda_recalls`.
  - *Open item:* `feat/pharmacy` work-in-progress still has its own `POST /api/demo/recall` (prefix `DEMO-`).
    It will be switched to the shared feed so both dashboards show the same demo recall.
- Match honesty: Pharmacy matches by **NDC = candidate**, never a verified lot match. Customer
  names/phones never enter LLM prompts or public map events.

## Pharmacy HTTP API (port 8000)

| Endpoint | Purpose | State |
|---|---|---|
| `GET /api/stats`, `GET /api/recalls`, `GET /api/pharmacies`, `POST /api/run`, `WS /stream` | HawkSign base (map, trace) | Committed |
| `GET /api/monitor/status` | Poller health (FDA poll every `FDA_POLL_SEC`=300s, alert scan every `MONITOR_INTERVAL_SEC`=15s) | Done, tested live |
| `GET /api/pharmacy/alerts` | Pharmacist alert list | Done, tested live |
| `POST /api/pharmacy/alerts/{recall_number}/status` | new → reviewing → resolved | Done, tested live |
| `GET /api/pharmacy/alerts/{recall_number}/customers` | Affected-customer review list | Done, tested live |
| `POST /api/pharmacy/alerts/{recall_number}/customers/{customer_id}` | contacted / lot_verified / not_affected | Done, tested live |
| `POST /api/demo/recall` | Own demo injector — **to be replaced by shared feed** | In progress |
| `GET /api/shared/recalls` | Recall feed without PII; Patient doesn't need it (reads openFDA directly) | In progress, may be dropped |

## Integrations

| Service | State |
|---|---|
| openFDA | Live, no key |
| ClickHouse Cloud (`qstouvfciz.us-east-2.aws.clickhouse.cloud:8443`) | Live: 5,000 pharmacies, 1,000,000 customers, 648 recalls, 136,209 NDC matches |
| Claude (alert cards) | Code switched from OpenAI; key needs a workspace ID (same blocker as Patient) |
| Composio | Key set; delivery not wired yet |
| Twilio / Telegram / TrueFoundry / Senso | Not used |

## Danger notes

- `python phase3_lakehouse/clickhouse_bootstrap.py --reset` drops **only** `safetynet`. It never
  touches `default.*`, but do not run it during the other side's demo.
- Merge check: `feat/pharmacy` + `feat/patient` merge with **no conflicts** (verified 2026-10-22).
