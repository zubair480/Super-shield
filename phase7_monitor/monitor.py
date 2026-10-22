"""Phase 7 (SuperShield Pharmacy): always-on recall monitor.

HawkSign's orchestration only ran from the "Launch live defense" button. This
loop makes it continuous:

  1. every FDA_POLL_SEC   pull new openFDA recalls into fda_recalls
                          (mv_patient_matches then matches them by NDC)
  2. every MONITOR_INTERVAL_SEC  turn each newly matched recall into a
                          pharmacist alert, push it to the pharmacist's phone
                          and replay it through the orchestrator (US map).

Every match here is an NDC *candidate*: dispensing records carry no lot number,
so the pharmacist verifies the lot per customer. Customer names / phones never
enter the event bus, the push message or any LLM prompt.
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))

from phase5_orchestration import orchestrator  # noqa: E402
from phase5_orchestration.events import Event, bus  # noqa: E402
from phase5_orchestration.tools import clickhouse_tools, real_alert  # noqa: E402
from settings import SHARED_INJECTOR  # noqa: E402

FDA_POLL_SEC = int(os.getenv("FDA_POLL_SEC", "300"))
MONITOR_INTERVAL_SEC = int(os.getenv("MONITOR_INTERVAL_SEC", "15"))
DASHBOARD_URL = os.getenv("DASHBOARD_URL", "http://127.0.0.1:8000")
# Synthetic recalls from the shared feed (shared/fda/README.md) use D-SS-####-2026.
SYNTHETIC_PREFIXES = ("D-SS-", "DEMO-")  # DEMO- = earlier pharmacy-only demo rows
# Default demo recall hits both workflows: 238 pharmacy customers fill this NDC and
# Levothyroxine is on the patient demo medication list.
DEMO_DRUG, DEMO_NDC = "Levothyroxine", "16729-447"

ALERT_COLUMNS = [
    "recall_number", "product_ndc", "severity", "classification", "recalling_firm",
    "reason_for_recall", "source_url", "origin", "match_type", "customers",
    "pharmacies", "states", "status", "detected_at", "updated_at", "push_status",
]

status: dict = {
    "running": False,
    "fda_poll_sec": FDA_POLL_SEC,
    "interval_sec": MONITOR_INTERVAL_SEC,
    "last_fda_poll": None,
    "last_fda_new": None,
    "last_fda_error": None,
    "last_check": None,
    "alerts_created": 0,
    "push_channel": real_alert.ALERT_CHANNEL if real_alert.is_configured() else "in_app_only",
}


def _client():
    return clickhouse_tools.get_client()


def _now() -> datetime:
    # tz-aware on purpose: clickhouse-connect treats naive datetimes as local time
    # on insert, but returns DateTime columns as naive UTC.
    return datetime.now(timezone.utc).replace(microsecond=0)


def _origin(recall_number: str, ingested_at: datetime, started_at: datetime) -> str:
    if recall_number.startswith(SYNTHETIC_PREFIXES):
        return "synthetic_demo"
    # Recalls already in the lakehouse when the monitor started are listed but
    # never paged, so restarts don't re-alert old recalls.
    return "backfill" if ingested_at < started_at.replace(tzinfo=None) else "live"


def unalerted_recalls() -> list[dict]:
    """Recalls the MV matched to dispensing records that have no pharmacist alert yet."""
    rows = _client().query(
        """
        SELECT a.recall_number,
               any(a.product_ndc), any(a.severity), any(a.reason_for_recall), any(a.source_url),
               count(), uniqExact(a.pharmacy_id), uniqExact(a.state),
               any(r.recalling_firm), any(r.classification), max(r.ingested_at)
        FROM safetynet.patient_alerts AS a
        LEFT JOIN safetynet.fda_recalls AS r
            ON a.recall_number = r.recall_number AND a.product_ndc = r.product_ndc
        WHERE a.recall_number NOT IN (SELECT recall_number FROM safetynet.pharmacist_alerts)
        GROUP BY a.recall_number
        """
    ).result_rows
    return [
        {"recall_number": r[0], "product_ndc": r[1], "severity": r[2], "reason_for_recall": r[3],
         "source_url": r[4], "customers": int(r[5]), "pharmacies": int(r[6]), "states": int(r[7]),
         "recalling_firm": r[8] or "Unknown", "classification": r[9] or "",
         "ingested_at": r[10]}
        for r in rows
    ]


def _insert_alert(*alerts: dict) -> None:
    _client().insert("safetynet.pharmacist_alerts",
                     [[a[c] for c in ALERT_COLUMNS] for a in alerts], column_names=ALERT_COLUMNS)


def pharmacist_message(a: dict) -> str:
    """Phone push for the pharmacist. Aggregates only - no customer identities."""
    tag = "SYNTHETIC DEMO RECALL" if a["origin"] == "synthetic_demo" else "FDA RECALL"
    return (
        f"\U0001F6A8 SuperShield Pharmacy - {tag}\n"
        f"{a['classification'] or a['severity']}: {a['recalling_firm']}, NDC {a['product_ndc']}\n"
        f"{a['reason_for_recall'][:220]}\n\n"
        f"{a['customers']:,} customers at {a['pharmacies']:,} pharmacies in {a['states']} states "
        f"filled this NDC. NDC candidate match - verify lot before contacting.\n"
        f"Recall {a['recall_number']} - review: {DASHBOARD_URL}/#pharmacy"
    )


def create_alerts(started_at: datetime) -> list[dict]:
    """Create pharmacist alerts for newly matched recalls. Returns the new alerts."""
    created = []
    for rec in unalerted_recalls():
        now = _now()
        a = {**rec, "origin": _origin(rec["recall_number"], rec["ingested_at"], started_at),
             "match_type": "ndc_candidate", "status": "new",
             "detected_at": now, "updated_at": now, "push_status": "skipped_backfill"}
        if a["origin"] != "backfill":
            push = real_alert.send_text(pharmacist_message(a))
            a["push_status"] = (f"sent:{push.get('channel')}" if push.get("sent")
                                else f"not_sent:{push.get('reason', 'unknown')}")[:200]
        created.append(a)
    if created:
        _insert_alert(*created)
    status["alerts_created"] += len(created)
    return created


async def _announce(a: dict) -> None:
    """Notify dashboards, then replay the recall through HawkSign's pipeline (map)."""
    await bus.publish(Event(stage="run_started", recall_number=a["recall_number"],
                            payload={"recalls": 1, "trigger": "monitor"}, actor="monitor"))
    await bus.publish(Event(stage="pharmacist_alert", recall_number=a["recall_number"], payload={
        k: a[k] for k in ("severity", "classification", "recalling_firm", "product_ndc",
                          "customers", "pharmacies", "states", "origin", "match_type", "push_status")
    }, actor="monitor"))
    await orchestrator.process_recall(a, demo_alert=False)
    await bus.publish(Event(stage="run_complete", recall_number=a["recall_number"],
                            payload={"recalls": 1}, actor="monitor"))


def poll_fda() -> list[str]:
    from phase2_ingest.load_to_clickhouse import ingest_new
    return ingest_new()


def poll_shared_feed() -> list[str]:
    from phase2_ingest.load_to_clickhouse import ingest_shared_feed
    return ingest_shared_feed()


async def run_forever() -> None:
    status["running"] = True
    started_at = _now()
    last_fda = 0.0
    while True:
        try:
            if time.time() - last_fda >= FDA_POLL_SEC:
                last_fda = time.time()
                try:
                    new = await asyncio.to_thread(poll_fda)
                    status.update(last_fda_new=len(new), last_fda_error=None)
                except Exception as exc:  # noqa: BLE001
                    status["last_fda_error"] = str(exc)[:300]
                status["last_fda_poll"] = _now().isoformat()

            # Local file read, so every tick: a demo recall shows up within seconds.
            try:
                await asyncio.to_thread(poll_shared_feed)
            except Exception as exc:  # noqa: BLE001
                status["last_shared_error"] = str(exc)[:300]

            created = await asyncio.to_thread(create_alerts, started_at)
            status["last_check"] = _now().isoformat()
            for a in created:
                if a["origin"] != "backfill":
                    await _announce(a)
        except Exception as exc:  # noqa: BLE001
            status["last_error"] = str(exc)[:300]
        await asyncio.sleep(MONITOR_INTERVAL_SEC)


# ---------- pharmacist dashboard queries ----------

def list_alerts(limit: int = 50) -> list[dict]:
    rows = _client().query(
        f"""
        SELECT {", ".join(ALERT_COLUMNS)}
        FROM safetynet.pharmacist_alerts FINAL
        ORDER BY origin = 'backfill', detected_at DESC,
                 multiIf(severity = 'Lethal', 3, severity = 'Moderate', 2, 1) DESC, customers DESC
        LIMIT %(n)s
        """,
        parameters={"n": limit},
    ).result_rows
    out = []
    for r in rows:
        a = dict(zip(ALERT_COLUMNS, r))
        a["detected_at"] = a["detected_at"].isoformat() + "Z"
        a["updated_at"] = a["updated_at"].isoformat() + "Z"
        out.append(a)
    return out


def set_alert_status(recall_number: str, new_status: str) -> dict | None:
    rows = [a for a in list_alerts(limit=100000) if a["recall_number"] == recall_number]
    if not rows:
        return None
    a = rows[0]
    a.update(status=new_status, updated_at=_now(),
             detected_at=datetime.fromisoformat(a["detected_at"].rstrip("Z")).replace(tzinfo=timezone.utc))
    _insert_alert(a)
    return {"recall_number": recall_number, "status": new_status}


def affected_customers(recall_number: str, state: str = "", limit: int = 100,
                       offset: int = 0) -> dict:
    """Pharmacist-only review list (contains contact details - never sent to LLMs/map)."""
    where = "a.recall_number = %(r)s" + (" AND a.state = %(s)s" if state else "")
    params = {"r": recall_number, "s": state, "n": limit, "o": offset}
    client = _client()
    total = int(client.query(f"SELECT count() FROM safetynet.patient_alerts a WHERE {where}",
                             parameters=params).result_rows[0][0])
    rows = client.query(
        f"""
        SELECT a.customer_id, a.name, a.phone_number, a.pharmacy_id, p.name, p.chain,
               a.state, a.product_ndc, f.status
        FROM safetynet.patient_alerts AS a
        LEFT JOIN safetynet.pharmacies AS p ON a.pharmacy_id = p.pharmacy_id
        LEFT JOIN (
            SELECT customer_id, argMax(status, updated_at) AS status
            FROM safetynet.customer_followups WHERE recall_number = %(r)s GROUP BY customer_id
        ) AS f ON a.customer_id = f.customer_id
        WHERE {where}
        ORDER BY a.state, a.pharmacy_id, a.customer_id
        LIMIT %(n)s OFFSET %(o)s
        """,
        parameters=params,
    ).result_rows
    followed = client.query(
        "SELECT latest, count() FROM "
        "(SELECT customer_id, argMax(status, updated_at) AS latest "
        " FROM safetynet.customer_followups WHERE recall_number = %(r)s GROUP BY customer_id) "
        "GROUP BY latest",
        parameters=params,
    ).result_rows
    return {
        "recall_number": recall_number, "total": total, "limit": limit, "offset": offset,
        "match_type": "ndc_candidate",
        "followup_counts": {r[0]: int(r[1]) for r in followed},
        "customers": [
            {"customer_id": r[0], "name": r[1], "phone": r[2], "pharmacy_id": r[3],
             "pharmacy": r[4], "chain": r[5], "state": r[6], "ndc": r[7],
             "followup": r[8] or "pending"}
            for r in rows
        ],
    }


def set_followup(recall_number: str, customer_id: str, new_status: str) -> dict:
    _client().insert("safetynet.customer_followups",
                     [[recall_number, customer_id, new_status, _now()]],
                     column_names=["recall_number", "customer_id", "status", "updated_at"])
    return {"recall_number": recall_number, "customer_id": customer_id, "status": new_status}


def inject_demo_recall(drug: str = DEMO_DRUG, ndc: str = DEMO_NDC,
                       classification: str = "Class I") -> dict:
    """Final-demo trigger: add ONE synthetic recall to the shared feed via the patient
    workflow's injector, so the pharmacy monitor and the patient worker each pick it
    up independently. Returns the new recall_number."""
    import subprocess

    if not SHARED_INJECTOR.exists():
        # shared/fda/ lives on feat/patient until the branches merge.
        return {"ok": True, "shared_feed": False, **_legacy_inject_demo_recall()}
    proc = subprocess.run(
        ["node", str(SHARED_INJECTOR), "--drug", drug, "--ndc", ndc, "--class", classification],
        capture_output=True, text=True, timeout=30,
    )
    if proc.returncode != 0:
        return {"ok": False, "reason": (proc.stderr or proc.stdout).strip()[:300]}
    recall_number = proc.stdout.strip().split()[-1]
    poll_shared_feed()
    return {"ok": True, "recall_number": recall_number, "drug": drug, "product_ndc": ndc,
            "classification": classification, "synthetic": True}


def _legacy_inject_demo_recall() -> dict:
    """Fallback until shared/fda/ is merged: insert ONE synthetic recall for a commonly dispensed NDC (final-demo trigger).

    Goes into the shared fda_recalls table like a real recall, so both the
    pharmacy MV and the patient worker can pick it up independently.
    """
    client = _client()
    ndc = client.query(
        "SELECT prescribed_ndc_code, count() c FROM safetynet.patient_ehr "
        "GROUP BY prescribed_ndc_code ORDER BY c DESC LIMIT 1"
    ).result_rows[0][0]
    known = client.query(
        "SELECT any(generic_name), any(product_description) FROM safetynet.fda_recalls "
        "WHERE product_ndc = %(n)s AND generic_name != ''",
        parameters={"n": ndc},
    ).result_rows
    generic, description = (known[0] if known and known[0][0] else ("", ""))
    rn = f"DEMO-{_now().strftime('%Y%m%d%H%M%S')}"
    row = {
        "recall_number": rn, "product_ndc": ndc,
        "reason_for_recall": "SYNTHETIC DEMO RECALL: potential microbial contamination "
                             "identified in specific lots (SuperShield demo - not an FDA recall).",
        "classification": "Class I", "severity": "Lethal", "status": "Ongoing",
        "recalling_firm": "SuperShield Demo Labs (synthetic)", "distribution_pattern": "Nationwide",
        "report_date": _now().strftime("%Y%m%d"), "source_url": "",
        "product_description": description or f"Synthetic demo product, NDC {ndc}",
        "generic_name": generic,
    }
    client.insert("safetynet.fda_recalls", [list(row.values())], column_names=list(row.keys()))
    return row
