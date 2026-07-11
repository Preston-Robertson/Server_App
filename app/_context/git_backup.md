# app/_context/git_backup.md
# Context summary for app/git_backup.py (329 lines).

## Purpose
Pushes local world backup `.tgz` files (written by `uploads.make_backup()`) to a private git repository for offsite retention. Optionally auto-provisions a private GitHub repo (`gamesrv-backup-<server>`) when no URL is configured. Token is never persisted in `.git/config`.

## Public API
- `push(sd: ServerDef, *, token_override=None, progress_cb=None)` → `list[str]` (messages)

## Called by
`app/main.py` (backup endpoint's post-backup git-push step, if `git_backup.enabled` is true on the ServerDef).

## Calls / depends on
`app.config.settings`, `app.registry.GitBackupCfg`, `app.registry.ServerDef`, `app.registry.save_def`, `subprocess` (git), `json`, `urllib.request` (GitHub API for auto-create), `pathlib`, `os`.

## Key invariants / gotchas
- **Token priority**: per-request override > `git_backup.token_env` env var > `GAMESRV_GITHUB_TOKEN` env fallback. Any of the three must be set or `RuntimeError` is raised.
- **Token scrubbing**: after each `git push`, the token is removed from `.git/config` via `git remote set-url` with the clean URL. A crash between push and scrub could leave the token in `.git/config` — handle carefully.
- **Auto-create**: only runs when `repo_url` is blank AND `provider == "github"`. Creates a private repo named `gamesrv-backup-<server>` under the token owner. `provisioned_at` and `repo_url` are written back to the ServerDef YAML on success.
- **Gitea/Forgejo**: `provider` field is forward-compat; auto-create path only handles GitHub today. Manual `repo_url` works for any git remote.
- **No cron/background push**: all pushes are explicitly initiated from the API. This module has no background thread.

## Common failure modes
- No token configured: `RuntimeError` with actionable message listing which env var to set.
- GitHub API rate-limit on auto-create: raises `HTTPError` → surfaces in job tail.
- Push fails (diverged history, permission denied): `subprocess.CalledProcessError` → surfaces in job tail.
- Token left in `.git/config` after crash: `(likely — verify)` — re-running push will re-scrub it.

## Where to change what
- Add Gitea auto-create: add a branch in the auto-create section keyed on `provider == "gitea"`.
- Change backup repo naming convention: edit the `repo_name` computation.
- Change token injection strategy: edit `_inject_token()`.
