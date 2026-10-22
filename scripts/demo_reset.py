"""Reset SuperShield to a clean, repeatable live-demo state.

Run before every demo:   .venv/Scripts/python scripts/demo_reset.py

- Empties the shared synthetic recall feed (shared/fda/demo-recalls.json).
- Ensures the demo patient exists with ONLY medications that currently have no FDA recalls,
  so the patient portal starts with zero alerts.
- Removes the demo patient's earlier alerts (other patients are untouched).
- Prints the one command that triggers the live recall for both portals.

Needs both servers running: pharmacy on :8000 and patient on :3000.
"""
from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATIENT_API = "http://127.0.0.1:3000/api"
SHARED_FEED = ROOT / "shared" / "fda" / "demo-recalls.json"
NOTIFICATIONS = ROOT / "patient" / "demo" / "seed-data" / "notifications.json"

DEMO_NAME = "Jordan Rivera"
DEMO_DRUGS = ["Aripiprazole", "Estradiol"]
# Aripiprazole at this NDC is dispensed to ~290 synthetic pharmacy customers, so one
# recall hits both portals: pharmacy by NDC, patient by drug name.
RECALL_DRUG, RECALL_NDC = "Aripiprazole", "27241-051"


def call(method: str, path: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{PATIENT_API}{path}", data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def main() -> int:
    SHARED_FEED.write_text("[]\n", encoding="utf-8")
    print("1. Shared recall feed emptied.")

    try:
        patients = call("GET", "/patients")
    except OSError as exc:
        print(f"Patient service on :3000 is not reachable ({exc}). Start it: npm --prefix patient run dev")
        return 1

    for drug in DEMO_DRUGS:
        found = call("GET", "/drug-check?name=" + urllib.parse.quote(drug)).get("recalls", [])
        if found:
            print(f"   WARNING: openFDA now lists {len(found)} recall(s) for {drug}; "
                  f"the demo patient will not start clean. Pick another drug.")

    demo = next((p for p in patients if p["name"] == DEMO_NAME), None)
    if demo is None:
        demo = call("POST", "/patients", {"name": DEMO_NAME, "drugs": DEMO_DRUGS})["patient"]
        print(f"2. Created demo patient {DEMO_NAME} ({demo['id']}).")
    else:
        demo = call("PUT", f"/patients/{demo['id']}/drugs", {"drugs": DEMO_DRUGS})
        print(f"2. Demo patient {DEMO_NAME} ({demo['id']}) reset to {', '.join(DEMO_DRUGS)}.")

    try:
        rows = json.loads(NOTIFICATIONS.read_text(encoding="utf-8") or "[]")
    except FileNotFoundError:
        rows = []
    kept = [r for r in rows if r.get("patientId") != demo["id"]]
    NOTIFICATIONS.write_text(json.dumps(kept, indent=2) + "\n", encoding="utf-8")
    print(f"3. Cleared {len(rows) - len(kept)} earlier alert(s) for {demo['id']}.")

    print(f"""
Ready. Open these side by side:
  Pharmacy: http://localhost:8000/app#/pharmacy
  Patient:  http://localhost:8000/app?patient={demo['id']}#/patient

Then, live, trigger the FDA recall:
  node shared/fda/inject-recall.mjs --drug {RECALL_DRUG} --ndc {RECALL_NDC} --class "Class I"
""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
