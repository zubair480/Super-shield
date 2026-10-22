"""Real-world alert delivery via Composio (pharmacist push + one demo alert).

The full nationwide cohort dispatch stays *simulated* (preserving the scale and
confidentiality story). When Composio is configured, the monitor sends the
pharmacist a real Slack message or Gmail email, and a manual run can send ONE
demo alert to the same destination.

Same env contract as the patient workflow (patient/packages/notifier):
  COMPOSIO_API_KEY, COMPOSIO_USER_ID, NOTIFY_CHANNEL=slack|gmail,
  COMPOSIO_SLACK_CHANNEL / COMPOSIO_GMAIL_TO, DRY_RUN=true (simulate, never send).

Only aggregates leave the system - no customer names or phone numbers.
Safe no-op when unconfigured.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.append(str(ROOT))
from settings import (  # noqa: E402
    COMPOSIO_API_KEY,
    COMPOSIO_GMAIL_TO,
    COMPOSIO_SLACK_CHANNEL,
    COMPOSIO_USER_ID,
    DRY_RUN,
    NOTIFY_CHANNEL,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
)
from settings import ALERT_CHANNEL as _CHANNEL_SETTING  # noqa: E402

# Slack message limit is 40k chars; Gmail has no practical limit. Keep alerts short.
_MAX_BODY = 3000

_SIREN = "\U0001F6A8"  # rotating-light emoji

ALERT_CHANNEL = "telegram" if _CHANNEL_SETTING == "telegram" else NOTIFY_CHANNEL  # telegram | slack | gmail

_composio = None


def _send_telegram(body: str) -> dict:
    """Free phone push via a Telegram bot to TELEGRAM_CHAT_ID."""
    import requests

    resp = requests.post(f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                         json={"chat_id": TELEGRAM_CHAT_ID, "text": body}, timeout=25)
    if resp.ok and resp.json().get("ok"):
        return {"sent": True, "channel": "telegram", "ref": f"telegram:{resp.json()['result']['message_id']}"}
    return {"sent": False, "channel": "telegram", "reason": f"HTTP {resp.status_code}: {resp.text[:160]}"}


def resolve_chat_id() -> dict:
    """Helper: chats that messaged the bot (run after sending it /start)."""
    import requests

    data = requests.get(f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getUpdates", timeout=25).json()
    chats = []
    for u in data.get("result", []):
        chat = (u.get("message") or u.get("edited_message") or {}).get("chat") or {}
        if chat.get("id") is not None:
            chats.append((chat["id"], chat.get("first_name") or chat.get("title") or ""))
    return {"ok": data.get("ok", False), "chats": chats}


def _client():
    global _composio
    if _composio is None:
        from composio import Composio
        _composio = Composio(api_key=COMPOSIO_API_KEY)
    return _composio


def is_configured() -> bool:
    if ALERT_CHANNEL == "telegram":
        return bool(TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)
    if not COMPOSIO_API_KEY:
        return False
    return bool(COMPOSIO_GMAIL_TO if ALERT_CHANNEL == "gmail" else COMPOSIO_SLACK_CHANNEL)


def _execute(slug: str, arguments: dict) -> dict:
    res = _client().tools.execute(slug, arguments, user_id=COMPOSIO_USER_ID,
                                  dangerously_skip_version_check=True)
    if not res.get("successful"):
        return {"sent": False, "channel": ALERT_CHANNEL, "mode": "composio",
                "reason": str(res.get("error") or "unknown")[:160]}
    data = res.get("data") or {}
    ref = data.get("ts") or data.get("id") or data.get("messageId") or data.get("threadId") or "ok"
    return {"sent": True, "channel": ALERT_CHANNEL, "mode": "composio", "ref": f"{ALERT_CHANNEL}:{ref}"}


def send_text(body: str, title: str = "SuperShield Pharmacy alert") -> dict:
    """Send text over the configured Composio channel (SuperShield pharmacist push)."""
    if not is_configured():
        return {"sent": False, "channel": ALERT_CHANNEL, "reason": "not_configured"}
    if DRY_RUN:
        print(f"\n[composio:{ALERT_CHANNEL} DRY_RUN] {title}\n{body}\n")
        return {"sent": False, "channel": ALERT_CHANNEL, "reason": "simulated_dry_run"}
    body = body[:_MAX_BODY]
    try:
        if ALERT_CHANNEL == "telegram":
            return _send_telegram(f"{title}\n{body}")
        if ALERT_CHANNEL == "gmail":
            return _execute("GMAIL_SEND_EMAIL",
                            {"recipient_email": COMPOSIO_GMAIL_TO, "subject": title, "body": body})
        # markdown_text is this tool's message field ('text' does not exist).
        return _execute("SLACK_SEND_MESSAGE",
                        {"channel": COMPOSIO_SLACK_CHANNEL, "markdown_text": f"*{title}*\n{body}"})
    except Exception as exc:  # noqa: BLE001
        return {"sent": False, "channel": ALERT_CHANNEL, "reason": str(exc)[:160]}


def build_emergency_alert(severity: str, recalling_firm: str, product_ndc: str,
                          recall_number: str) -> str:
    """An amber-alert-styled body for the single real demo alert."""
    headline = {
        "Lethal": "LIFE-THREATENING DRUG RECALL",
        "Moderate": "URGENT DRUG RECALL",
        "Minor": "DRUG RECALL NOTICE",
    }.get(severity, "DRUG RECALL NOTICE")
    return (
        f"{_SIREN} FDA SAFETYNET ALERT {_SIREN}\n"
        f"{headline}\n"
        f"A medication you filled (NDC {product_ndc}, {recalling_firm}) was recalled "
        f"by the U.S. FDA. Do not take another dose - contact your pharmacy now.\n"
        f"Recall {recall_number}."
    )


def send_demo_alert(severity: str, recalling_firm: str, product_ndc: str,
                    recall_number: str) -> dict:
    """Send one real demo alert. Returns a de-identified status dict."""
    return send_text(build_emergency_alert(severity, recalling_firm, product_ndc, recall_number),
                     title=f"SuperShield demo alert - recall {recall_number}")


if __name__ == "__main__":
    # Standalone credential check:  python -m phase5_orchestration.tools.real_alert
    print(f"Composio channel={ALERT_CHANNEL} configured={is_configured()} dry_run={DRY_RUN}")
    if not is_configured():
        print("Set COMPOSIO_API_KEY and COMPOSIO_SLACK_CHANNEL (or NOTIFY_CHANNEL=gmail + "
              "COMPOSIO_GMAIL_TO) in .env.")
        raise SystemExit(1)
    status = send_text("Test message from SuperShield Pharmacy (no recall).",
                       title="SuperShield Pharmacy - connection test")
    print(status)
    raise SystemExit(0 if status.get("sent") else 1)
