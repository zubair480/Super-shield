# SuperShield

The project is SuperShield, and it has two independent, continuously monitoring workflows that share the same FDA data.

The pharmacist does not need to initiate the patient's monitoring. Both sides watch for recalls independently and receive notifications when relevant.

We will use the two existing repositories, not rebuild their infrastructure.

## SuperShield — Product architecture

FDA Drug Recall API

One continuously updated public data source

Pharmacy

Powered by HawkSign

Continuously monitors FDA recalls against pharmacy dispensing records.

Recall detected → Affected customers identified → Pharmacist notified → Follow-up initiated

Patient

Powered by FarmaWatcher

Continuously monitors FDA recalls against the patient's personal medication list.

Recall detected → Medication match → Patient notified → Patient reviews next steps

## What each developer builds

|                    | Developer 1                                                                      | Developer 2                                                                        |
| ------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Product            | SuperShield Pharmacy                                                             | SuperShield Patient                                                                |
| Reference          | [HawkSign](https://github.com/mansiguptacs/HawkSign)                             | [FarmaWatcher](https://github.com/Kiwis01/FarmaWatcher)                            |
| Existing strengths | NDC matching, 1M synthetic customers, ClickHouse, national map, alert simulation | Drug-name matching, continuous worker, patient notices, Claude bulletins, Composio |
| Core screen        | Pharmacy recall command center                                                   | My Medications + safety alerts                                                     |
| Trigger            | New FDA recall affecting pharmacy records                                        | New FDA recall affecting saved medications                                         |
| Output             | Pharmacist alert and affected-customer list                                      | Personal notification and understandable safety information                        |

Both run without the user clicking a Scan button. The initial medication list or pharmacy records must be configured, but after that monitoring happens automatically at a configured polling interval.

## Copy-paste prompts

# Developer 1 — SuperShield Pharmacy

We are building SuperShield, with two independent FDA drug-recall monitoring workflows in ONE centralized GitHub repository.

Your responsibility: PHARMACY WORKFLOW.

Reference repository:\
[https://github.com/mansiguptacs/HawkSign](https://github.com/mansiguptacs/HawkSign)

Other developer's reference:\
[https://github.com/Kiwis01/FarmaWatcher](https://github.com/Kiwis01/FarmaWatcher)

**Do not rebuild existing functionality.**

1. Inspect the central repository and HawkSign before changing anything.
2. Reuse HawkSign's real openFDA ingestion, PyAirbyte, ClickHouse matching, synthetic pharmacy/customer data, FastAPI, and live US map.
3. Keep continuous FDA monitoring. When a new recall matches pharmacy dispensing data by NDC, automatically create the pharmacist alert and affected-customer review list.
4. Keep HawkSign's existing geographical visualization, severity information, and alert simulation.
5. Clearly distinguish NDC candidate matches from verified lot matches.
6. Keep customer names and contact information out of AI model prompts and public map events.
7. Provide the pharmacy dashboard with real backend data, event status, and an actionable affected-customer list.
8. Coordinate a shared FDA data source and common record identifiers with Developer 2. Reuse the existing endpoints and add only essential missing functionality.
9. Do not introduce new databases, frameworks, unnecessary services, or a second authentication system.
10. Work on branch `feat/pharmacy`. Avoid modifying the Patient UI files.

Success: A new FDA recall is automatically detected, matched to synthetic pharmacy records, displayed on the US map, and surfaced as a pharmacist notification without manual scanning.

Use the actual repository code, not a reimplementation. Distinguish real alerts from simulated deliveries.

# Developer 2 — SuperShield Patient

We are building SuperShield, with two independent FDA drug-recall monitoring workflows in ONE centralized GitHub repository.

Your responsibility: PATIENT WORKFLOW.

Primary reference:\
[https://github.com/Kiwis01/FarmaWatcher](https://github.com/Kiwis01/FarmaWatcher)

Shared architecture reference:\
[https://github.com/mansiguptacs/HawkSign](https://github.com/mansiguptacs/HawkSign)

**Do not rebuild existing functionality.**

1. Inspect the central repository and FarmaWatcher before writing code.
2. Reuse FarmaWatcher's medication registry, existing recurring FDA-monitoring worker, drug matching and synonym handling, Claude-generated bulletins, notification integration, and dashboard components.
3. Implement a clean patient-facing screen: My Medications, Monitoring Status, Safety Alerts, and Recall Details.
4. After a patient saves medications, continuously check for relevant FDA recalls automatically using the existing worker. No manual Scan button should be required.
5. When a recall is detected, generate a clear patient-specific notification with FDA source, classification, recall reason, and required product/lot verification.
6. Reuse existing delivery integrations. Provide in-app alerts regardless of whether external notification credentials are available; label simulated notifications accurately.
7. Keep the patient workflow independent from the pharmacy workflow. A patient must receive a relevant warning even if their pharmacy has not reviewed the recall.
8. Coordinate with Developer 1 on common recall identifiers and shared public FDA data. Do not introduce unnecessary duplicate infrastructure.
9. Work on branch `feat/patient`. Avoid modifying Developer 1's pharmacy implementation.
10. Do not add new frameworks, databases, agent orchestration, or unrelated features.

Success: A patient adds medications once. When the monitoring worker discovers a matching new FDA recall, the dashboard displays a notification automatically, without requiring pharmacist intervention.

Use the actual FarmaWatcher functionality wherever possible. Never imply a drug-name match proves that a specific patient package or lot has been recalled.

## Integration rules

To keep the work minimal, use HawkSign's existing infrastructure as the main app, and bring in FarmaWatcher's patient-monitoring functionality rather than launching two entirely separate products.

The shared integration should consist of the existing FDA recall records, consistent recall identifiers, and two user-facing workflows. Developers should reuse existing code wherever possible, and only write adapters for genuinely missing connections.

One practical distinction: the current HawkSign repository supports ingestion, but its demonstrated orchestration is run through a launch endpoint. FarmaWatcher's worker already supports recurring monitoring. So we must connect that recurring trigger to the pharmacy flow rather than claim HawkSign is already an always-running alert service.

Final demo: Introduce one new FDA recall in the synthetic environment. Both sides independently detect it: the pharmacy dashboard highlights affected customers, while the patient dashboard receives its own medication safety alert. Neither workflow waits for the other.

That's SuperShield: one FDA safety network, two independent experiences, continuous protection.

---

## Running SuperShield Pharmacy (Developer 1, branch `feat/pharmacy`)

Built on HawkSign (original README: [docs/HAWKSIGN_README.md](docs/HAWKSIGN_README.md)).
Shared data contract with the patient workflow: [docs/INTEGRATION.md](docs/INTEGRATION.md).

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt
cp .env.example .env    # ClickHouse Cloud host/password; optional Composio (Slack/Gmail) push
.venv/Scripts/python phase1_data/fetch_seed_ndcs.py
.venv/Scripts/python phase1_data/generate_pharmacies.py
.venv/Scripts/python phase1_data/generate_customers.py
.venv/Scripts/python phase3_lakehouse/clickhouse_bootstrap.py   # schema + 1M customers
.venv/Scripts/python phase2_ingest/load_to_clickhouse.py         # live openFDA recalls
.venv/Scripts/python -m uvicorn phase5_orchestration.server:app --port 8000
```

The server starts the always-on monitor (`phase7_monitor/monitor.py`): it polls openFDA every
`FDA_POLL_SEC` (300s), and every `MONITOR_INTERVAL_SEC` (15s) turns each newly matched recall
into a pharmacist alert, pushes it via Composio to Slack or Gmail (`COMPOSIO_API_KEY`,
`NOTIFY_CHANNEL`, `COMPOSIO_SLACK_CHANNEL` / `COMPOSIO_GMAIL_TO`) and replays it on the US map. No button press needed.
Recalls already present when the monitor starts are listed as "Earlier" and never paged.
Matches are **NDC candidates** — the pharmacist verifies the lot per customer.
Customer SMS fan-out remains simulated and is labelled so.
