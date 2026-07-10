"""Global Steam ID address book.

A tiny per-manager JSON store mapping steamID64 → display name. Used by
the dashboard so operators see "Preston, Alice" beside the SteamID
allowlist on any server instead of a wall of 17-digit numbers.

Design goals:
  * No external DB. One JSON file at ``settings.state_dir/steam_profiles.json``.
  * No Steam API key needed. The optional lookup helper hits the public
    community XML endpoint that Valve ships for every profile with the
    default privacy setting.
  * Fail-soft: missing file → empty map, malformed file → empty map with
    a stderr warning. Never blocks the manager.

Concurrency:
  * All reads/writes go through this module's lock. Writes atomically
    rename a tempfile so a crash mid-save can never corrupt the store.
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
from pathlib import Path
from typing import Optional
from urllib.request import Request, urlopen
from urllib.error import URLError

from .config import settings


_STEAMID64_RE = re.compile(r"^7656119[0-9]{10}$")
_LOOKUP_TIMEOUT_SEC = 4.0
_LOOKUP_USER_AGENT = "gamesrv-manager/1.0"

_lock = threading.Lock()


def _path() -> Path:
    return settings.state_dir / "steam_profiles.json"


def _load_locked() -> dict[str, str]:
    p = _path()
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(
            f"[steam_profiles] {p} is unreadable, treating as empty: {e}",
            file=sys.stderr, flush=True,
        )
        return {}
    if not isinstance(data, dict):
        print(
            f"[steam_profiles] {p} is not a JSON object; ignoring",
            file=sys.stderr, flush=True,
        )
        return {}
    # Coerce to str/str so we don't hand back a malformed shape.
    return {str(k): str(v) for k, v in data.items() if isinstance(k, str)}


def _save_locked(profiles: dict[str, str]) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(profiles, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, p)


def load_all() -> dict[str, str]:
    """Return the full address book (steamID64 → display name)."""
    with _lock:
        return _load_locked()


def upsert(steamid: str, name: str) -> dict[str, str]:
    """Add or update a profile. Returns the full updated map."""
    sid = str(steamid).strip()
    if not _STEAMID64_RE.match(sid):
        raise ValueError(f"invalid steamID64: {steamid!r}")
    n = str(name or "").strip()[:64]   # cap to keep the UI compact
    with _lock:
        profiles = _load_locked()
        if n:
            profiles[sid] = n
        else:
            # Empty name treated as delete so the UI can clear a bad entry.
            profiles.pop(sid, None)
        _save_locked(profiles)
        return dict(profiles)


def delete(steamid: str) -> dict[str, str]:
    """Remove a profile. Returns the full updated map."""
    sid = str(steamid).strip()
    with _lock:
        profiles = _load_locked()
        profiles.pop(sid, None)
        _save_locked(profiles)
        return dict(profiles)


def lookup_public_name(steamid: str) -> Optional[str]:
    """Fetch the display name for a public Steam profile.

    Uses the community XML endpoint (no API key required). Returns None
    for private profiles, invalid IDs, or any network/parse failure —
    the caller is responsible for surfacing "couldn't fetch" to the UI.
    """
    sid = str(steamid).strip()
    if not _STEAMID64_RE.match(sid):
        return None
    url = f"https://steamcommunity.com/profiles/{sid}/?xml=1"
    req = Request(url, headers={"User-Agent": _LOOKUP_USER_AGENT})
    try:
        with urlopen(req, timeout=_LOOKUP_TIMEOUT_SEC) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except (URLError, TimeoutError, OSError):
        return None
    # Cheap parse — we only want <steamID>Name</steamID>. Regex is safer
    # here than xml.etree because Valve's XML sometimes contains raw HTML
    # entities that ElementTree rejects.
    m = re.search(r"<steamID><!\[CDATA\[(.*?)\]\]></steamID>", body, re.S)
    if not m:
        m = re.search(r"<steamID>(.*?)</steamID>", body, re.S)
    if not m:
        return None
    name = m.group(1).strip()
    return name or None
