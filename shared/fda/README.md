# Shared FDA feed (`shared/fda/`)

One FDA data contract for both SuperShield workflows.

| File | Purpose |
|---|---|
| `demo-recalls.json` | Extra recall records in **openFDA `drug/enforcement` shape**. `[]` in production. |
| `inject-recall.mjs` | Appends one synthetic recall for demos/tests (plain Node, no deps). |

## Contract

- **Same shape as openFDA.** Each record looks exactly like an item from
  `https://api.fda.gov/drug/enforcement.json` `results[]` (`recall_number`, `classification`,
  `status`, `reason_for_recall`, `product_description`, `recalling_firm`, `code_info`,
  `report_date`, `recall_initiation_date`, `center_classification_date`, `distribution_pattern`,
  `voluntary_mandated`, `openfda{brand_name, generic_name, substance_name, product_ndc[]}` ...).
  Both workflows read live openFDA **plus** this file, so a synthetic recall flows through the
  same code paths as a real one.
- **Common identifier: `recall_number`.** Pharmacy alerts and patient notifications reference the
  same `recall_number`, so the two dashboards can be cross-referenced.
- **Synthetic rows carry `"synthetic": true`** and `recalling_firm: "SuperShield Test Labs (synthetic)"`.
  Synthetic recall numbers use the `D-SS-####-2026` pattern, which never collides with real FDA
  numbers. **Any UI that shows a synthetic row must label it as synthetic/test.**

## Consumers

- **Patient (Developer 2, SuperShield Patient)** — the worker reads this file (path from
  `SHARED_RECALLS_FILE`, default `../shared/fda/demo-recalls.json` relative to `patient/`) and merges
  it with openFDA results before drug-name matching.
- **Pharmacy (Developer 1, SuperShield Pharmacy)** — load this file alongside the openFDA ingestion into
  `supershield.fda_recalls`, keyed by `(product_ndc, recall_number)` (one row per NDC in
  `openfda.product_ndc`). Matching against dispensing records by NDC then works unchanged.

## Usage

```bash
# from the repo root
node shared/fda/inject-recall.mjs --drug Metformin                         # Class II, NDC 00093-1048-01
node shared/fda/inject-recall.mjs --drug Metformin --ndc 00093-1048-01 --class "Class I"
node shared/fda/inject-recall.mjs --drug Lisinopril --ndc 68180-0513-01 --strength "10 mg"
node shared/fda/inject-recall.mjs --reset                                  # back to []
```

The script prints the new `recall_number` on stdout. The default NDC is a metformin-style NDC
string; the record is synthetic regardless.

## Honesty rules

- A synthetic record is test data, never presented as a real FDA action.
- A drug-name or NDC match is a **candidate** match; `code_info` lists lots, and only checking the
  actual package lot confirms a match.
- Commit `demo-recalls.json` as `[]`. Run `--reset` after a demo.
