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
        "SELECT recall_number, any(recalling_firm) FROM safetynet.fda_recalls GROUP BY recall_number"
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
        FROM safetynet.patient_alerts
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
        FROM safetynet.alert_geo_rollup
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
        "SELECT lon, lat FROM safetynet.pharmacies ORDER BY rand() LIMIT %(n)s",
        parameters={"n": sample},
    ).result_rows
    return [[round(float(r[0]), 3), round(float(r[1]), 3)] for r in rows]


def affected_pharmacy_points(recall_number: str, limit: int = 350) -> list[list[float]]:
    """[lon, lat, customers] for pharmacies hit by a recall (biggest first)."""
    rows = get_client().query(
        """
        SELECT p.lon, p.lat, count() AS c
        FROM safetynet.patient_alerts a
        INNER JOIN safetynet.pharmacies p ON a.pharmacy_id = p.pharmacy_id
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
        SELECT name, phone_number, state FROM safetynet.patient_alerts
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
        "total_recalls": int(client.command("SELECT uniqExact(recall_number) FROM safetynet.fda_recalls")),
        "total_customers_indexed": int(client.command("SELECT count() FROM safetynet.patient_ehr")),
        "total_pharmacies": int(client.command("SELECT count() FROM safetynet.pharmacies")),
        "total_alerts": int(client.command("SELECT count() FROM safetynet.patient_alerts")),
    }


def shared_recalls(limit: int = 100) -> list[dict]:
    """SuperShield shared feed: one row per recall, keyed by openFDA recall_number."""
    rows = get_client().query(
        """
        SELECT recall_number, groupUniqArray(product_ndc), any(classification), any(severity),
               any(recalling_firm), any(reason_for_recall), any(generic_name),
               any(product_description), any(report_date), any(source_url), max(ingested_at)
        FROM safetynet.fda_recalls
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
         "synthetic": r[0].startswith("DEMO-")}
        for r in rows
    ]
