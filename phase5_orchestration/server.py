"""FastAPI backend: REST + WebSocket live trace + static frontend.

Run:
    .venv/bin/uvicorn phase5_orchestration.server:app --reload --port 8000
"""
from __future__ import annotations

import asyncio
import os
import re
import sys
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))

from phase5_orchestration import orchestrator  # noqa: E402
from phase5_orchestration.events import bus  # noqa: E402
from phase5_orchestration.tools import clickhouse_tools  # noqa: E402
from phase7_monitor import monitor  # noqa: E402

ALERT_STATUSES = ("new", "reviewing", "resolved")
FOLLOWUP_STATUSES = ("contacted", "lot_verified", "not_affected", "pending")


class StatusBody(BaseModel):
    status: str


FRONTEND = Path(__file__).resolve().parent / "frontend"

app = FastAPI(title="SuperShield")

_run_lock = asyncio.Lock()


@app.on_event("startup")
async def _start_monitor():
    # SuperShield: continuous monitoring - no button press needed.
    if os.getenv("MONITOR_ENABLED", "true").lower() != "false":
        asyncio.create_task(monitor.run_forever())


@app.get("/api/monitor/status")
async def monitor_status():
    return monitor.status


@app.get("/api/pharmacy/alerts")
async def pharmacy_alerts(limit: int = 50):
    return await asyncio.to_thread(monitor.list_alerts, limit)


@app.post("/api/pharmacy/alerts/{recall_number}/status")
async def pharmacy_alert_status(recall_number: str, body: StatusBody):
    if body.status not in ALERT_STATUSES:
        return JSONResponse({"error": f"status must be one of {ALERT_STATUSES}"}, status_code=400)
    res = await asyncio.to_thread(monitor.set_alert_status, recall_number, body.status)
    return res or JSONResponse({"error": "unknown recall"}, status_code=404)


@app.get("/api/pharmacy/alerts/{recall_number}/customers")
async def pharmacy_customers(recall_number: str, state: str = "", limit: int = 100, offset: int = 0):
    return await asyncio.to_thread(monitor.affected_customers, recall_number, state,
                                   min(limit, 500), offset)


@app.post("/api/pharmacy/alerts/{recall_number}/customers/{customer_id}")
async def pharmacy_followup(recall_number: str, customer_id: str, body: StatusBody):
    if body.status not in FOLLOWUP_STATUSES:
        return JSONResponse({"error": f"status must be one of {FOLLOWUP_STATUSES}"}, status_code=400)
    return await asyncio.to_thread(monitor.set_followup, recall_number, customer_id, body.status)


@app.get("/api/pharmacy/summary")
async def pharmacy_summary():
    """Home KPIs over unresolved alerts (definitions in clickhouse_tools.pharmacy_summary)."""
    return await asyncio.to_thread(clickhouse_tools.pharmacy_summary)


@app.get("/api/pharmacy/alerts/{recall_number}/customers.csv")
async def pharmacy_customers_csv(recall_number: str):
    """Full affected-customer list as a CSV download (pharmacist-only; contains contacts)."""
    page = await asyncio.to_thread(monitor.affected_customers, recall_number, "", 1)
    if not page["total"]:
        return JSONResponse({"error": "no affected customers for this recall"}, status_code=404)
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", recall_number)
    return StreamingResponse(
        monitor.affected_customers_csv(recall_number), media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="affected-customers-{safe}.csv"'})


@app.get("/api/search")
async def search(q: str = ""):
    """Recall lookup by recall number, NDC, drug name or firm (max 20)."""
    return await asyncio.to_thread(clickhouse_tools.search_recalls, q, 20)


@app.post("/api/demo/recall")
async def demo_recall(drug: str = monitor.DEMO_DRUG, ndc: str = monitor.DEMO_NDC,
                      classification: str = "Class I"):
    """Final-demo trigger: one SYNTHETIC recall into the shared feed (shared/fda), which
    both the pharmacy monitor and the patient worker read independently."""
    return await asyncio.to_thread(monitor.inject_demo_recall, drug, ndc, classification)


@app.get("/api/shared/recalls")
async def shared_recalls(limit: int = 100):
    """Shared FDA feed for the patient workflow (no pharmacy/customer data)."""
    return await asyncio.to_thread(clickhouse_tools.shared_recalls, limit)


@app.get("/api/stats")
async def stats():
    return clickhouse_tools.global_stats()


@app.get("/api/recalls")
async def recalls(limit: int = 12):
    return clickhouse_tools.list_match_recalls(limit=limit)


@app.get("/api/pharmacies")
async def pharmacies(sample: int = 1400):
    return clickhouse_tools.pharmacy_network(sample=sample)


@app.post("/api/run")
async def run(limit: int = 8):
    if _run_lock.locked():
        return JSONResponse({"status": "already_running"}, status_code=409)

    async def _runner():
        async with _run_lock:
            await orchestrator.run(limit=limit)

    asyncio.create_task(_runner())
    return {"status": "started", "limit": limit}


@app.websocket("/stream")
async def stream(ws: WebSocket):
    await ws.accept()
    q = bus.subscribe()
    try:
        # Replay current run so refreshes / late joiners catch up to live state.
        for past in list(bus.history):
            await ws.send_json(past)
        while True:
            event = await q.get()
            await ws.send_json(event)
    except WebSocketDisconnect:
        pass
    finally:
        bus.unsubscribe(q)


# ---------- unified SuperShield app (pharmacy + patient portals) ----------

PATIENT_API = os.getenv("PATIENT_API_URL", "http://127.0.0.1:3000").rstrip("/")


@app.get("/api/pharmacy/alerts/{recall_number}/states")
async def alert_states(recall_number: str):
    """De-identified per-state rollup + affected pharmacy points for one recall (map)."""
    summary = await asyncio.to_thread(clickhouse_tools.cohort_summary, recall_number)
    summary["points"] = await asyncio.to_thread(clickhouse_tools.affected_pharmacy_points,
                                                recall_number)
    return summary


@app.api_route("/api/patient/{path:path}", methods=["GET", "POST", "PUT"])
async def patient_proxy(path: str, request: Request):
    """Same-origin pass-through to the patient workflow's API (runs on its own server)."""
    import requests

    body = await request.body()

    def _forward():
        return requests.request(
            request.method, f"{PATIENT_API}/api/{path}", params=dict(request.query_params),
            data=body or None, headers={"Content-Type": "application/json"}, timeout=30)

    try:
        resp = await asyncio.to_thread(_forward)
    except requests.RequestException:
        return JSONResponse({"error": "patient service unreachable", "url": PATIENT_API},
                            status_code=502)
    return Response(resp.content, status_code=resp.status_code,
                    media_type=resp.headers.get("Content-Type", "application/json"))


@app.get("/app")
async def unified_app():
    return FileResponse(FRONTEND / "app" / "index.html")


@app.get("/")
async def index():
    return FileResponse(FRONTEND / "index.html")


if FRONTEND.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND)), name="static")
