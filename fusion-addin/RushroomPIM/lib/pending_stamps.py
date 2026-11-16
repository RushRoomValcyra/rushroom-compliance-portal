"""
Pending-stamps queue.

Stores filename → {portal_id, portal_pn} mappings written by the Bulk Stamp
"Project Files" review flow and consumed (applied + removed) by the
DocumentOpened handler in RushroomPIM.py.

The queue file lives next to the add-in entry point so it is included when
the AddIns folder is synced with the git repo.
"""
import json
import os

_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pending_stamps.json")


def load() -> dict:
    try:
        with open(_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save(data: dict) -> None:
    with open(_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def merge(entries: dict) -> int:
    """Add entries to the queue; returns new total count."""
    current = load()
    current.update(entries)
    save(current)
    return len(current)


def consume(key: str) -> dict | None:
    """Remove and return the entry for `key`, or None if absent."""
    current = load()
    entry = current.pop(key, None)
    if entry is not None:
        save(current)
    return entry


def count() -> int:
    return len(load())
