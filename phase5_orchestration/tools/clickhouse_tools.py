"""ClickHouse query tools for the orchestrator.

The PII-heavy work (matching, cohort resolution, dispatch) stays in the data
layer. Callers receive de-identified aggregates; raw names/phones never leave
these functions (the privacy-ready boundary).
"""
from __future__ import annotations

import sys
import threading
from functools import lru_cache
from pathlib import Path

import clickhouse_connect

ROOT = Path(__file__).resolve().parents[2]
sys.path.append(str(ROOT))
from settings import CLICKHOUSE  # noqa: E402

SEVERITY_RANK = "multiIf(sev = 'Lethal', 3, sev = 'Moderate', 2, 1)"
# pharmacies holds conflicting duplicate rows for some pharmacy_ids (7000 rows, 5000 ids);
# join through one deterministic row per id so matches don't fan out.
PHARMACIES = """(
    SELECT pharmacy_id, t.1 AS name, t.2 AS chain, t.3 AS lat, t.4 AS lon
    FROM (SELECT pharmacy_id, min((name, chain, lat, lon)) AS t
          FROM supershield.pharmacies GROUP BY pharmacy_id)
)"""


_local = threading.local()


def get_client():
    # One client per thread: clickhouse-connect sessions reject concurrent queries,
    # and the API serves requests from a thread pool while the monitor runs.
    if getattr(_local, "client", None) is None:
        cfg = dict(CLICKHOUSE)
        db = cfg.pop("database")
        _local.client = clickhouse_connect.get_client(database=db, **cfg)
    return _local.client


@lru_cache(maxsize=1)
def _firm_map() -> dict[str, str]:
    rows = get_client().query(
        "SELECT recall_number, any(recalling_firm) FROM supershield.fda_recalls GROUP BY recall_number"
    ).result_rows
    return {r[0]: r[1] for r in rows}


def list_match_recalls(limit: int = 12) -> list[dict]:
    """Distinct recalls that matched customers, most severe + widest-reaching first."""
    rows = get_client().query(
        f"""
        SELECT recall_number,
               any(severity)            AS sev,
               any(product_ndc)         AS product_ndc,
               any(reason_for_recall)   AS reason,
               any(source_url)          AS source_url,
               count()                  AS customers,
               uniqExact(state)         AS states,
               uniqExact(pharmacy_id)   AS pharmacies
        FROM supershield.patient_alerts
        GROUP BY recall_number
        ORDER BY {SEVERITY_RANK} DESC, customers DESC
        LIMIT {int(limit)}
        """
    ).result_rows
    firms = _firm_map()
    return [
        {
            "recall_number": r[0], "severity": r[1], "product_ndc": r[2],
            "reason_for_recall": r[3], "source_url": r[4],
            "customers": int(r[5]), "states": int(r[6]), "pharmacies": int(r[7]),
            "recalling_firm": firms.get(r[0], "Unknown"),
        }
        for r in rows
    ]


def cohort_summary(recall_number: str) -> dict:
    """De-identified per-state rollup for one recall (powers the US map)."""
    client = get_client()
    rows = client.query(
        """
        SELECT state,
               countMerge(affected_customers) AS customers,
               uniqMerge(affected_pharmacies) AS pharmacies
        FROM supershield.alert_geo_rollup
        WHERE recall_number = %(r)s
        GROUP BY state ORDER BY customers DESC
        """,
        parameters={"r": recall_number},
    ).result_rows
    by_state = [{"state": r[0], "customers": int(r[1]), "pharmacies": int(r[2])} for r in rows]
    return {
        "recall_number": recall_number,
        "total_customers": sum(s["customers"] for s in by_state),
        "total_pharmacies": sum(s["pharmacies"] for s in by_state),
        "total_states": len(by_state),
        "by_state": by_state,
    }


@lru_cache(maxsize=1)
def pharmacy_network(sample: int = 1400) -> list[list[float]]:
    """A sampled set of [lon, lat] for ALL pharmacies - the base network layer."""
    rows = get_client().query(
        "SELECT lon, lat FROM supershield.pharmacies ORDER BY rand() LIMIT %(n)s",
        parameters={"n": sample},
    ).result_rows
    return [[round(float(r[0]), 3), round(float(r[1]), 3)] for r in rows]


def affected_pharmacy_points(recall_number: str, limit: int = 350) -> list[list[float]]:
    """[lon, lat, customers] for pharmacies hit by a recall (biggest first)."""
    rows = get_client().query(
        f"""
        SELECT p.lon, p.lat, count() AS c
        FROM supershield.patient_alerts a
        INNER JOIN {PHARMACIES} p ON a.pharmacy_id = p.pharmacy_id
        WHERE a.recall_number = %(r)s
        GROUP BY p.pharmacy_id, p.lon, p.lat
        ORDER BY c DESC LIMIT %(n)s
        """,
        parameters={"r": recall_number, "n": limit},
    ).result_rows
    return [[round(float(r[0]), 3), round(float(r[1]), 3), int(r[2])] for r in rows]


def sample_masked_recipients(recall_number: str, k: int = 3) -> list[dict]:
    """A few masked recipients purely for the dispatch log (phones masked)."""
    rows = get_client().query(
        """
        SELECT name, phone_number, state FROM supershield.patient_alerts
        WHERE recall_number = %(r)s LIMIT %(k)s
        """,
        parameters={"r": recall_number, "k": k},
    ).result_rows
    out = []
    for name, phone, state in rows:
        masked = (phone[:3] + "*****" + phone[-2:]) if phone and len(phone) > 5 else "*****"
        first = (name or "").split(" ")[0]
        out.append({"name": f"{first} {'*' * 4}", "phone": masked, "state": state})
    return out


def global_stats() -> dict:
    """Top-line numbers for the dashboard header."""
    client = get_client()
    return {
        "total_recalls": int(client.command("SELECT uniqExact(recall_number) FROM supershield.fda_recalls")),
        "total_customers_indexed": int(client.command("SELECT count() FROM supershield.patient_ehr")),
        "total_pharmacies": int(client.command("SELECT count() FROM supershield.pharmacies")),
        "total_alerts": int(client.command("SELECT count() FROM supershield.patient_alerts")),
    }


def shared_recalls(limit: int = 100) -> list[dict]:
    """SuperShield shared feed: one row per recall, keyed by openFDA recall_number."""
    rows = get_client().query(
        """
        SELECT recall_number, groupUniqArray(product_ndc), any(classification), any(severity),
               any(recalling_firm), any(reason_for_recall), any(generic_name),
               any(product_description), any(report_date), any(source_url), max(ingested_at)
        FROM supershield.fda_recalls
        GROUP BY recall_number ORDER BY max(ingested_at) DESC, any(report_date) DESC
        LIMIT %(n)s
        """,
        parameters={"n": int(limit)},
    ).result_rows
    return [
        {"recall_number": r[0], "product_ndcs": list(r[1]), "classification": r[2],
         "severity": r[3], "recalling_firm": r[4], "reason_for_recall": r[5],
         "generic_name": r[6], "product_description": r[7], "report_date": r[8],
         "source_url": r[9], "ingested_at": r[10].isoformat() + "Z",
         "synthetic": r[0].startswith(("D-SS-", "DEMO-"))}
        for r in rows
    ]


def search_recalls(q: str, limit: int = 20) -> dict:
    """Case-insensitive substring search over recall number, NDC, drug name and firm.

    NDCs also match without hyphens ("16729447" finds 16729-447). Exact recall-number
    hits rank first, then the newest reports.
    """
    q = (q or "").strip()[:100]
    if not q:
        return {"recalls": []}
    digits = q.replace("-", "").replace(" ", "")
    rows = get_client().query(
        """
        SELECT recall_number, any(generic_name), groupUniqArray(product_ndc),
               any(classification), any(recalling_firm), max(report_date)
        FROM supershield.fda_recalls
        WHERE recall_number IN (
            SELECT recall_number FROM supershield.fda_recalls
            WHERE positionCaseInsensitiveUTF8(recall_number, %(q)s) > 0
               OR positionCaseInsensitiveUTF8(product_ndc, %(q)s) > 0
               OR (%(d)s != '' AND position(replaceAll(product_ndc, '-', ''), %(d)s) > 0)
               OR positionCaseInsensitiveUTF8(generic_name, %(q)s) > 0
               OR positionCaseInsensitiveUTF8(recalling_firm, %(q)s) > 0
        ) AND recall_number != ''
        GROUP BY recall_number
        ORDER BY lower(recall_number) = lower(%(q)s) DESC, max(report_date) DESC, recall_number
        LIMIT %(n)s
        """,
        parameters={"q": q, "d": digits if digits.isdigit() else "", "n": int(limit)},
    ).result_rows
    return {"recalls": [
        {"recall_number": r[0], "generic_name": r[1], "product_ndcs": sorted(r[2]),
         "classification": r[3], "recalling_firm": r[4],
         "synthetic": r[0].startswith(("D-SS-", "DEMO-"))}
        for r in rows
    ]}


def pharmacy_summary() -> dict:
    """Pharmacy home KPIs over every pharmacist alert whose status isn't `resolved`.

    Counting unit for follow-ups is one (recall, affected customer) pair, the same unit
    the pharmacist works through in the customer list; a pair with no follow-up row
    counts as `pending`.

    - active_recalls: alerts not resolved.
    - affected_customers / affected_pharmacies / affected_states: distinct values across
      those alerts' NDC-candidate matches.
    - lots_pending_verification: pairs whose lot isn't settled yet (follow-up is
      `pending` or `contacted`, i.e. not `lot_verified` / `not_affected`).
    - notifications_prepared_pct: share (0-100, one decimal) of pairs whose follow-up
      isn't `pending`, i.e. the pharmacist has acted on that customer. 0 when no pairs.
    - network: the whole pharmacy network (all pharmacies, distinct customers on file).
    """
    client = get_client()
    active = ("SELECT recall_number FROM supershield.pharmacist_alerts FINAL "
              "WHERE status != 'resolved'")
    active_recalls = int(client.command(f"SELECT count() FROM ({active})"))
    customers, pharmacies, states = client.query(
        f"""
        SELECT uniqExact(customer_id), uniqExact(pharmacy_id), uniqExact(state)
        FROM supershield.patient_alerts WHERE recall_number IN ({active})
        """
    ).result_rows[0]
    followups = {s: 0 for s in ("contacted", "lot_verified", "not_affected", "pending")}
    for st, n in client.query(
        f"""
        SELECT if(f.latest = '', 'pending', f.latest) AS st, count()
        FROM (SELECT DISTINCT recall_number, customer_id FROM supershield.patient_alerts
              WHERE recall_number IN ({active})) AS a
        LEFT JOIN (
            SELECT recall_number, customer_id, argMax(status, updated_at) AS latest
            FROM supershield.customer_followups WHERE recall_number IN ({active})
            GROUP BY recall_number, customer_id
        ) AS f ON a.recall_number = f.recall_number AND a.customer_id = f.customer_id
        GROUP BY st
        """,
        settings={"join_use_nulls": 0},
    ).result_rows:
        followups[st] = followups.get(st, 0) + int(n)
    pairs = sum(followups.values())
    return {
        "active_recalls": active_recalls,
        "affected_customers": int(customers),
        "affected_pharmacies": int(pharmacies),
        "affected_states": int(states),
        "lots_pending_verification": followups["pending"] + followups["contacted"],
        "followups": followups,
        "notifications_prepared_pct": round(100 * (pairs - followups["pending"]) / pairs, 1)
        if pairs else 0.0,
        "network": _network_size(),
    }


@lru_cache(maxsize=1)
def _network_size() -> dict:
    # Static reference data (pharmacies + 1.2M-row dispensing table): count once per process.
    client = get_client()
    return {
        "pharmacies": int(client.command("SELECT uniqExact(pharmacy_id) FROM supershield.pharmacies")),
        "customers": int(client.command("SELECT uniqExact(customer_id) FROM supershield.patient_ehr")),
    }
