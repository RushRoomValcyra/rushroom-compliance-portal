"""
Token storage for the RushroomPIM add-in.

config.json lives in the add-in directory and persists across Fusion restarts.
It stores email + token + expiry. The password is NEVER stored; the user
re-enters it when the 8-hour session expires.

config.json schema:
{
  "portal_url": "https://…/portal-api",
  "email": "user@example.com",
  "token": "<custom JWT>",
  "token_expires_at": 1700000000,   // Unix timestamp
  "role": "rushroom",
  "name": "Mathias",
  "organization_id": "11111111-…"
}
"""
import json
import os
import time

ADDIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_FILE = os.path.join(ADDIN_DIR, "config.json")

PORTAL_URL = "https://iwoqujpwhsoywudjtsnj.supabase.co/functions/v1/portal-api"


def load_config() -> dict:
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg: dict) -> None:
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)


def get_token() -> str | None:
    """Return the stored token if it has not expired, otherwise None."""
    cfg = load_config()
    token = cfg.get("token")
    expires_at = cfg.get("token_expires_at", 0)
    if token and time.time() < float(expires_at):
        return token
    return None


def save_session(token: str, role: str, name: str, org_id: str, ttl_seconds: int = 8 * 3600) -> None:
    cfg = load_config()
    cfg.update({
        "portal_url": PORTAL_URL,
        "token": token,
        "token_expires_at": int(time.time()) + ttl_seconds - 60,  # 60-second buffer
        "role": role,
        "name": name,
        "organization_id": org_id,
    })
    save_config(cfg)


def clear_session() -> None:
    cfg = load_config()
    for k in ("token", "token_expires_at"):
        cfg.pop(k, None)
    save_config(cfg)


def session_summary() -> str:
    """Return a one-line string describing the current session state."""
    cfg = load_config()
    token = cfg.get("token")
    expires_at = cfg.get("token_expires_at", 0)
    if not token:
        return "Not connected"
    if time.time() >= float(expires_at):
        return f"Session expired ({cfg.get('email', '')})"
    remaining = int((float(expires_at) - time.time()) / 60)
    return f"Connected as {cfg.get('name', cfg.get('email', '?'))}  ({remaining} min remaining)"
