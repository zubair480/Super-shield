# SuperShield showcase UIs: central coordination board

All three showcase sessions and all their sub-agents read this file first and log progress here.
Absolute path (shared by every worktree): `C:\Users\zubai\superset hackathon\Super-shield\showcase\COORDINATION.md`
Rule: only append to YOUR session's section. Never edit another section. Keep entries one line, timestamped.

Deadline: first impressive working version by **3:30 PM local**, then keep polishing.

## Shared facts (read only)

- Product: SuperShield. Two independent FDA recall workflows on one public data source.
  - Pharmacy (Developer 1, SuperShield Pharmacy, branch `feat/pharmacy`): NDC matching against 1M synthetic customers in ClickHouse, live US map, pharmacist alert + affected-customer list.
  - Patient (Developer 2, SuperShield Patient, branch `feat/patient`, folder `patient/`): saved medications, worker checks openFDA every 60s, Claude-written plain-language alert, lot-number check, ClickHouse log.
  - Demo: one new FDA recall, both sides detect it independently, neither waits for the other.
- Live data you can use from the browser:
  - openFDA (CORS ok, no key): `https://api.fda.gov/drug/enforcement.json?sort=report_date:desc&limit=100`
  - Patient API (running at http://localhost:3000, proxy `/api` to it): `/api/patients`, `/api/patients/:id/notifications`, `/api/monitor/status`, `/api/recalls/latest?limit=500`, `/api/recall/:id`
  - Pharmacy API: read `git show origin/feat/pharmacy:phase5_orchestration/server.py` for endpoints. If it is not running, show the pharmacy story with real openFDA data and label anything simulated as "Simulated".
- Honesty rules: never claim a name match proves a patient's lot is recalled; label synthetic/test data; no em dashes in copy; text sizes 14px minimum; generous padding (8pt grid).

## Sessions

| Session | Folder | Port | Concept |
|---|---|---|---|
| orbit | `showcase/orbit` | 5181 | Cinematic dark mission control, 3D Earth, scroll camera story |
| pill-lab | `showcase/pill-lab` | 5182 | Light editorial lab, 3D capsules and molecules, recalled pills crack red |
| signal | `showcase/signal` | 5183 | Neon 3D network graph, recall wave through pharmacy and patient nodes |

## orbit log

## pill-lab log

## signal log
