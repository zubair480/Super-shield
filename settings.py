"""Shared, env-driven configuration for SuperShield.

Everything that differs between local and cloud (ClickHouse host, API keys,
scale knobs) is read here so migration is a config swap, not a code change.
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

# ---------- openFDA ----------
OPENFDA_BASE = "https://api.fda.gov"
OPENFDA_ENFORCEMENT = f"{OPENFDA_BASE}/drug/enforcement.json"
OPENFDA_API_KEY = os.getenv("OPENFDA_API_KEY", "").strip()
# Shared synthetic feed owned by the patient workflow (shared/fda/README.md).
SHARED_RECALLS_FILE = Path(os.getenv("SHARED_RECALLS_FILE", str(ROOT / "shared" / "fda" / "demo-recalls.json")))
SHARED_INJECTOR = ROOT / "shared" / "fda" / "inject-recall.mjs"

# ---------- ClickHouse ----------
CLICKHOUSE = {
    "host": os.getenv("CLICKHOUSE_HOST", "localhost"),
    "port": int(os.getenv("CLICKHOUSE_PORT", "8123")),
    "username": os.getenv("CLICKHOUSE_USER", "default"),
    "password": os.getenv("CLICKHOUSE_PASSWORD", ""),
    "database": os.getenv("CLICKHOUSE_DATABASE", "supershield"),
    "secure": os.getenv("CLICKHOUSE_SECURE", "false").lower() == "true",
}

# ---------- Scale knobs ----------
SCALE_PHARMACIES = int(os.getenv("SCALE_PHARMACIES", "5000"))
SCALE_CUSTOMERS = int(os.getenv("SCALE_CUSTOMERS", "1000000"))
NDC_OVERLAP_RATE = float(os.getenv("NDC_OVERLAP_RATE", "0.18"))

# ---------- Data artifact paths ----------
SEED_NDCS_PATH = DATA_DIR / "seed_ndcs.json"
PHARMACIES_CSV = DATA_DIR / "pharmacies.csv"
CUSTOMERS_CSV = DATA_DIR / "customers.csv"

# ---------- Composio (real pharmacist alert delivery) ----------
# Same env contract as the patient workflow. Unset = alerts stay in-app only;
# DRY_RUN=true = print instead of sending (labelled simulated).
COMPOSIO_API_KEY = os.getenv("COMPOSIO_API_KEY", "").strip()
COMPOSIO_USER_ID = os.getenv("COMPOSIO_USER_ID", "default").strip()
NOTIFY_CHANNEL = os.getenv("NOTIFY_CHANNEL", "slack").strip().lower()  # slack | gmail
COMPOSIO_SLACK_CHANNEL = os.getenv("COMPOSIO_SLACK_CHANNEL", "").strip()
COMPOSIO_GMAIL_TO = os.getenv("COMPOSIO_GMAIL_TO", "").strip()
DRY_RUN = os.getenv("DRY_RUN", "false").lower() == "true"

# ---------- Telegram (pharmacist phone push) ----------
# ALERT_CHANNEL=telegram sends through a @BotFather bot to TELEGRAM_CHAT_ID (the chat
# that sent the bot /start). Any other value falls through to NOTIFY_CHANNEL (Composio).
ALERT_CHANNEL = os.getenv("ALERT_CHANNEL", NOTIFY_CHANNEL).strip().lower()
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()

# ---------- Claude / agents ----------
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-opus-5-5")
USE_AGENTS = os.getenv("USE_AGENTS", "false").lower() == "true"

# ---------- Severity mapping (openFDA classification -> our labels) ----------
CLASSIFICATION_TO_SEVERITY = {
    "Class I": "Lethal",
    "Class II": "Moderate",
    "Class III": "Minor",
}
