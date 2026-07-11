# app/_context/env_file.md
# Context summary for app/env_file.py (348 lines).

## Purpose
Line-based read/write of `/etc/gamesrv.env` for the Admin tab in the dashboard. Manages a schema-driven set of known keys with labels and help text, plus discovery of "extra" keys (per-server RCON passwords, git PATs) from the file's current contents.

## Public API
- `KNOWN_KEYS: tuple[EnvKey, ...]` — schema for the admin form
- `EnvKey` dataclass: `name`, `label`, `help`, `section`, `input_type`, `is_secret`
- `read_env(path)` → `dict` (current key/value map from file)
- `write_env(path, updates: dict)` → `list[str]` (messages; atomic when possible)
- `discover_extras(path, known_names)` → `list[EnvKey]` (keys present in file but not in schema)
- `_EXTRA_KEY_PATTERNS` — regex patterns for writable non-schema keys (per-server env vars)

## Called by
`app/main.py` (GET/POST `/api/admin/env` endpoints).

## Calls / depends on
`app.config.settings` (for the env file path), `os`, `re`, `tempfile`, `pathlib`, `dataclasses`.

## Key invariants / gotchas
- **Line-based edit**: only the first matching `KEY=...` line is updated; other lines (comments, blank, unknown-shape) are preserved verbatim. File is never rewritten from scratch.
- **Atomic replace preferred**: tries to write to a tempfile in the same directory and `os.replace()`. Falls back to in-place rewrite when the parent directory is not writable (e.g. `/etc/` is root-owned and `ProtectSystem=full` makes it read-only, but `/etc/gamesrv.env` itself has a `ReadWritePaths` exception in the unit file).
- **Schema-driven**: only `KNOWN_KEYS` names and keys matching `_EXTRA_KEY_PATTERNS` are writable via the UI. Unknown keys in the file are surfaced read-only.
- **Secrets**: `is_secret=True` keys are rendered as password inputs in the UI. A blank value in the update dict means "don't change" — the current value is preserved.
- **Restart required**: all config changes require a manager restart to take effect (Settings is frozen on load). The API flags this to the caller.

## Common failure modes
- Write fails with permission error: `ReadWritePaths=/etc/gamesrv.env` not set in the unit (missing from `gamesrv-manager.service`). Very unlikely unless unit was edited.
- Blank token save: if the admin submits the form with an empty password field for `GAMESRV_TOKEN`, the "blank = don't change" logic preserves the existing token. Correct behavior.
- Comment loss: comments on the same line as a `KEY=VALUE` are stripped on update (yaml.safe_dump style — except this is not YAML, it's shell env format; comments are only on their own lines and are preserved).

## Where to change what
- Add a new admin-editable key: add an `EnvKey` to `KNOWN_KEYS`.
- Change what "extra" keys are discoverable: edit `_EXTRA_KEY_PATTERNS`.
- Change the env file path: the path comes from `settings.app_dir` (via `main.py`); change config.
