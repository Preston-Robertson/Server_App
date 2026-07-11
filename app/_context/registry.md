# app/_context/registry.md
# Context summary for app/registry.py (338 lines).

## Purpose
Server definition registry: parses and validates per-server YAML files from `settings.defs_dir` into Pydantic `ServerDef` models. Provides CRUD functions for listing, loading, saving, and deleting server definitions.

## Public API
- `list_defs()` → `list[ServerDef]` (skips malformed files silently)
- `load_def(name)` → `ServerDef` (raises `FileNotFoundError` or `ValueError`)
- `save_def(sd: ServerDef)` → `Path`
- `delete_def(name)` → None
- **Models**: `ServerDef`, `RconCfg`, `BackupCfg`, `GitSourceCfg`, `GitBackupCfg`, `AccessCfg`, `FirewallCfg`, `PasswordsCfg`

## Called by
Nearly every module: `main.py` (all endpoints), `control.py` (status/start/stop), `watchdog.py` (`list_defs()`), `wake_proxy.py` (`list_defs()`, `load_def()`), `firewall.py` (`list_defs()`), `git_source.py`, `git_backup.py`, `uploads.py`.

## Calls / depends on
`app.config.settings` (for `defs_dir`), `pydantic`, `yaml`, `pathlib`.

## Key invariants / gotchas
- **Name validation**: `^[a-z][a-z0-9-]{1,31}$` — lowercase, starts with letter, 2–32 chars. This is also the systemd unit instance name and the filesystem directory name.
- **`list_defs()` silently skips** malformed/invalid YAML files with a bare `except`. A server def with a schema error won't appear in the list and won't cause an error — it's just invisible. Check the journal if a server goes missing.
- **`servers/*.example.yml` files are skipped** in `list_defs()` (`.endswith(".example.yml")`).
- **Passwords stored inline**: `PasswordsCfg` fields live in the YAML. Keep `servers/*.yml` out of any public git remote.
- **`wake_on_demand` + `wake_timeout_sec`**: when `wake_on_demand=true`, game binds `port + 10000` internally. A reinstall is required after toggling because `start.sh` is regenerated with the effective port.
- **`FirewallCfg.mode`** validation: only `"lan"`, `"public"`, `"allowlist"` accepted.
- **`AccessCfg.mode`** validation: `"public"`, `"steamid_allowlist"`, `"ip_allowlist"`.

## Common failure modes
- Schema validation error on `load_def()` raises `pydantic.ValidationError` — surfaces as HTTP 422 in the API.
- `save_def()` writes YAML with `sort_keys=False`; comment lines in the original are lost on save (yaml.safe_dump doesn't preserve comments).
- `delete_def()` is a no-op if the file doesn't exist (no error raised).

## Where to change what
- Add a new field to all server defs: add to `ServerDef` with a default value. Existing YAMLs will get the default.
- Add validation for a new field: add a `@field_validator` method on the relevant model.
- Change name constraints: `_NAME_RE` regex.
