# SuperShield — shared data contract (Developer 1 ⇄ Developer 2)

Both workflows read the **same FDA recall records** from the **same ClickHouse Cloud service**
(`qstouvfciz.us-east-2.aws.clickhouse.cloud`). Neither workflow waits for the other.

## Shared identifier

**`recall_number`** — the openFDA recall number (e.g. `D-0788-2026`). Synthetic demo recalls
use `DEMO-YYYYMMDDHHMMSS` and must be labelled as synthetic in any UI or notification.

## Shared table: `supershield.fda_recalls`

Written by the pharmacy ingest (direct openFDA HTTP, `fetch_direct()`, polled every `FDA_POLL_SEC`, default 300s).
One row per (recall_number, product_ndc).

| column | use |
|---|---|
| `recall_number` | shared ID |
| `product_ndc` | pharmacy matching key (NDC) |
| `generic_name`, `product_description` | patient matching key (drug name) |
| `classification` | Class I / II / III (FDA) |
| `severity` | Lethal / Moderate / Minor (mapped from classification) |
| `reason_for_recall`, `recalling_firm`, `report_date`, `status` | patient notice content |
| `source_url` | openFDA link (empty for synthetic demo recalls) |
| `ingested_at` | when SuperShield first saw it — poll `WHERE ingested_at > last_seen` |

HTTP alternative (no pharmacy/customer data): `GET /api/shared/recalls?limit=100`
on the pharmacy server → `[{recall_number, product_ndcs[], classification, severity,
recalling_firm, reason_for_recall, generic_name, product_description, report_date,
source_url, ingested_at, synthetic}]`.

## Final demo

> Open item: switch this to the shared `shared/fda/demo-recalls.json` feed on `feat/patient`
> (`D-SS-####-2026`) so both dashboards show the same demo recall.

`POST /api/demo/recall` inserts ONE synthetic Class I recall into `supershield.fda_recalls`
for the most-dispensed NDC (with its generic name when openFDA knows it).

- Pharmacy side: ClickHouse MV matches it by NDC → monitor creates the pharmacist alert
  within `MONITOR_INTERVAL_SEC` (default 15s) and pushes to the pharmacist's phone.
- Patient side: the SuperShield Patient worker should pick up the same row (by `generic_name` /
  `product_description`) on its own interval and alert the patient — independently.

## What stays private to each side

- Pharmacy: `patient_ehr`, `patient_alerts`, `pharmacist_alerts`, `customer_followups`
  (contain synthetic customer names/phones — never in LLM prompts or map events).
- Patient: the patient workflow's `default.events` / `default.patient_notifications`.
