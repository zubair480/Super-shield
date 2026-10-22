# SuperShield unified UI: build contract

One product, two portals, served by the pharmacy FastAPI server at **http://localhost:8000/app**.
The design reference is the mockup the user shared: a dark-navy-sidebar **Pharmacy** portal and a
light **My Health** patient portal. Three sessions build in parallel; this file says who owns what.

## Running it

```bash
.venv/Scripts/python -m uvicorn phase5_orchestration.server:app --port 8000   # pharmacy API + this app
npm --prefix patient run dev                                                  # patient API on :3000
```

Open `http://localhost:8000/app#/pharmacy` or `#/patient`. The patient API is reached through
`/api/patient/*` on :8000 (same-origin proxy), so the browser only ever talks to :8000.

## File ownership (do not edit files you don't own)

| Owner | Files |
|---|---|
| Foundation (lead session) | `index.html`, `shell.js`, `api.js`, `ui.js`, `app.css`, this file |
| Pharmacy UI session | `pharmacy.js`, `pharmacy.css` |
| Patient UI session | `patient.js`, `patient.css` |
| Backend session | `phase5_orchestration/server.py` (only the new routes listed below), `phase5_orchestration/tools/clickhouse_tools.py`, `phase7_monitor/monitor.py`, `phase2_ingest/load_to_clickhouse.py`, `scripts/e2e_ui_check.py` |

Need something from a file you don't own? Message the lead session instead of editing it.

## Globals (from the foundation)

- `SS.html`: htm bound to React (`html\`<${Comp} />\``). React 18 UMD, d3 v7, topojson v3 are loaded.
- `SS.api.pharmacy.*`, `SS.api.patient.*`, `SS.api.stream(onEvent)`: see `api.js`. Never call `fetch` directly.
- `SS.ui`: `Icon` (Tabler outline icons, `name="alert-triangle"`), `Badge`, `ClassBadge`, `SyntheticBadge`,
  `LivePill`, `Kpi`, `Empty`, `Spinner`, `ErrorNote`, `toast(msg, tone)`, `usePoll(loader, ms, deps)`,
  `fmt`, `pct`, `ago`, `isSynthetic`, `classOf`, `riskOf`.
- `SS.register("pharmacy" | "patient", Component)`; the component receives `{ route, navigate }`.
  `route = { portal, page, id, query }` from `#/<portal>/<page>/<id>`. Navigate with `navigate("pharmacy/customers/D-0788-2026")`.
- CSS: shared tokens (`--ss-*`) and classes (`ss-card`, `ss-btn`, `ss-badge`, `ss-table`, ...) live in `app.css`.
  Portal CSS must scope every rule under `.ss-portal-pharmacy` / `.ss-portal-patient`.

## Honesty rules (non-negotiable, same as the rest of SuperShield)

- Show the **FDA classification** (`Class I/II/III`) as the official risk label. ML severity may appear
  only labelled "Model estimate". Never derive a class from severity.
- Pharmacy matches are **NDC candidates**: say "Potentially affected" / "Needs lot check", never "Confirmed".
  "Lot verified" appears only when a pharmacist set that follow-up.
- Patient matches are **name matches**: say "may be affected; check your lot". Never tell a patient to stop a medication.
- Synthetic recalls (`D-SS-…`, `DEMO-…`) always show the "Test recall" badge.
- No fake numbers or photos. Every number on screen comes from an API. If the API lacks it, omit the widget
  or show it as unavailable. Use icons, not stock photos of pills or buildings.
- Customer names and phones appear only in the pharmacist's affected-customer views, never in the patient portal or map.

## API surface

Existing (pharmacy, :8000): `GET /api/monitor/status`, `GET /api/stats`, `GET /api/pharmacy/alerts`,
`POST /api/pharmacy/alerts/{rn}/status {status: new|reviewing|resolved}`,
`GET /api/pharmacy/alerts/{rn}/customers?state&limit&offset` → `{total, followup_counts, customers:[{customer_id,name,phone,pharmacy,chain,state,ndc,followup}]}`,
`POST /api/pharmacy/alerts/{rn}/customers/{customer_id} {status: contacted|lot_verified|not_affected|pending}`,
`GET /api/pharmacy/alerts/{rn}/states` → `{total_customers,total_pharmacies,total_states,by_state:[{state,customers,pharmacies}],points:[[lon,lat,customers]]}`,
`GET /api/pharmacies` → `[[lon,lat]]`, `GET /api/shared/recalls`, `POST /api/demo/recall`, `WS /stream`.

Existing (patient, via proxy): `GET /api/patient/patients`, `POST /api/patient/patients {name, drugs}`,
`PUT /api/patient/patients/{id}/drugs {drugs}`, `GET /api/patient/patients/{id}/notifications`,
`GET /api/patient/monitor/status`, `GET /api/patient/recall/{id}`, `GET /api/patient/drug-check?name=`,
`GET /api/patient/recalls/latest`.

**To be added by the backend session** (UI sessions: call them through `SS.api`, handle a 404 gracefully until merged):

- `GET /api/pharmacy/summary` → `{active_recalls, affected_customers, affected_pharmacies, affected_states, lots_pending_verification, followups: {contacted, lot_verified, not_affected, pending}, notifications_prepared_pct, network: {pharmacies, customers}}`, computed over alerts whose status isn't `resolved`.
- `code_info` (FDA lot list) on each pharmacy alert in `GET /api/pharmacy/alerts` (add the column to `fda_recalls`, backfill it from openFDA and the shared feed).
- `GET /api/search?q=` → `{recalls:[{recall_number, generic_name, product_ndcs, classification, recalling_firm}]}` matching recall number, NDC, drug or firm.
- `GET /api/pharmacy/alerts/{rn}/customers.csv` → CSV download of the affected-customer list.
