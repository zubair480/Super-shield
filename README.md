# 🛡️ SuperShield

**One FDA safety network, two independent shields.** SuperShield watches every FDA drug recall
around the clock and warns the people it affects automatically, with no Scan button:

- **💊 SuperShield Pharmacy** tells a pharmacist which of their customers filled a recalled
  product, maps the spread across the country and pushes an alert to their phone.
- **🧑‍⚕️ SuperShield Patient** tells a patient, in plain language, when a medication they take
  has been recalled, even if their pharmacy hasn't looked at the recall yet.

Both workflows read the same public FDA data and share the same recall ID, but neither one waits
for the other.

> **Why it matters.** openFDA lists **765 drug recall reports in 2025** and **671 so far in 2026**,
> 84 of them Class I (risk of serious harm or death). In 2023, a recalled brand of artificial tears
> was linked by the CDC to **81 infections in 18 states, 4 deaths, 14 people who lost their vision
> and 4 eye removals**. Pharmacies aren't required to print lot numbers on prescription labels, and
> providers get no FDA communication for about 1 in 5 serious drug recalls. Recalls are public, but
> nobody is watching on behalf of a specific person. SuperShield does.

---

## Contents

- [How it works](#how-it-works)
- [Public APIs we use](#public-apis-we-use)
- [Tools and libraries](#tools-and-libraries)
- [Design principles](#design-principles)
- [Run it](#run-it)
- [Final demo](#final-demo-one-recall-two-independent-alerts)
- [Configuration](#configuration)
- [Repository layout](#repository-layout)
- [Verified results](#verified-results)
- [What's next](#whats-next)

---

## How it works

```
                 openFDA  drug/enforcement  (public, no key)
                                   │
            ┌──────────────────────┴──────────────────────┐
            │ every 5 min                                 │ every 60 s
            ▼                                             ▼
   SUPERSHIELD PHARMACY  (Python)                SUPERSHIELD PATIENT  (TypeScript)
   recall → ClickHouse fda_recalls               recall → match saved medications
            │  materialized view joins on NDC             │  by drug name + synonyms
            ▼                                             ▼
   1,000,000 prescriptions matched in <1 s       one alert per (patient, recall_number)
            │                                             │
            ▼                                             ▼
   pharmacist alert + affected-customer list     Claude writes a plain-language bulletin
   live US map (D3) + Claude alert card          in-app Safety Alerts + Recall Details
   📱 Telegram push to the pharmacist            optional Slack / Gmail delivery
            │                                             │
            └──────────── ClickHouse Cloud (one service) ─┘
                 shared ID: openFDA recall_number
```

### Pharmacy workflow

1. **Poll openFDA.** Every `FDA_POLL_SEC` (300 s), the monitor asks openFDA for drug recalls
   reported in the last 120 days. It flattens each recall into one row per product NDC, and inserts
   only recall numbers it hasn't seen into `supershield.fda_recalls`.
2. **Match in the database.** A ClickHouse **materialized view** fires on every insert and joins the
   new recall against **1,000,000 synthetic prescriptions** by NDC, writing every affected
   customer to `patient_alerts`. A second materialized view keeps a per-state rollup with no
   personal data, which powers the map.
3. **Alert the pharmacist.** Every `MONITOR_INTERVAL_SEC` (15 s), the monitor turns each newly
   matched recall into a pharmacist alert, sends a **Telegram** message to the pharmacist's
   phone, and replays the recall on the live dashboard: severity, cohort, map, alert card.
4. **Review.** The pharmacist opens the affected-customer list and marks each person *contacted*,
   *lot verified* or *not affected*. Alert status moves *new → reviewing → resolved*.

Recalls already in the database when the monitor starts are listed as "Earlier" and never paged,
so restarts don't spam the pharmacist.

### Patient workflow

1. A patient saves their medication list once (brand or generic names).
2. A worker re-checks every saved medication against openFDA every `WORKER_INTERVAL_SEC` (60 s),
   matching on generic, brand, substance and product names with synonym handling.
3. A new match creates exactly one notification per `(patient, recall_number)`, with a
   plain-language bulletin written by **Claude**: the FDA source, the classification, the reason, and
   which lot/NDC to compare on the package.
4. The patient screen shows **My Medications, Monitoring Status, Safety Alerts and Recall
   Details**. Alerts and pipeline events are also written to ClickHouse.

---

## Public APIs we use

### 1. openFDA Drug Enforcement API: the single source of truth

| | |
|---|---|
| Endpoint | `GET https://api.fda.gov/drug/enforcement.json` |
| Auth | None. An optional `OPENFDA_API_KEY` only raises the rate limit. |
| Used by | Both workflows |

**How we query it**

| Purpose | Query |
|---|---|
| Pharmacy: recent recall window | `search=report_date:[YYYYMMDD TO YYYYMMDD]&sort=report_date:desc&limit=1000` |
| Patient: a saved medication | `search=<drug name>` matched against `openfda.generic_name`, `brand_name`, `substance_name` and `product_description` |
| Patient: recall details | `search=recall_number:"<id>"` |
| Stats for this README | `search=report_date:[20250101 TO 20251231] AND classification:"Class I"` and reading `meta.results.total` |

**Fields we rely on:** `recall_number` (the shared ID), `classification` (Class I/II/III),
`reason_for_recall`, `recalling_firm`, `product_description`, `code_info` (lot numbers),
`report_date`, `status`, `distribution_pattern`, and `openfda.product_ndc[]`,
`openfda.generic_name[]` and `openfda.brand_name[]`.

**What we learned about it:**
- One recall can cover many NDCs, so the pharmacy side stores one row per `(recall_number,
  product_ndc)`.
- openFDA returns **HTTP 404 when a date window has no results**. We treat that as "no new
  recalls", not an error.
- Lot numbers live in free text (`code_info`), and dispensing records rarely carry lots. That's
  why a match is always a **candidate**, never proof.
- Classification maps to severity labels: Class I → *Lethal*, Class II → *Moderate*, Class III → *Minor*.

### 2. ClickHouse Cloud: matching engine and shared store

| | |
|---|---|
| Interface | HTTPS on port 8443 (`clickhouse-connect` for Python, `@clickhouse/client` for Node) |
| Auth | Database user and password |
| Used by | Both workflows, in one service |

| Database | Tables | Purpose |
|---|---|---|
| `supershield` | `fda_recalls` (ReplacingMergeTree), `pharmacies`, `patient_ehr` (1M rows), `patient_alerts`, `alert_geo_rollup` (AggregatingMergeTree), `pharmacist_alerts`, `customer_followups` | Pharmacy matching, alerts and follow-up |
| `supershield` | `mv_patient_matches`, `mv_alert_geo_rollup` | **Materialized views**: the real-time matching trigger |
| `default` | `patient_notifications`, `events` | Patient alerts and the patient worker's event log |

ClickHouse features that did real work:
- **Materialized views as triggers:** one recall insert fans out to every matching customer, with
  no application code involved.
- **ReplacingMergeTree** for status changes: we insert a new row, and `FINAL` reads the latest. No
  `UPDATE` needed.
- **AggregatingMergeTree** with `countState` / `uniqState` for per-state map totals that contain no
  personal data.

### 3. Anthropic Claude API: human-readable alerts

| | |
|---|---|
| Endpoint | `POST https://api.anthropic.com/v1/messages` (official `anthropic` Python SDK; direct HTTPS on the patient side) |
| Models | `claude-opus-5-5` for pharmacy alert cards, `claude-sonnet-5-5` for patient bulletins |
| Auth | `ANTHROPIC_API_KEY` (a workspace-scoped key) |

- **Pharmacy:** generates the patient-facing alert card shown on the dashboard. The input is
  recall facts and **counts only**: no names, no phone numbers.
- **Patient:** writes a plain-language bulletin per alert from the recall facts and a patient
  ID only.
- **Graceful fallback:** with no key, or if the API is unavailable or refuses, both sides fall back
  to a deterministic template. Alerts never depend on the LLM.

### 4. Telegram Bot API: the pharmacist's phone push

| | |
|---|---|
| Endpoints | `getMe` (validate token), `getUpdates` (find the chat ID after `/start`), `sendMessage` |
| Auth | Bot token from **@BotFather** |
| Cost | Free |

Setup takes about two minutes: create a bot with @BotFather, send it `/start`, put
`TELEGRAM_BOT_TOKEN` in `.env`, then find your chat ID with:

```bash
python -c "from phase5_orchestration.tools import real_alert as r; print(r.resolve_chat_id())"
```

The pushed message carries only recall facts and counts, plus a reminder to verify the lot.

### 5. Optional delivery integrations

| Service | Where | What it does | Without it |
|---|---|---|---|
| **Composio** (Slack / Gmail tool calls) | Patient; also a pharmacy channel option | Delivers alerts to a Slack channel or an email inbox | Status shows `not_configured`; with `DRY_RUN=true` it shows `simulated`, never "sent" |
| **TrueFoundry AI Gateway** | Patient | OpenAI-compatible gateway with a prompt registry | Claude is called directly |

### 6. Public CDNs and datasets in the browser

| Asset | Source | Used for |
|---|---|---|
| U.S. state boundaries (`us-atlas@3/states-10m.json`) | jsDelivr | Pharmacy choropleth map |
| React 18, htm, D3 v7, topojson-client | unpkg / jsDelivr | Pharmacy dashboard, with no build step |
| World boundaries (`world-atlas`) | npm | Patient 3D globe of recall locations |

---

## Tools and libraries

| Layer | Pharmacy (Python) | Patient (TypeScript) |
|---|---|---|
| API server | **FastAPI** + **Uvicorn**, WebSocket live trace | Node + **Express** / Vite dev server |
| UI | React 18 (UMD + htm), **D3** geo map | **React** + **Vite**, **three.js** globe, topojson |
| Data | **clickhouse-connect**, **pandas**, **NumPy** | **@clickhouse/client** |
| ML | **scikit-learn** severity classifier (TF-IDF → SVD → logistic regression), **joblib** | Drug-name and synonym matcher |
| Synthetic data | **Faker**: 5,000 pharmacies, 1,000,000 customer prescriptions, all 50 states + DC | Demo patients and a shared synthetic recall feed |
| AI | **anthropic** SDK | Anthropic Messages API |
| Delivery | **requests** → Telegram Bot API | **@composio/core** (optional) |
| Runtime | Python 3.12, `python-dotenv` | Node 20+, `tsx`, TypeScript |

**What we deliberately left out:** Docker, a second database, a second login system, an agent
orchestration framework, and an ETL framework. A direct openFDA HTTP call proved simpler and just
as live.

---

## Design principles

- **A match is not proof.** A pharmacy NDC match is labelled **"NDC candidate – lot not verified"**.
  A patient name match says "this *may* affect you; compare the lot and NDC on your package." The
  system never claims a specific bottle is recalled and never tells anyone to stop a medication.
- **No personal data leaves the data layer.** Customer names and phone numbers never reach an
  LLM prompt, the live map, the WebSocket stream or the phone push. Only the pharmacist's own review
  list shows them.
- **Simulations are labelled.** Synthetic recalls carry `"synthetic": true` and `D-SS-` / `DEMO-`
  IDs. The customer SMS fan-out is labelled *simulated*. A delivery is only shown as "sent" when an
  API confirmed it.
- **Independence.** The patient warning never waits for a pharmacist, and the pharmacy alert never
  waits for the patient app.

---

## Run it

### Prerequisites

- Python 3.12 and Node.js 20+
- A **ClickHouse Cloud** service (the free trial is enough)
- Optional: an Anthropic API key and a Telegram bot

### SuperShield Pharmacy

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt       # macOS/Linux: .venv/bin/pip
cp .env.example .env                                  # fill in ClickHouse, Anthropic, Telegram

# one-time: synthetic pharmacy network + customers, schema, live recalls
.venv/Scripts/python phase1_data/fetch_seed_ndcs.py
.venv/Scripts/python phase1_data/generate_pharmacies.py
.venv/Scripts/python phase1_data/generate_customers.py
.venv/Scripts/python phase3_lakehouse/clickhouse_bootstrap.py
.venv/Scripts/python phase2_ingest/load_to_clickhouse.py

# start the dashboard + always-on monitor
.venv/Scripts/python -m uvicorn phase5_orchestration.server:app --port 8000
```

Open <http://localhost:8000> and click **💊 Pharmacist alerts**.

### SuperShield Patient

```bash
cd patient
npm install
cp .env.example .env          # works as-is; add ANTHROPIC_API_KEY for Claude bulletins
npm run dashboard:build
npm run dev                   # worker + dashboard
```

Open <http://localhost:3000>.

---

## Final demo: one recall, two independent alerts

```bash
node shared/fda/inject-recall.mjs --drug Levothyroxine --ndc 16729-447 --class "Class I"
```

This appends one **synthetic** recall, in openFDA's exact shape, to `shared/fda/demo-recalls.json`.
The pharmacy dashboard's **🧪 Demo recall** button does the same thing.

- **Pharmacy:** within about 15 s the recall is matched by NDC, the map lights up, the pharmacist
  alert appears and the pharmacist's phone buzzes on Telegram.
- **Patient:** within one worker cycle (60 s), patients with that medication get their own safety
  alert, with no pharmacist involved.
- Both show the same `recall_number`, labelled as synthetic.

Clean up afterwards with `node shared/fda/inject-recall.mjs --reset`.

---

## Configuration

**Pharmacy (`.env`)**

| Variable | Purpose |
|---|---|
| `CLICKHOUSE_HOST`, `CLICKHOUSE_PORT=8443`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_SECURE=true`, `CLICKHOUSE_DATABASE=supershield` | ClickHouse Cloud |
| `OPENFDA_API_KEY` | Optional; raises the openFDA rate limit |
| `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` | Claude alert cards |
| `ALERT_CHANNEL=telegram`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Pharmacist phone push |
| `FDA_POLL_SEC` (300), `MONITOR_INTERVAL_SEC` (15) | Monitor timing |
| `SCALE_PHARMACIES` (5000), `SCALE_CUSTOMERS` (1000000) | Synthetic data size |

**Patient (`patient/.env`):** `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `CLICKHOUSE_URL`,
`WORKER_INTERVAL_SEC` (60), `USE_SEED` (0 = live openFDA), `DRY_RUN`, and optionally `COMPOSIO_*`.

Secrets live only in `.env` files, which are gitignored. Never commit keys.

### Pharmacy HTTP API (port 8000)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/monitor/status` | Monitor health: last FDA poll, last check, push channel |
| GET | `/api/pharmacy/alerts` | Pharmacist alerts (live, synthetic demo and earlier) |
| POST | `/api/pharmacy/alerts/{recall_number}/status` | `new` / `reviewing` / `resolved` |
| GET | `/api/pharmacy/alerts/{recall_number}/customers` | Paginated affected-customer review list |
| POST | `/api/pharmacy/alerts/{recall_number}/customers/{customer_id}` | `contacted` / `lot_verified` / `not_affected` |
| POST | `/api/demo/recall` | Inject one synthetic recall |
| GET | `/api/shared/recalls` | Recall feed without any customer data |
| GET | `/api/stats`, `/api/recalls`, `/api/pharmacies` · WS `/stream` | Dashboard data and live trace |

---

## Repository layout

```
phase1_data/          synthetic pharmacies + 1M customers (Faker), seed NDCs from openFDA
phase2_ingest/        openFDA → ClickHouse loader (direct HTTP, incremental)
phase3_lakehouse/     ClickHouse schema, materialized views, bootstrap
phase4_ml/            severity classifier (scikit-learn)
phase5_orchestration/ FastAPI server, dashboard, Claude cards, Telegram push
phase7_monitor/       always-on monitor, pharmacist alerts, follow-up tables
patient/              SuperShield Patient (worker, dashboard, matcher, notifier)
shared/fda/           shared synthetic recall feed + injector (openFDA shape)
docs/INTEGRATION.md   shared data contract between the two workflows
```

---

## Verified results

| Check | Result |
|---|---|
| Live openFDA pull (120-day window, Oct 22, 2026) | 290 recalls |
| Automatic NDC matching (materialized view) | 136,209 customer matches across all 51 states |
| New recall → pharmacist alert on Telegram | **13 s**, no human trigger |
| Synthetic recall cohort | 257 customers at 253 pharmacies in 43 states |
| Claude alert card | generated by `claude-opus-5-5` in about 12 s, counts only |
| Patient: injected recall → in-app alert | about 70 s (one 60 s worker cycle), no pharmacist action |

---

## What's next

- **Lot-level verification:** capture lot numbers at dispensing so candidate matches become
  confirmed ones.
- **Real pharmacy integrations** in place of synthetic data.
- **Label scanning** to add medications from a photo of the bottle.
- **More channels:** SMS and WhatsApp for patients, plus caregiver alerts for elderly family members.
- **Beyond drugs:** the same pipeline works for medical device and food recalls.

---

### Data sources

- [openFDA Drug Enforcement API](https://open.fda.gov/apis/drug/enforcement/): live recall
  data and the 2025/2026 counts (queried Oct 22, 2026).
- CDC artificial-tears outbreak coverage: [Fortune](https://fortune.com/well/2023/03/22/eye-drops-recall-ezricare-artificial-tears-outbreak),
  [CBS News](https://www.cbsnews.com/amp/sacramento/news/two-additional-deaths-linked-to-bacteria-in-recalled-eye-drops-cdc-says).
- Recall communication gaps: [Pharmacy Times](https://www.pharmacytimes.com/view/fda-falls-short-in-communicating-drug-recalls),
  [JMIRx Med](https://doi.org/10.2196/68345), [GoodRx](https://www.goodrx.com/drugs/safety/recalls).

All customer and patient data in this repository is **synthetic**.
