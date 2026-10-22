# SuperShield Patient

The patient side of SuperShield. A patient saves their medication list once. After that, a
background worker keeps checking FDA drug recalls (live openFDA plus the shared SuperShield feed).
When a recall matches a saved medication, the patient gets an in-app safety alert with a
plain-language bulletin written by Claude. No Scan button and no pharmacist action are needed.

This app does not depend on the Pharmacy workflow. Both read the same FDA data and use
the same `recall_number`, but each one detects recalls and alerts on its own.


## What it does

- **My Medications**: save a patient's drug list (brand or generic names; synonyms are handled).
- **Monitoring Status**: the worker polls openFDA every `WORKER_INTERVAL_SEC` seconds. The screen
  shows the last check, the next check and the data source.
- **Safety Alerts**: one notification per new matching recall, newest first. Each one includes the
  FDA source, classification, recall reason and the product/lot details to check.
- **Recall Details**: the full FDA record (product, NDC, lots, firm, dates) and the bulletin.
- **Delivery**: in-app alerts always work. Slack/Gmail delivery through Composio is optional.
- **Ops event log** at `/events`: what the worker did and when.

## Quickstart

```bash
cd patient
npm install
cp .env.example .env          # works as-is; add ANTHROPIC_API_KEY for Claude bulletins
npm run dashboard:build
npm run dev                   # runs the worker + dashboard together
```

Open <http://localhost:3000> for the patient screen and <http://localhost:3000/events> for the
ops event log.

You can also run the two parts separately with `npm run worker` and `npm run dashboard`.

## APIs: required vs optional

| Service | Status | Key | What happens without it |
|---|---|---|---|
| openFDA `drug/enforcement` | **Required** | None (`OPENFDA_API_KEY` optional, raises the rate limit) | Use `USE_SEED=1` to run fully offline on the fixture |
| Anthropic Claude | **Recommended** | `ANTHROPIC_API_KEY` (`ANTHROPIC_MODEL`, default `claude-sonnet-5-5`) | Bulletins use a plain template. Alerts still work |
| TrueFoundry AI Gateway | Optional | `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_PROMPT_FQN` | Direct Claude (or the template) is used instead |
| Composio (Slack/Gmail) | Optional | `COMPOSIO_API_KEY` + channel/recipient | External delivery shows as `not_configured`. With `DRY_RUN=true` it shows as `simulated` |
| ClickHouse Cloud | Optional | `CLICKHOUSE_URL` | Events are stored in a local JSON file. `/events` still works |

Key defaults: `USE_SEED=0` (live openFDA), `WORKER_INTERVAL_SEC=60`, `DRY_RUN=true`.

## Demo: new recall → patient alert, no pharmacist involved

1. Start the app (`npm run dev`) and open <http://localhost:3000>.
2. Add a patient (or pick one) and save **Metformin** as a medication.
3. In another terminal, inject a synthetic recall into the shared feed:
   ```bash
   node ../shared/fda/inject-recall.mjs --drug Metformin --class "Class I"
   ```
   The script prints the new `recall_number` (for example `D-SS-0721-2026`).
4. Within one polling interval (60 s by default), a safety alert appears on the patient screen.
   You don't click anything and no pharmacist has to review it first. The alert shows the same
   `recall_number` and is labeled **synthetic**.
5. Clean up afterwards: `node ../shared/fda/inject-recall.mjs --reset`.

The Pharmacy dashboard (Developer 1) reads the same file. It detects the same recall on its own,
under the same `recall_number`.

## Honesty rules

- **A name match is not a lot match.** A recall that matches a medication name means "this may
  affect you." The alert always tells the patient to compare the lot number and NDC on their own
  package with the recall. It never says their package is recalled. It also never tells them to
  stop taking a medication; they should contact their pharmacist or doctor.
- **Delivery status is reported accurately.** Each notification shows in-app delivery plus an
  external status: `sent`, `simulated` (DRY_RUN), `failed` or `not_configured`. A simulated
  delivery is never shown as sent.
- **Synthetic data is labeled.** Records from `inject-recall.mjs` carry `"synthetic": true` and are
  marked as synthetic/test in the UI.
- **Minimal data goes to the LLM.** Only the patient id and the recall facts are sent. Names and
  contact details are not.

## Layout

```
packages/shared/     Shared types (RecallHit, PatientNotification, MonitorStatus)
packages/sources/    openFDA client, shared-feed reader, drug matching, checkDrugSafety, Claude bulletins
packages/notifier/   Composio delivery (Slack/Gmail), DRY_RUN aware
apps/worker/         Continuous monitoring worker
apps/dashboard/      React patient screen + server (HTTP API on port 3000)
apps/api/            Original /check API (Render deploy)
demo/seed-data/      Demo patients, offline fixture, runtime notifications (gitignored)
../shared/fda/       Shared FDA feed used by Patient and Pharmacy (see its README)
```
