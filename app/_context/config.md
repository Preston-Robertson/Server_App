# app/_context/config.md
# Context summary for app/config.py (48 lines).

## Purpose
Runtime configuration: reads environment variables (set via systemd `EnvironmentFile=/etc/gamesrv.env`) into a frozen `Settings` dataclass. Loaded once at import time and shared across all modules.

## Public API
- `settings: Settings` — module-level singleton; import this everywhere
- `Settings` dataclass fields: `token`, `host`, `port`, `app_dir`, `defs_dir`, `install_root`, `worlds_root`, `backup_root`, `state_dir`, `unit_template`, `github_token`
- `load()` → `Settings` (called once at module load; not typically called directly)

## Called by
Every module that needs a configured path or the auth token: `auth.py`, `main.py`, `control.py`, `registry.py`, `uploads.py`, `firewall.py`, `git_backup.py`, `env_file.py`, `steam_profiles.py`, `updater.py`.

## Calls / depends on
`os.environ`, `pathlib.Path`, `dataclasses`.

## Key invariants / gotchas
- **Frozen dataclass**: `Settings` is `@dataclass(frozen=True)`. All fields are immutable after load. There is no live-reload — a change to `/etc/gamesrv.env` requires a manager restart to take effect.
- **`_env(key, default)`**: strips whitespace and treats blank strings as "not set" (returns default). This means `GAMESRV_TOKEN=` (empty) → `settings.token = ""` → auth module returns HTTP 503.
- **`state_dir`**: defaults to `/opt/gamesrv/state` (not in `.env.example`; only in `app/config.py` via `GAMESRV_STATE_DIR`). Created on demand by modules that use it.
- **`unit_template`**: defaults to `"gamesrv@"`. The unit name for server `foo` is `f"{settings.unit_template}foo.service"` = `"gamesrv@foo.service"`.

## Common failure modes
- `settings.token = ""` if `GAMESRV_TOKEN` not set → all API calls return HTTP 503 "GAMESRV_TOKEN not configured".
- Wrong `defs_dir` path → `registry.list_defs()` returns empty list (no servers visible).
- Wrong `install_root` → `control.start()` succeeds but game can't find `start.sh`.

## Where to change what
- Add a new config key: add a field to `Settings`, add an `_env()` call in `load()`, document it in `.env.example`.
- Change a default path: change the second argument to the relevant `_env()` call in `load()`.
