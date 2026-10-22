"""End-to-end check for the unified SuperShield UI (phase5_orchestration/frontend/app/CONTRACT.md).

Calls every endpoint the UI uses (pharmacy, patient proxy, backend additions), checks
status codes and response shapes, opens the /stream WebSocket handshake, and loads /app
plus every /static/app/*.js|css file. READ-ONLY: only GET requests (no status changes,
no follow-ups, no demo recalls).

    python scripts/e2e_ui_check.py [BASE_URL]      # default http://127.0.0.1:8000

Prints a pass/fail table and exits 1 on any failure.
"""
from __future__ import annotations

import csv
import io
import json
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
APP_DIR = Path(__file__).resolve().parents[1] / "phase5_orchestration" / "frontend" / "app"

ALERT_KEYS = {"recall_number", "product_ndc", "severity", "classification", "recalling_firm",
              "reason_for_recall", "source_url", "origin", "match_type", "customers",
              "pharmacies", "states", "status", "detected_at", "updated_at", "code_info"}
CUSTOMER_KEYS = {"customer_id", "name", "phone", "pharmacy", "chain", "state", "ndc", "followup"}
FOLLOWUPS = {"contacted", "lot_verified", "not_affected", "pending"}
CSV_HEADER = ["customer_id", "name", "phone", "pharmacy", "chain", "state", "ndc", "followup"]

results: list[tuple[str, str, bool, str]] = []  # (endpoint, check, ok, detail)


class Fail(Exception):
    pass


def need(cond, msg: str) -> None:
    if not cond:
        raise Fail(msg)


def keys(obj, required: set, what: str) -> None:
    need(isinstance(obj, dict), f"{what} is {type(obj).__name__}, not object")
    missing = required - obj.keys()
    need(not missing, f"{what} missing {sorted(missing)}")


def fetch(path: str, timeout: float = 60):
    req = urllib.request.Request(BASE + path, method="GET")
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read(), time.time() - t
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read(), time.time() - t


def check(name: str, path: str, validate=None, status: int = 200, raw: bool = False):
    """GET path, require `status`, run validate(body) -> optional detail. Returns body or None."""
    try:
        code, headers, body, dt = fetch(path)
        need(code == status, f"HTTP {code} (want {status}): {body[:160]!r}")
        data = body if raw else (json.loads(body) if body else None)
        detail = (validate(data, headers) if validate else None) or ""
        results.append((path, name, True, f"{dt * 1000:.0f} ms {detail}".strip()))
        return data
    except Exception as exc:  # noqa: BLE001
        results.append((path, name, False, f"{type(exc).__name__}: {exc}"[:220]))
        return None


# ---------- pharmacy (existing) ----------

def v_monitor(d, _):
    keys(d, {"running", "last_check", "alerts_created"}, "status")


def v_stats(d, _):
    keys(d, {"total_recalls", "total_customers_indexed", "total_pharmacies", "total_alerts"}, "stats")
    return f"{d['total_recalls']} recalls"


def v_alerts(d, _):
    need(isinstance(d, list) and d, "expected a non-empty list")
    for a in d:
        keys(a, ALERT_KEYS, f"alert {a.get('recall_number')}")
        need(isinstance(a["code_info"], str), "code_info not a string")
        need(a["status"] in ("new", "reviewing", "resolved"), f"bad status {a['status']}")
    with_lots = sum(1 for a in d if a["code_info"])
    need(with_lots, "no alert has a code_info lot list (backfill not run?)")
    return f"{len(d)} alerts, {with_lots} with code_info"


def v_customers(d, _):
    keys(d, {"total", "followup_counts", "customers"}, "customers page")
    need(isinstance(d["total"], int) and d["total"] > 0, "total should be > 0")
    need(d["customers"], "empty customer page")
    for c in d["customers"]:
        keys(c, CUSTOMER_KEYS, "customer")
        need(c["followup"] in FOLLOWUPS, f"bad followup {c['followup']}")
    need(set(d["followup_counts"]) <= FOLLOWUPS, f"bad followup_counts {d['followup_counts']}")
    ids = [c["customer_id"] for c in d["customers"]]
    need(len(ids) == len(set(ids)), "duplicate customers on one page")
    return f"total {d['total']}"


def v_states(d, _):
    keys(d, {"total_customers", "total_pharmacies", "total_states", "by_state", "points"}, "states")
    for s in d["by_state"]:
        keys(s, {"state", "customers", "pharmacies"}, "by_state row")
    for p in d["points"]:
        need(isinstance(p, list) and len(p) == 3, f"bad point {p}")
    return f"{d['total_states']} states, {len(d['points'])} points"


def v_network(d, _):
    need(isinstance(d, list) and d, "expected non-empty list")
    need(all(isinstance(p, list) and len(p) == 2 for p in d), "points must be [lon, lat]")
    return f"{len(d)} points"


def v_shared(d, _):
    need(isinstance(d, list) and d, "expected non-empty list")
    for r in d:
        keys(r, {"recall_number", "product_ndcs", "classification", "recalling_firm",
                 "generic_name", "synthetic"}, "shared recall")
    return f"{len(d)} recalls"


# ---------- backend additions ----------

def v_summary(d, _):
    keys(d, {"active_recalls", "affected_customers", "affected_pharmacies", "affected_states",
             "lots_pending_verification", "followups", "notifications_prepared_pct", "network"},
         "summary")
    keys(d["followups"], FOLLOWUPS, "summary.followups")
    keys(d["network"], {"pharmacies", "customers"}, "summary.network")
    need(0 <= d["notifications_prepared_pct"] <= 100, "pct out of range")
    for k in ("active_recalls", "affected_customers", "affected_pharmacies", "affected_states",
              "lots_pending_verification"):
        need(isinstance(d[k], int) and d[k] >= 0, f"{k} not a non-negative int")
    need(d["lots_pending_verification"] ==
         d["followups"]["pending"] + d["followups"]["contacted"], "lots_pending mismatch")
    return f"{d['active_recalls']} active, {d['notifications_prepared_pct']}% prepared"


def v_search(expect: str | None):
    def v(d, _):
        keys(d, {"recalls"}, "search")
        need(len(d["recalls"]) <= 20, "more than 20 results")
        for r in d["recalls"]:
            keys(r, {"recall_number", "generic_name", "product_ndcs", "classification",
                     "recalling_firm"}, "search hit")
            need(isinstance(r["product_ndcs"], list), "product_ndcs not a list")
        if expect is None:
            need(d["recalls"] == [], "expected no results")
        else:
            need(any(r["recall_number"] == expect for r in d["recalls"]), f"{expect} not found")
        return f"{len(d['recalls'])} hits"
    return v


def v_csv(total: int):
    def v(body, headers):
        h = {k.lower(): val for k, val in headers.items()}
        need(h.get("content-type", "").startswith("text/csv"), f"content-type {h.get('content-type')}")
        need(h.get("content-disposition", "").startswith("attachment"), "no attachment disposition")
        rows = list(csv.reader(io.StringIO(body.decode("utf-8"))))
        need(rows and rows[0] == CSV_HEADER, f"header {rows[:1]}")
        need(len(rows) - 1 == total, f"{len(rows) - 1} rows, customers total is {total}")
        return f"{len(rows) - 1} rows"
    return v


# ---------- patient proxy ----------

def v_patients(d, _):
    need(isinstance(d, list), "expected list")
    for p in d:
        keys(p, {"id", "name", "drugs"}, "patient")
    return f"{len(d)} patients"


def v_has(*ks):
    def v(d, _):
        keys(d, set(ks), "response")
    return v


# ---------- static app ----------

def v_text(kind: str):
    def v(body, headers):
        need(len(body) > 0, "empty body")
        ct = {k.lower(): val for k, val in headers.items()}.get("content-type", "")
        need(kind in ct, f"content-type {ct}")
        return f"{len(body):,} B"
    return v


def check_ws() -> None:
    """Raw HTTP/1.1 upgrade on /stream; a 101 means the WebSocket route is live."""
    u = urllib.parse.urlparse(BASE)
    try:
        with socket.create_connection((u.hostname, u.port or 80), timeout=10) as s:
            s.sendall((f"GET /stream HTTP/1.1\r\nHost: {u.netloc}\r\nUpgrade: websocket\r\n"
                       "Connection: Upgrade\r\nSec-WebSocket-Key: c3VwZXJzaGllbGQtZTJlLQ==\r\n"
                       "Sec-WebSocket-Version: 13\r\n\r\n").encode())
            line = s.recv(1024).split(b"\r\n", 1)[0].decode(errors="replace")
        need(" 101 " in line + " ", line)
        results.append(("/stream", "websocket upgrade", True, line))
    except Exception as exc:  # noqa: BLE001
        results.append(("/stream", "websocket upgrade", False, f"{type(exc).__name__}: {exc}"))


def main() -> int:
    q = urllib.parse.quote
    check("monitor status", "/api/monitor/status", v_monitor)
    check("stats", "/api/stats", v_stats)
    alerts = check("alerts + code_info", "/api/pharmacy/alerts?limit=50", v_alerts) or []
    target = next((a for a in alerts if a.get("customers")), None)
    if target is None:
        results.append(("/api/pharmacy/alerts/{rn}/*", "needs an alert", False, "no alert with customers"))
    else:
        rn = q(target["recall_number"], safe="")
        page = check("customers page", f"/api/pharmacy/alerts/{rn}/customers?limit=25", v_customers)
        check("states + points", f"/api/pharmacy/alerts/{rn}/states", v_states)
        if page:
            check("customers.csv", f"/api/pharmacy/alerts/{rn}/customers.csv",
                  v_csv(page["total"]), raw=True)
            st = page["customers"][0]["state"]
            check("customers by state", f"/api/pharmacy/alerts/{rn}/customers?state={st}&limit=5",
                  v_customers)
        check("search by recall #", f"/api/search?q={rn}", v_search(target["recall_number"]))
        check("search by NDC", f"/api/search?q={q(target['product_ndc'])}",
              v_search(target["recall_number"]))
        check("search by firm (lowercase)",
              f"/api/search?q={q(target['recalling_firm'][:12].lower())}",
              v_search(target["recall_number"]))
    check("search empty q", "/api/search?q=", v_search(None))
    check("search injection-ish q", "/api/search?q=" + q("zz' OR 1=1 --"), v_search(None))
    check("csv unknown recall", "/api/pharmacy/alerts/NO-SUCH-RECALL/customers.csv", status=404)
    check("summary", "/api/pharmacy/summary", v_summary)
    check("pharmacy network", "/api/pharmacies?sample=200", v_network)
    check("shared recalls", "/api/shared/recalls?limit=20", v_shared)
    check_ws()

    patients = check("patient: patients", "/api/patient/patients", v_patients) or []
    check("patient: monitor", "/api/patient/monitor/status", v_has("running", "lastRunAt"))
    latest = check("patient: latest recalls", "/api/patient/recalls/latest", v_has("recalls"))
    check("patient: drug-check", "/api/patient/drug-check?name=levothyroxine", v_has("drug", "recalls"))
    if patients:
        check("patient: notifications",
              f"/api/patient/patients/{q(patients[0]['id'], safe='')}/notifications",
              v_has("notifications"))
    ids = [r.get("recall_number") for r in (latest or {}).get("recalls", []) if r.get("recall_number")]
    if ids:
        check("patient: recall detail", f"/api/patient/recall/{q(ids[0], safe='')}")

    html = check("app shell", "/app", v_text("text/html"), raw=True)
    assets = set(re.findall(r"/static/app/[\w.-]+\.(?:js|css)", (html or b"").decode(errors="replace")))
    if APP_DIR.exists():
        assets |= {f"/static/app/{p.name}" for p in APP_DIR.iterdir() if p.suffix in (".js", ".css")}
    for a in sorted(assets):
        check("static asset", a, v_text("css" if a.endswith(".css") else "javascript"), raw=True)

    w = max(len(r[0]) for r in results)
    print(f"\nSuperShield UI e2e check against {BASE}\n")
    print(f"{'RESULT':6}  {'ENDPOINT':{w}}  {'CHECK':28}  DETAIL")
    for path, name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL':6}  {path:{w}}  {name:28}  {detail}")
    failed = sum(1 for r in results if not r[2])
    print(f"\n{len(results) - failed}/{len(results)} passed" + (f", {failed} FAILED" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
