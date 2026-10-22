# 🛡️ SuperShield

**One FDA safety network, two independent shields.** SuperShield watches every FDA drug recall
around the clock and warns the people it affects automatically. Nobody has to press a Scan button.

| | Who it protects | What they get |
|---|---|---|
| **💊 SuperShield Pharmacy** | The pharmacist | Which of their customers filled the recalled product, a live U.S. map of affected pharmacies, a follow-up list, and a phone alert in **13 seconds** |
| **🧑‍⚕️ SuperShield Patient** | The patient and their caregiver | A plain-language safety alert when a medication they take is recalled, with the lot number to check, even if their pharmacy hasn't acted yet |

Both read the same live public FDA data and share the same recall ID. Neither waits for the other.

> **Pitch deck:** [`slides/supershield-pitch.html`](slides/supershield-pitch.html) (open in a browser, use ← →) ·
> **App:** `http://localhost:8000/app` once running ([Run it](#run-it)) ·
> **All people data in this repository is synthetic.**

---

## Contents

1. [How SuperShield meets the judging criteria](#how-supershield-meets-the-judging-criteria)
2. [User Value & Impact](#1-user-value--impact-25-pts)
3. [Technical Execution](#2-technical-execution-25-pts)
4. [Originality & Creativity](#3-originality--creativity-20-pts)
5. [Track Alignment & Responsible Data Use](#4-track-alignment--responsible-data-use-20-pts)
6. [Usability & Demo Clarity](#5-usability--demo-clarity-10-pts)
7. [Track requirement: Public Data APIs](#track-requirement-public-data-apis)
8. [Track requirement: Personal Agents & Data Privacy](#track-requirement-personal-agents--data-privacy)
9. [Public APIs we use, in detail](#public-apis-we-use-in-detail)
10. [Tools and libraries](#tools-and-libraries)
11. [Run it](#run-it)
12. [Live demo script (3 minutes)](#live-demo-script-3-minutes)
13. [Configuration and HTTP API](#configuration-and-http-api)
14. [Repository layout](#repository-layout)
15. [What's next](#whats-next)
16. [Sources](#sources)

---

## How SuperShield meets the judging criteria

| Criterion | Points | How we meet it | Where to see it |
|---|---|---|---|
| **User Value & Impact** | 25 | Two specific users (pharmacist, patient) and a measured problem: **765** FDA drug recall reports in 2025, **84** Class I since 2025, and a 2023 recall linked to **4 deaths and 14 people who lost their vision**. SuperShield turns a public recall into a personal warning in **13 s**. | [§1](#1-user-value--impact-25-pts), slide 1 |
| **Technical Execution** | 25 | A working, live system: openFDA → ClickHouse Cloud matching **1,000,000 prescriptions in under 1 s** (**136,209** real matches) → pharmacist alert → Telegram push in **13 s**; a patient worker re-checking every **60 s**; Claude-written alerts; an end-to-end UI check script. | [§2](#2-technical-execution-25-pts), slides 2–3 |
| **Originality & Creativity** | 20 | Recall data is public, but nobody acts on it for a specific person. SuperShield does, from two independent sides at once, and says honestly that a match is a **candidate** until the lot is checked. | [§3](#3-originality--creativity-20-pts) |
| **Track Alignment & Responsible Data Use** | 20 | Built entirely on a public API (openFDA) with its limitations documented. **No customer names or phone numbers** reach the AI, the map, the live stream or the phone push. All people data is synthetic and labelled; test recalls are labelled; simulated deliveries are never shown as sent. | [§4](#4-track-alignment--responsible-data-use-20-pts), slide 4 |
| **Usability & Demo Clarity** | 10 | One app with a Pharmacy portal and a Patient portal, a one-click demo recall, a demo reset script, and an animated 5-slide deck. | [§5](#5-usability--demo-clarity-10-pts) |

---

## 1. User Value & Impact (25 pts)

### The problem, in numbers

| Number | What it means | Source |
|---|---|---|
| **765** | FDA drug recall reports in 2025, about **2 every day** | openFDA, queried Oct 22, 2026 |
| **671** | Drug recall reports in 2026 so far (to Oct 22) | openFDA |
| **84** | Class I recalls since Jan 2025 (risk of serious harm or death), **nearly one a week** | openFDA |
| **290** | Recalls reported in the last 120 days alone | openFDA, Oct 22, 2026 |
| **81 / 4 / 14 / 4** | Infections / deaths / people who lost their vision / eye removals linked by the CDC to recalled artificial tears in 2023, across **18 states** | CDC, via Fortune and CBS News |
| **1 in 5** | Serious drug recalls where health care providers receive **no FDA communication** | Pharmacy Times |
| **0** | Lot numbers pharmacies are required to print on prescription labels, so patients can't tell if their bottle is affected | GoodRx |
| **4 per 1,000** | People who visit an emergency department for an adverse drug event each year; **27%** of those visits end in hospitalization | CDC / JAMA (NEISS-CADES) |

The FDA publishes every recall. The gap is the **last mile**: nobody is watching that feed on behalf of
one pharmacy's customers or one patient's medicine cabinet.

### Who it's for

- **The pharmacist.** Today, a recall means searching dispensing records by hand, building a call list and
  hoping nothing was missed. SuperShield does the search the moment the FDA publishes, and hands them a
  checked-off follow-up list.
- **The patient (and caregiver).** Today, a patient learns about a recall from the news, from a letter weeks
  later, or not at all. SuperShield tells them directly, in plain language, with the lot number to compare.

### Before and after

| | Today | With SuperShield |
|---|---|---|
| Pharmacist learns of a recall | Email lists, FDA website, wholesaler notices | Phone alert **13 s** after it reaches the FDA feed |
| Finding affected customers | Manual records search | Automatic: **257 customers at 253 pharmacies in 43 states** for one test recall, found in under a second |
| Following up | Spreadsheets, memory | Per-customer status: *contacted*, *lot verified*, *not affected*, with CSV export |
| Patient finds out | Maybe never | In-app safety alert within one **60 s** check cycle |
| Is my bottle affected? | Unclear | Told exactly which lot and NDC to compare, and never told their bottle is recalled unless the lot matches |

---

## 2. Technical Execution (25 pts)

### Architecture

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
            │  monitor checks every 15 s                  │
            ▼                                             ▼
   pharmacist alert + affected-customer list     Claude writes a plain-language bulletin
   live US map (D3) + Claude alert card          Safety Alerts, Lot Check, Recall Details
   📱 Telegram push to the pharmacist            optional Slack / Gmail delivery
            │                                             │
            └──────────── ClickHouse Cloud (one service) ─┘
                 shared ID: openFDA recall_number
                                   │
                    Unified web app at /app (Pharmacy | Patient)
```

### Pharmacy pipeline, step by step

1. **Poll openFDA.** Every `FDA_POLL_SEC` (300 s) the monitor fetches drug recalls reported in the last
   120 days, flattens each into one row per product NDC, and inserts only recall numbers it hasn't seen
   into `supershield.fda_recalls`. Re-runs are idempotent.
2. **Match inside the database.** A ClickHouse **materialized view** fires on every insert and joins the
   new recall against **1,000,000** synthetic prescriptions by NDC, writing every affected customer to
   `patient_alerts`. A second materialized view keeps a per-state rollup with **no personal data** for the map.
3. **Create the alert.** Every `MONITOR_INTERVAL_SEC` (15 s) the monitor turns each newly matched recall
   into a pharmacist alert, pushes a **Telegram** message, and replays the recall on the live dashboard
   (severity, cohort, map, alert card).
4. **Review.** The pharmacist works the affected-customer list (*contacted / lot verified / not affected*),
   moves the alert *new → reviewing → resolved*, and exports the list as CSV.

Recalls already in the database when the monitor starts are listed as "Earlier" and **never paged**, so
restarts don't spam the pharmacist.

### Patient pipeline, step by step

1. The patient saves their medication list once (brand or generic names).
2. A worker re-checks every saved medication against openFDA every `WORKER_INTERVAL_SEC` (60 s), matching
   on generic, brand, substance and product names, with synonym handling.
3. A new match creates **exactly one** notification per `(patient, recall_number)`, with a bulletin written
   by **Claude**: FDA source, classification, reason, and the lot/NDC to compare.
4. The **My Health** portal shows Home, Safety Alerts, a Lot Check, Medications and Help. Alerts and
   pipeline events are also written to ClickHouse.

### Verified results (measured live, Oct 22, 2026)

| Check | Result |
|---|---|
| Live openFDA pull (120-day window) | **290 recalls** |
| Automatic NDC matching (materialized view) | **136,209** customer matches across **all 50 states + DC** |
| Match speed | **1,000,000** prescriptions in **under 1 s** |
| New recall → pharmacist alert on Telegram | **13 s**, no human trigger |
| One synthetic test recall | **257** customers at **253** pharmacies in **43** states |
| Claude alert card | Generated by `claude-opus-5-5` in about 12 s, from counts only |
| Patient: injected recall → in-app alert | About **70 s** (one 60 s worker cycle), no pharmacist action |

### Engineering decisions that keep it reliable

- **Matching in the database, not the app.** One insert fans out to every affected customer with no app code.
- **Incremental, idempotent ingest.** Only new recall numbers are inserted; re-polling never creates duplicates.
- **No re-paging on restart.** Alerts for recalls that existed before startup are listed, not pushed.
- **Status as inserts.** `ReplacingMergeTree` + `FINAL` gives the latest status without `UPDATE`.
- **Thread-safe database access.** One ClickHouse client per thread, so the API and monitor never collide.
- **UTC everywhere.** Timestamps are stored and compared in UTC.
- **Graceful fallbacks.** No Claude key or a Claude outage → a deterministic template; no Telegram → the
  alert still appears in the app; no external delivery → shown as *not configured*, never as *sent*.
- **Tested.** `scripts/e2e_ui_check.py` calls every endpoint the UI uses, checks status codes and response
  shapes, opens the WebSocket, and loads every UI file (read-only). The patient workspace type-checks with
  `tsc --noEmit`. `scripts/demo_reset.py` returns everything to a clean demo state.

---

## 3. Originality & Creativity (20 pts)

| Existing approach | Limitation | What SuperShield does differently |
|---|---|---|
| FDA recall website and email lists | Everyone gets everything; nobody gets "this affects *your* patients" | Matches each recall to specific prescriptions and specific patients |
| Wholesaler and manufacturer notices | Reach the pharmacy, not the patient; often days later | Two independent channels: the pharmacist **and** the patient are warned, and neither waits on the other |
| Manual pharmacy record searches | Slow, error-prone, undocumented | Automatic search over 1M prescriptions in under a second, plus a per-customer follow-up trail |
| Generic "you're affected" alerts | Overstate risk and cause panic, or understate it | Every match is labelled a **candidate**: "verify the lot before contacting" / "compare the lot on your package" |

What's new:
- **The recall feed becomes a personal agent.** It watches on your behalf and tells you only what concerns you.
- **Two shields that never wait on each other.** A patient is protected even when the pharmacy is busy.
- **Honesty as a feature.** The system says what it knows (NDC or drug-name match) and what it doesn't (the lot).
- **Live public data, zero data cost.** openFDA and Telegram are free; the matching runs in one cloud database.

---

## 4. Track Alignment & Responsible Data Use (20 pts)

### Public data at the core

Every recall fact comes from **openFDA**, a public U.S. government API. Nothing about recalls is invented.
The deck's "Our data" slide and the table below show exactly what each field powers.

| Data point | Source | How we use it | Type |
|---|---|---|---|
| Recall ID (`recall_number`) | openFDA API | Shared ID linking pharmacy and patient alerts | Real, live |
| Drug code (NDC) | openFDA API | Matched against 1M prescriptions: 136,209 hits | Real, live |
| Drug names (generic, brand, substance) | openFDA API | Matched against each patient's saved medications | Real, live |
| Class I / II / III | openFDA API | Official risk label; also mapped to Lethal / Moderate / Minor | Real, live |
| Recall reason | openFDA API | Trains our severity model; quoted in alerts | Real, live |
| Lot list (`code_info`), firm, date | openFDA API | Tells people what to check on their bottle | Real, live |
| 5,000 pharmacies | Generated | Real chain names, all 50 states + DC; drives the map | Synthetic |
| 1,000,000 prescriptions | Generated | 18% seeded with real recalled drug codes | Synthetic |
| 32 patients | Generated | Saved medication lists that trigger patient alerts | Synthetic |

### Responsible data use: what's in place

| Practice | How it's enforced |
|---|---|
| **Data minimization to AI** | Claude receives recall facts and **counts only** (pharmacy) or recall facts and a **patient ID only** (patient). Never names, phone numbers or addresses. |
| **De-identified visuals** | The U.S. map uses a per-state rollup table with no personal fields. The live event stream carries aggregates only. |
| **Need-to-know access** | Customer names and phones appear only in the pharmacist's affected-customer view, never in the patient portal, the map or the phone push. |
| **Opt-in phone alerts** | Telegram can only message someone who started the bot themselves (`/start`). |
| **No false certainty** | Pharmacy: "Potentially affected / Needs lot check". Patient: "may be affected; check your lot". Never "your bottle is recalled", never "stop taking this medication". |
| **Honest labels** | Synthetic recalls (`D-SS-…`, `DEMO-…`) carry a "Test recall" badge. Simulated customer SMS is labelled *simulated*. A delivery shows *sent* only when an API confirmed it. |
| **Synthetic people only** | Every customer, pharmacy and patient in this repository is generated. |
| **Secrets stay local** | API keys live only in gitignored `.env` files; `.env.example` holds empty placeholders. |

---

## 5. Usability & Demo Clarity (10 pts)

- **One app, two portals** at `/app`: switch between **Pharmacy** and **Patient** from the title bar.
- **Pharmacy portal:** recall monitor dashboard (active recalls, affected customers, pharmacies, states, lots
  pending verification, follow-up progress), recall list, affected-customer list with per-customer follow-up
  and CSV export, notifications, and a U.S. map of affected pharmacies. Search finds a recall by number,
  NDC, drug or firm.
- **Patient portal ("My Health"):** home, safety alerts, a step-by-step lot check, medications and help.
- **Always-visible status:** the dashboard pill "Monitoring FDA · checked 12s ago" shows the monitor is live.
- **One-click demo:** a 🧪 **Demo recall** button and a [3-minute script](#live-demo-script-3-minutes).
- **Repeatable:** `scripts/demo_reset.py` returns everything to a clean state before each demo.
- **Pitch deck:** 5 animated slides in [`slides/supershield-pitch.html`](slides/supershield-pitch.html).

---

## Track requirement: Public Data APIs

> *Demonstrate how public data powers the solution and acknowledge data limitations.*

### How public data powers SuperShield

openFDA's Drug Enforcement API is the only source of recall facts for both workflows. Without it there is
nothing to match: the recall ID links the two sides, the NDC drives pharmacy matching, the drug names drive
patient matching, the classification sets urgency, and the lot list tells people what to check. The full
query detail is in [Public APIs we use, in detail](#public-apis-we-use-in-detail).

### Data limitations we acknowledge

| Limitation | Effect on SuperShield | How we handle it |
|---|---|---|
| **Reporting lag.** openFDA enforcement reports can trail the FDA's first action by days or weeks. | We can't be faster than the source. | We poll every 5 min, so we add minutes, not days, on top of the source's lag. |
| **Lots are free text.** Lot numbers live in `code_info` prose, and pharmacies rarely record lots at dispensing. | We can't confirm a specific bottle. | Every match is a **candidate**; the pharmacist and the patient are told to verify the lot. |
| **NDC isn't always present.** Some recall records lack `openfda.product_ndc`. | Those recalls can't be matched by NDC on the pharmacy side. | The patient side still matches them by drug name. |
| **Name matching can over-match.** The same drug from another maker or strength can match. | Possible false alarms for patients. | Patient alerts say "may be affected; compare your lot" and never "stop taking". |
| **Not an official notification channel.** openFDA is a public data service, not the FDA's alert system. | SuperShield supplements official notices; it doesn't replace them. | Every alert links to its FDA source record. |
| **No results returns HTTP 404.** openFDA returns 404 for an empty date window. | Could look like an outage. | Treated as "no new recalls", not an error. |
| **Synthetic people.** Customers, pharmacies and patients are generated. | Match counts show scale, not real exposure. | Labelled synthetic everywhere; real use needs pharmacy-system integration. |
| **Older ER data.** The national adverse-drug-event rate we cite is from 2013–2014. | Context only. | Labelled with its years and source. |

---

## Track requirement: Personal Agents & Data Privacy

> *Demonstrate a meaningful privacy or consent control in action.*

SuperShield is a pair of personal agents that watch the recall feed on someone's behalf. Privacy controls
you can see in the demo:

1. **The phone push in action.** When a recall fires, the pharmacist's Telegram message shows the drug,
   class and **counts** (for example "257 customers at 253 pharmacies"), and no customer names. The names
   stay inside the pharmacist's own review list.
2. **The map in action.** The U.S. map shows pharmacies and per-state counts only, built from a table that
   has no personal fields.
3. **The AI boundary in action.** The Claude-written alert card and patient bulletin are generated from
   recall facts and counts or a patient ID. You can read the exact inputs in
   `phase5_orchestration/tools/openui_client.py` and `patient/packages/sources/src/checkDrugSafety.ts`.
4. **Opt-in delivery.** The phone alert reaches only someone who opted in by starting the Telegram bot.

**Not built yet:** an in-app consent switch (for example "Allow AI to write my alerts" or a per-customer
"do not contact" flag). It's first on the roadmap below.

---

## Public APIs we use, in detail

### 1. openFDA Drug Enforcement API: the single source of truth

| | |
|---|---|
| Endpoint | `GET https://api.fda.gov/drug/enforcement.json` |
| Auth | None. An optional `OPENFDA_API_KEY` only raises the rate limit. |
| Used by | Both workflows |

| Purpose | Query |
|---|---|
| Pharmacy: recent recall window | `search=report_date:[YYYYMMDD TO YYYYMMDD]&sort=report_date:desc&limit=1000` |
| Patient: a saved medication | `search=<drug name>`, matched against `openfda.generic_name`, `brand_name`, `substance_name` and `product_description` |
| Patient and pharmacy: recall details | `search=recall_number:"<id>"` |
| Counts in this README | `search=report_date:[20250101 TO 20251231] AND classification:"Class I"`, reading `meta.results.total` |

Fields we rely on: `recall_number`, `classification`, `reason_for_recall`, `recalling_firm`,
`product_description`, `code_info`, `report_date`, `status`, `distribution_pattern`,
`openfda.product_ndc[]`, `openfda.generic_name[]`, `openfda.brand_name[]`.

### 2. ClickHouse Cloud: matching engine and shared store

| Database | Tables | Purpose |
|---|---|---|
| `supershield` | `fda_recalls` (ReplacingMergeTree), `pharmacies`, `patient_ehr` (1M rows), `patient_alerts`, `alert_geo_rollup` (AggregatingMergeTree), `pharmacist_alerts`, `customer_followups` | Pharmacy matching, alerts and follow-up |
| `supershield` | `mv_patient_matches`, `mv_alert_geo_rollup` | **Materialized views**: the real-time matching trigger |
| `default` | `patient_notifications`, `events` | Patient alerts and the patient worker's event log |

Accessed over HTTPS (port 8443) with `clickhouse-connect` (Python) and `@clickhouse/client` (Node).

### 3. Anthropic Claude API: human-readable alerts

| | |
|---|---|
| Endpoint | `POST https://api.anthropic.com/v1/messages` |
| Models | `claude-opus-5-5` for pharmacy alert cards, `claude-sonnet-5-5` for patient bulletins |
| Inputs | Recall facts plus counts (pharmacy) or a patient ID (patient). No names. |
| Fallback | A deterministic template when no key is set or the API is unavailable |

### 4. Telegram Bot API: the pharmacist's phone push

| | |
|---|---|
| Endpoints | `getMe` (validate the token), `getUpdates` (find the chat ID after `/start`), `sendMessage` |
| Auth | A bot token from **@BotFather** |
| Cost | Free |

### 5. Optional delivery and gateway

| Service | Where | What it does | Without it |
|---|---|---|---|
| **Composio** (Slack / Gmail) | Patient | Sends alerts to a Slack channel or inbox | Shown as `not_configured`; with `DRY_RUN=true`, `simulated` |
| **TrueFoundry AI Gateway** | Patient | OpenAI-compatible gateway with a prompt registry | Claude is called directly |

### 6. Public CDNs and map data

| Asset | Source | Used for |
|---|---|---|
| U.S. state boundaries (`us-atlas@3/states-10m.json`) | jsDelivr | Pharmacy map |
| React 18, htm, D3 v7, topojson-client | unpkg / jsDelivr | The `/app` UI and dashboard, with no build step |
| World boundaries (`world-atlas`), three.js | npm | Patient globe of recall locations |

---

## Tools and libraries

| Layer | Pharmacy (Python) | Patient (TypeScript) |
|---|---|---|
| API server | **FastAPI** + **Uvicorn**, WebSocket live trace | Node + **Express** / Vite dev server |
| UI | React 18 (UMD + htm), **D3** map, unified `/app` shell | **React** + **Vite**, **three.js** globe |
| Data | **clickhouse-connect**, **pandas**, **NumPy** | **@clickhouse/client** |
| ML | **scikit-learn** severity classifier (TF-IDF → SVD → logistic regression), **joblib** | Drug-name and synonym matcher |
| Synthetic data | **Faker**: 5,000 pharmacies, 1,000,000 prescriptions, 50 states + DC | 32 demo patients, shared synthetic recall feed |
| AI | **anthropic** SDK | Anthropic Messages API |
| Delivery | **requests** → Telegram Bot API | **@composio/core** (optional) |
| Runtime | Python 3.12, `python-dotenv` | Node 20+, `tsx`, TypeScript |

Deliberately left out: Docker, a second database, a second login system, an agent framework and an ETL
framework.

---

## Run it

### Prerequisites

- Python 3.12 and Node.js 20+
- A **ClickHouse Cloud** service (the free trial is enough)
- Optional: an Anthropic API key and a Telegram bot

### SuperShield Pharmacy (and the unified app)

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt       # macOS/Linux: .venv/bin/pip
cp .env.example .env                                  # ClickHouse, Anthropic, Telegram

# one-time: synthetic network, schema, live recalls
.venv/Scripts/python phase1_data/fetch_seed_ndcs.py
.venv/Scripts/python phase1_data/generate_pharmacies.py
.venv/Scripts/python phase1_data/generate_customers.py
.venv/Scripts/python phase3_lakehouse/clickhouse_bootstrap.py
.venv/Scripts/python phase2_ingest/load_to_clickhouse.py

# dashboard + always-on monitor
.venv/Scripts/python -m uvicorn phase5_orchestration.server:app --port 8000
```

Open <http://localhost:8000/app>.

### SuperShield Patient

```bash
cd patient
npm install
cp .env.example .env          # add ANTHROPIC_API_KEY for Claude bulletins
npm run dashboard:build
npm run dev                   # worker + dashboard on :3000
```

The unified app reaches the patient service through `/api/patient/…` on port 8000.

### Check it

```bash
python scripts/e2e_ui_check.py          # read-only check of every endpoint and UI file
python scripts/demo_reset.py            # clean demo state (needs both servers running)
```

---

## Live demo script (3 minutes)

1. **Reset.** Run `python scripts/demo_reset.py`. The patient portal starts with zero alerts.
2. **Show the problem (30 s).** Slide 1: 765 recalls a year, the artificial-tears outbreak.
3. **Trigger one recall (10 s).** Click **🧪 Demo recall**, or run
   `node shared/fda/inject-recall.mjs --drug Levothyroxine --ndc 16729-447 --class "Class I"`.
   The recall is synthetic and labelled "Test recall".
4. **Pharmacy (60 s).** Within ~15 s the dashboard shows the alert, the map lights up, and the phone
   buzzes on Telegram. Open the affected-customer list, mark one customer *lot verified*, export the CSV.
5. **Patient (60 s).** Switch to **Patient**. Within one 60 s cycle a safety alert appears, written by
   Claude, with the lot check. No pharmacist action was needed.
6. **Privacy (20 s).** Show the Telegram message: counts only, no names. Show the map: no personal data.
7. **Clean up.** `node shared/fda/inject-recall.mjs --reset`.

---

## Configuration and HTTP API

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

**Pharmacy HTTP API (port 8000)**

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/monitor/status` | Monitor health: last FDA poll, last check, push channel |
| GET | `/api/pharmacy/summary` | Dashboard totals: active recalls, affected customers/pharmacies/states, lots pending, follow-up progress |
| GET | `/api/pharmacy/alerts` | Pharmacist alerts (live, test and earlier), with FDA lot lists |
| POST | `/api/pharmacy/alerts/{recall_number}/status` | `new` / `reviewing` / `resolved` |
| GET | `/api/pharmacy/alerts/{recall_number}/customers` | Paginated affected-customer list |
| GET | `/api/pharmacy/alerts/{recall_number}/customers.csv` | The same list as CSV |
| POST | `/api/pharmacy/alerts/{recall_number}/customers/{customer_id}` | `contacted` / `lot_verified` / `not_affected` |
| GET | `/api/pharmacy/alerts/{recall_number}/states` | Per-state counts for the map |
| GET | `/api/search?q=` | Find a recall by number, NDC, drug or firm |
| POST | `/api/demo/recall` | Inject one synthetic recall |
| GET | `/api/shared/recalls` | Recall feed without any customer data |
| GET | `/app` · `/api/patient/…` · WS `/stream` | Unified UI, patient proxy, live event stream |

---

## Repository layout

```
phase1_data/          synthetic pharmacies + 1M prescriptions (Faker), seed NDCs from openFDA
phase2_ingest/        openFDA → ClickHouse loader (direct HTTP, incremental)
phase3_lakehouse/     ClickHouse schema, materialized views, bootstrap
phase4_ml/            severity classifier (scikit-learn)
phase5_orchestration/ FastAPI server, unified /app UI, dashboard, Claude cards, Telegram push
phase7_monitor/       always-on monitor, pharmacist alerts, follow-up tables
patient/              SuperShield Patient: worker, My Health portal, matcher, notifier
shared/fda/           shared synthetic recall feed + injector (openFDA shape)
scripts/              demo_reset.py, e2e_ui_check.py
slides/               5-slide animated pitch deck
docs/INTEGRATION.md   shared data contract between the two workflows
```

---

## What's next

1. **Consent controls in the app:** "Allow AI to write my alerts" and "External notifications" switches for
   patients, and a per-customer "do not contact" flag for pharmacists that keeps them counted but off the
   outreach list.
2. **Lot-level verification:** capture lot numbers at dispensing so candidate matches become confirmed.
3. **Real pharmacy integrations** in place of synthetic data.
4. **Label scanning:** add medications from a photo of the bottle.
5. **More channels:** SMS and WhatsApp for patients, and caregiver alerts for elderly family members.
6. **Beyond drugs:** the same pipeline works for medical device and food recalls.

### Business model

About **51,000** U.S. retail pharmacies (NCPA counts **18,988** independents, **37%** of the total) ×
**$49** per pharmacy per month ≈ **$30M a year** if every U.S. pharmacy subscribed. Recall data and
phone delivery cost **$0**.

---

## Sources

- [openFDA Drug Enforcement API](https://open.fda.gov/apis/drug/enforcement/): live recall data and all
  2025/2026 counts (queried Oct 22, 2026).
- CDC artificial-tears outbreak: [Fortune](https://fortune.com/well/2023/03/22/eye-drops-recall-ezricare-artificial-tears-outbreak),
  [CBS News](https://www.cbsnews.com/amp/sacramento/news/two-additional-deaths-linked-to-bacteria-in-recalled-eye-drops-cdc-says).
- Recall communication gaps: [Pharmacy Times](https://www.pharmacytimes.com/view/fda-falls-short-in-communicating-drug-recalls),
  [JMIRx Med](https://doi.org/10.2196/68345), [GoodRx](https://www.goodrx.com/drugs/safety/recalls).
- Adverse drug events: [CDC / JAMA study](https://stacks.cdc.gov/view/cdc/78305).
- Pharmacy counts: [NCPA 2026 Digest](https://www.pharmacytimes.com/view/ncpa-releases-2026-digest-report).
