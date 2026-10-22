# SuperShield — live build status

Last updated: 2026-10-22 (Developer 2 / Patient). Branch: `feat/patient`.
This file states plainly what is **real**, what is **synthetic/test**, and what is **not done yet**.

## Patient workflow (Developer 2) — `patient/`

| Piece | State | Notes |
|---|---|---|
| FDA data | **Real** | Live openFDA `drug/enforcement` API, no key needed. `USE_SEED=0` by default. |
| Continuous monitoring | **Real** | Worker re-checks every saved medication every 60s (`WORKER_INTERVAL_SEC`). No Scan button. |
| Drug matching | **Real**  | Name + synonym match against openFDA generic/brand/substance/product. It is a **name match**, never shown as a lot match. |
| In-app alerts | **Real** | One per (patient, `recall_number`). Stored in `patient/demo/seed-data/notifications.json`. |
| Patient UI | **Real** | `npm --prefix patient run dev` → http://localhost:3000 (prod build) / http://localhost:5173 (live dev). Live 3D globe of real recall locations (click to fly, double click to zoom), live FDA ticker, stats, medication cards, alert list, 3-step lot check. |
| Claude bulletins | **Real** | Direct Anthropic API (`claude-sonnet-5-5`), workspace-scoped key verified. New alerts get a Claude-written patient summary; template only if the API is down. |
| Slack/Gmail (Composio) | **Partial** | `COMPOSIO_API_KEY` set; needs `COMPOSIO_SLACK_CHANNEL` (or `NOTIFY_CHANNEL=gmail` + `COMPOSIO_GMAIL_TO`). UI labels it "Not configured" until then — never claims "sent". |
| ClickHouse | **Real** | Connected to ClickHouse Cloud. Every new alert is written to `default.patient_notifications`, every pipeline event to `default.events`. History backfilled (`npm --prefix patient run ch:backfill`: 224 alerts, 468 events). Verified: recall injected 21:47:29Z → row in ClickHouse 21:47:37Z. |
| Demo recall | **Synthetic, labeled** | `node shared/fda/inject-recall.mjs --drug Losartan --class "Class I"` adds one openFDA-shaped record with `"synthetic": true`. UI shows "Test recall". Reset with `--reset`. |

Verified end to end: synthetic Class I Losartan recall injected 21:28:38Z → patient PX-001 alerted in-app 21:29:47Z, no pharmacist action.

## Shared contract with Pharmacy (Developer 1)

- Recall identifier: openFDA **`recall_number`** (same as Pharmacy).
- Shared test feed: `shared/fda/demo-recalls.json` (openFDA shape). Load it alongside openFDA into `supershield.fda_recalls` so both sides detect the same demo recall independently.
- ClickHouse Cloud service "My first service" — tables already created:
  - `default.events`, `default.patient_notifications` (patient)
  - `supershield.fda_recalls`, `pharmacies`, `patient_ehr`, `patient_alerts`, `alert_geo_rollup` (pharmacy schema, ready for Developer 1; materialized view not created yet)

## Secrets

All in `patient/.env` (gitignored). Template: `patient/.env.example`. Never commit keys.

## Not done yet

- Slack channel for Composio.
- Pharmacy side lives on Developer 1's branch.
