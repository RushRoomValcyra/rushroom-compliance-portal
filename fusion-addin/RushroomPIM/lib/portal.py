"""
Thin HTTP client for the Rushroom portal-api edge function.
Uses Python's built-in urllib — no external dependencies required.

Also carries sha256_of(path): the add-in sends the digest of every exported
file with registerCadRevision so the portal can tell exactly which STEP a
drawing was made from (STATUS_MODEL.md §4.1 / §5.4), not by date.
"""
from __future__ import annotations
import hashlib
import json
import urllib.error
import urllib.request
from typing import Any

from .auth import PORTAL_URL, load_config


def _portal_url() -> str:
    return load_config().get("portal_url", PORTAL_URL)


def call(action: str, **kwargs) -> dict:
    """
    POST to portal-api with the stored session token.
    Raises RuntimeError on HTTP errors with the portal's error message.
    """
    cfg = load_config()
    token = cfg.get("token", "")
    payload = {"action": action, "token": token, **kwargs}
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        _portal_url(),
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body: dict[str, Any] = {}
        try:
            body = json.loads(exc.read().decode("utf-8"))
        except Exception:
            pass
        raise RuntimeError(body.get("error") or f"HTTP {exc.code}")


def call_public(action: str, **kwargs) -> dict:
    """
    POST to portal-api WITHOUT a session token (for loginUser and other public actions).
    """
    payload = {"action": action, **kwargs}
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        _portal_url(),
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body: dict[str, Any] = {}
        try:
            body = json.loads(exc.read().decode("utf-8"))
        except Exception:
            pass
        raise RuntimeError(body.get("error") or f"HTTP {exc.code}")


def upload_file(signed_url: str, file_path: str) -> None:
    """
    PUT the file at file_path to the given pre-signed Supabase Storage URL.
    Raises RuntimeError on failure.
    """
    with open(file_path, "rb") as f:
        data = f.read()
    req = urllib.request.Request(
        signed_url,
        data=data,
        headers={"Content-Type": "application/octet-stream"},
        method="PUT",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            if resp.status not in (200, 201):
                raise RuntimeError(f"Upload returned HTTP {resp.status}")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Upload failed: HTTP {exc.code}")


def sha256_of(file_path: str) -> str:
    """
    Return the lowercase hex SHA-256 of the file at file_path.
    Streams in 1 MiB chunks so a large .f3z does not have to fit in memory twice.
    """
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()
