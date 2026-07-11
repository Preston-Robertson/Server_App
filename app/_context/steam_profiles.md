# app/_context/steam_profiles.md
# Context summary for app/steam_profiles.py (134 lines).

## Purpose
Global steamID64 → display name address book. Stored as a single JSON file at `settings.state_dir/steam_profiles.json`. Used by the dashboard so operators see player names instead of 17-digit Steam IDs in access control lists.

## Public API
- `load_all()` → `dict[str, str]` (full map: steamID64 → display name)
- `upsert(steam_id, display_name)` → None (add or update one entry)
- `delete(steam_id)` → None
- `lookup_steam_name(steam_id)` → `Optional[str]` (hits Valve community XML endpoint, no API key needed)

## Called by
`app/main.py` (GET/POST/DELETE `/api/steam-profiles` endpoints).

## Calls / depends on
`app.config.settings` (for `state_dir`), `json`, `os`, `threading`, `pathlib`, `urllib.request`, `urllib.error`.

## Key invariants / gotchas
- **Thread-safe**: all reads/writes go through `_lock` (module-level `threading.Lock()`).
- **Atomic save**: writes to `<path>.tmp`, then `os.replace()`. A crash mid-save cannot corrupt the store.
- **Fail-soft loading**: missing file → empty map; malformed JSON → empty map with stderr warning. Never blocks the manager.
- **`lookup_steam_name`**: hits `steamcommunity.com/profiles/<id>?xml=1`. No API key required. Only works for profiles with public privacy setting. Timeout: `_LOOKUP_TIMEOUT_SEC = 4.0`.
- **`_STEAMID64_RE`**: validates format (`7656119[0-9]{10}`). Invalid IDs are rejected.
- **`state_dir` auto-created**: `_save_locked()` calls `p.parent.mkdir(parents=True, exist_ok=True)`.

## Common failure modes
- Lookup returns None: profile is private, or Steam community endpoint unreachable (rate-limit, network issue, or the LXC blocks outbound HTTP).
- Empty map on startup: `state_dir` doesn't exist yet (created on first save).
- JSON file corrupted: treated as empty; operator must manually delete and re-add entries.

## Where to change what
- Change the lookup source (e.g. use Steam Web API): edit `lookup_steam_name()`.
- Change the storage location: change `_path()` (derived from `settings.state_dir`).
- Add bulk import: add a new function that calls `upsert()` in a loop.
