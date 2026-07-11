# app/_context/git_source.md
# Context summary for app/git_source.py (383 lines).

## Purpose
Pulls server configuration files from a git remote into a server's `install_dir`. The `.git` tree lives in a sibling cache dir (`<install_dir>.gitsrc/`) rather than inside `install_dir` itself. Supports HTTPS (with PAT injection) and SSH URLs, and both GitHub and self-hosted Gitea/Forgejo.

## Public API
- `sync(sd: ServerDef, *, token_override=None, progress_cb=None)` → `list[str]` (messages)

## Called by
`app/main.py` (install/update job paths call sync for servers with `git_source.url` configured). `app/jobs.py` orchestrates it as part of the background job.

## Calls / depends on
`app.registry.ServerDef`, `app.registry.GitSourceCfg`, `subprocess` (git), `shutil` (rsync or Python copytree fallback), `pathlib`, `os`, `re`, `time`.

## Key invariants / gotchas
- **Cache dir naming**: `<install_dir>.gitsrc/` — the `.git` tree is NOT inside `install_dir`. Games never see `.git` files.
- **Token injection**: for HTTPS PATs, `x-access-token:<PAT>@` is injected into the URL at call time. The PAT is NEVER written to `.git/config`.
- **`rsync` preferred, Python copytree fallback**: rsync must be installed for `--delete-excluded` to work cleanly. Without rsync, excluded files may remain.
- **`_DEFAULT_EXCLUDES`**: `.git`, `.github`, `logs`, `*.log`, Minecraft world directories (`world`, `world_nether`, `world_the_end`). These are always excluded.
- **`git_source.exclude`**: per-server extra excludes appended to the defaults.
- **`git_source.subdir`**: if set, only this subdirectory of the repo is copied into `install_dir`.
- **`git_source.world_subdir`**: if set, this subdirectory is extracted into `world_dir` instead.
- **`deployed_sha/ref/at`**: written back to `ServerDef` and saved after successful sync.
- File:// URLs are explicitly rejected as likely misconfiguration.

## Common failure modes
- Git clone/fetch fails: wrong URL, missing PAT, network issue. Error propagated as `GitError(RuntimeError)` → surfaces in job tail.
- rsync not installed: falls back to Python copytree; `exclude` patterns may not be fully honoured.
- Wrong `subdir`: sync succeeds but no useful files land in `install_dir`.
- Token env var missing: `_resolve_token()` raises `ValueError` with the env var name.

## Where to change what
- Add a new git host (Gitea API, GitLab): extend `_resolve_token()` and `_url_with_token()`.
- Change default excludes: `_DEFAULT_EXCLUDES` tuple.
- Change clone/fetch strategy: `_clone_or_fetch()` function.
