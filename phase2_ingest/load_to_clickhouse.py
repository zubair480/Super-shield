"""Phase 2: Load openFDA recalls (direct openFDA HTTP) into ClickHouse.

Flattens the nested openFDA records, maps classification -> severity, expands
multi-NDC recalls into one row per product_ndc, and inserts into fda_recalls.
Each insert fires the materialized view -> patient_alerts (the matching engine).

Re-running is incremental: only recall_numbers not already in fda_recalls are
inserted, and ReplacingMergeTree dedups on (product_ndc, recall_number).
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.append(str(ROOT))
from settings import CLASSIFICATION_TO_SEVERITY, OPENFDA_ENFORCEMENT, SHARED_RECALLS_FILE  # noqa: E402
from phase3_lakehouse.clickhouse_bootstrap import get_client  # noqa: E402

COLUMNS = [
    "recall_number", "product_ndc", "reason_for_recall", "classification",
    "severity", "status", "recalling_firm", "distribution_pattern",
    "report_date", "source_url", "product_description", "generic_name", "code_info",
]


def flatten(record: dict) -> list[list]:
    """One openFDA recall -> one row per product_ndc."""
    openfda = record.get("openfda") or {}
    ndcs = openfda.get("product_ndc") or []
    if not ndcs:
        return []
    classification = record.get("classification") or ""
    severity = CLASSIFICATION_TO_SEVERITY.get(classification, "Minor")
    recall_number = record.get("recall_number") or ""
    source_url = f"{OPENFDA_ENFORCEMENT}?search=recall_number:{recall_number}"
    base = [
        recall_number, None,
        record.get("reason_for_recall") or "",
        classification, severity,
        record.get("status") or "",
        record.get("recalling_firm") or "",
        record.get("distribution_pattern") or "",
        record.get("report_date") or "",
        source_url,
        record.get("product_description") or "",
        ", ".join(openfda.get("generic_name") or []),
        record.get("code_info") or "",
    ]
    rows = []
    for ndc in ndcs:
        row = list(base)
        row[1] = ndc
        rows.append(row)
    return rows


def main() -> None:
    if "--backfill-code-info" in sys.argv:
        backfill_code_info()
    else:
        ingest_new()


def fetch_records() -> list[dict]:
    """openFDA records for the ingestion window (direct HTTP; no PyAirbyte)."""
    return fetch_direct()


def fetch_direct(lookback_days: int = 120) -> list[dict]:
    """Recent openFDA drug recalls (last `lookback_days`), as a plain HTTP read."""
    from datetime import datetime, timedelta, timezone

    import requests
    from settings import OPENFDA_API_KEY

    now = datetime.now(timezone.utc)
    start = (now - timedelta(days=lookback_days)).strftime("%Y%m%d")
    params = {"search": f"report_date:[{start} TO {now.strftime('%Y%m%d')}]",
              "sort": "report_date:desc", "limit": 1000}
    if OPENFDA_API_KEY:
        params["api_key"] = OPENFDA_API_KEY
    resp = requests.get(OPENFDA_ENFORCEMENT, params=params, timeout=60)
    if resp.status_code == 404:
        return []
    resp.raise_for_status()
    return resp.json().get("results", [])


def _insert_new(rows: list[list]) -> list[str]:
    """Insert rows whose recall_number isn't ingested yet; return the new recall_numbers."""
    if not rows:
        print("No NDC-bearing recalls to load.")
        return []

    client = get_client()

    # Incremental at the warehouse boundary: only insert recalls we haven't
    # ingested yet. This keeps re-syncs idempotent and prevents the MV from
    # fanning out duplicate patient alerts.
    existing = {
        r[0] for r in client.query(
            "SELECT DISTINCT recall_number FROM supershield.fda_recalls"
        ).result_rows
    }
    new_rows = [r for r in rows if r[0] not in existing]
    skipped = len(rows) - len(new_rows)

    if not new_rows:
        print(f"No new recalls (skipped {skipped} already-ingested rows). Up to date.")
        return []

    client.insert("supershield.fda_recalls", new_rows, column_names=COLUMNS)
    print(f"Inserted {len(new_rows)} NEW recall-NDC rows "
          f"(skipped {skipped} already-ingested).")

    n_recalls = client.command("SELECT count() FROM supershield.fda_recalls")
    n_alerts = client.command("SELECT count() FROM supershield.patient_alerts")
    n_states = client.command("SELECT uniqExact(state) FROM supershield.patient_alerts")
    print(f"  fda_recalls rows: {n_recalls}")
    print(f"  patient_alerts (auto-matched via MV): {n_alerts}")
    print(f"  states with alerts: {n_states}")
    return sorted({r[0] for r in new_rows})


def ingest_new() -> list[str]:
    """Run one incremental sync; return the recall_numbers inserted this run."""
    records = fetch_records()
    print(f"Flattening {len(records)} recalls...")

    rows: list[list] = []
    for rec in records:
        rows.extend(flatten(rec))
    return _insert_new(rows)


def _product_ndc(ndc: str) -> str:
    """Package NDC (labeler-product-package) -> product NDC, the form dispensing records use."""
    parts = ndc.split("-")
    return "-".join(parts[:2]) if len(parts) == 3 else ndc


def read_shared_feed() -> list[dict]:
    """Synthetic recalls from shared/fda/demo-recalls.json (the patient workflow's contract)."""
    import json

    if not SHARED_RECALLS_FILE.exists():
        return []
    try:
        records = json.loads(SHARED_RECALLS_FILE.read_text(encoding="utf-8") or "[]")
    except ValueError:
        return []
    return records if isinstance(records, list) else []


def ingest_shared_feed() -> list[str]:
    """Load new shared-feed recalls into fda_recalls, same path as live openFDA."""
    rows: list[list] = []
    for rec in read_shared_feed():
        openfda = dict(rec.get("openfda") or {})
        openfda["product_ndc"] = [_product_ndc(n) for n in openfda.get("product_ndc") or []]
        for row in flatten({**rec, "openfda": openfda}):
            row[COLUMNS.index("source_url")] = "shared/fda/demo-recalls.json (synthetic)"
            rows.append(row)
    if not rows:
        return []
    return _insert_new(rows)


def fetch_by_recall_numbers(recall_numbers: list[str], batch: int = 40) -> list[dict]:
    """openFDA records for specific recall numbers (OR-search in batches)."""
    import requests
    from settings import OPENFDA_API_KEY

    out: list[dict] = []
    for i in range(0, len(recall_numbers), batch):
        chunk = recall_numbers[i:i + batch]
        params = {"search": "recall_number:(" + " ".join(f'"{rn}"' for rn in chunk) + ")",
                  "limit": 1000}
        if OPENFDA_API_KEY:
            params["api_key"] = OPENFDA_API_KEY
        resp = requests.get(OPENFDA_ENFORCEMENT, params=params, timeout=60)
        if resp.status_code == 404:
            continue
        resp.raise_for_status()
        out.extend(resp.json().get("results", []))
    return out


def backfill_code_info() -> dict:
    """Fill code_info for already-ingested recalls (openFDA + shared feed).

    Uses an ALTER ... UPDATE mutation, never a re-insert: re-inserting would fire
    mv_patient_matches and duplicate patient_alerts. Only rows with an empty
    code_info are touched, so this is safe to re-run.
    """
    client = get_client()
    missing = [r[0] for r in client.query(
        "SELECT DISTINCT recall_number FROM supershield.fda_recalls WHERE code_info = ''"
    ).result_rows]
    lots: dict[str, str] = {}
    for rec in read_shared_feed():
        if rec.get("recall_number") in missing and rec.get("code_info"):
            lots[rec["recall_number"]] = rec["code_info"]
    real = [rn for rn in missing
            if rn and rn not in lots and not rn.startswith(("D-SS-", "DEMO-"))]
    for rec in fetch_by_recall_numbers(real):
        if rec.get("recall_number") in missing and rec.get("code_info"):
            lots[rec["recall_number"]] = rec["code_info"]
    if lots:
        keys = sorted(lots)
        client.command(
            "ALTER TABLE supershield.fda_recalls "
            "UPDATE code_info = transform(recall_number, %(k)s, %(v)s, code_info) "
            "WHERE code_info = '' AND has(%(k)s, recall_number)",
            parameters={"k": keys, "v": [lots[k] for k in keys]},
            settings={"mutations_sync": 2},
        )
    result = {"missing": len(missing), "filled": len(lots),
              "still_empty": sorted(set(missing) - set(lots))}
    print(f"code_info backfill: {result['filled']} of {result['missing']} recalls filled; "
          f"no lot list for {len(result['still_empty'])}")
    return result


if __name__ == "__main__":
    main()
