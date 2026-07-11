# app/_context/main.md
# Context summary for app/main.py (~2100 lines). Read this BEFORE opening the file.

## Purpose
FastAPI application entrypoint: defines all HTTP routes (dashboard, health, server CRUD, lifecycle actions, file ops, backup, git, firewall, admin), mounts static files and Jinja2 templates, and wires up startup hooks for the watchdog, wake proxy, perf sampler, and firewall reconciler.

## Public API (routes — all require bearer-token auth except /healthz and /)
| Method | Path | Action |
|---|---|---|
| GET | `/` | Jinja2 dashboard HTML |
| GET | `/healthz` | Health check (unauthenticated), returns "ok" |
| GET | `/api/stats` | Aggregate: server counts, RAM usage, disk usage |
| GET | `/api/servers` | List all server defs + live status |
| POST | `/api/servers` | Create or update a server definition |
| DELETE | `/api/servers/{name}` | Remove a def (does NOT delete files on disk) |
| GET | `/api/servers/{name}` | Full server detail |
| POST | `/api/servers/{name}/action` | start / stop / restart / enable / disable |
| POST | `/api/servers/{name}/install` | Kick off async install job |
| POST | `/api/servers/{name}/update` | Kick off async update job |
| GET | `/api/servers/{name}/job` | Poll current install/update job progress |
| POST | `/api/servers/{name}/console` | Send tmux console command |
| GET | `/api/servers/{name}/logs` | journalctl tail |
| GET/POST/DELETE | `/api/servers/{name}/files` | List / upload / delete files |
| GET | `/api/servers/{name}/files/download` | Download a file |
| POST | `/api/servers/{name}/backup` | Snapshot world_dir to .tgz (async) |
| GET | `/api/servers/{name}/backups` | List backup snapshots |
| POST | `/api/servers/{name}/restore` | Restore a snapshot (async; server must be stopped) |
| GET/POST | `/api/servers/{name}/env` | Read/write server env_file section |
| GET/POST | `/api/firewall` | Firewall snapshot / reconcile |
| GET/POST/DELETE | `/api/steam-profiles` | Steam ID address book |
| POST | `/api/manager/update` | Trigger self-update |
| GET | `/api/manager/update/log` | Tail update.log |
| GET/POST | `/api/admin/env` | Read/write /etc/gamesrv.env |
| POST | `/api/admin/restart` | Restart manager (os._exit(0)) |

## Called by
- `uvicorn` via `run_manager.sh` → `app.main:app`

## Calls / depends on
All other app modules: `control`, `registry`, `uploads`, `updater`, `git_source`, `git_backup`, `env_file`, `jobs`, `watchdog`, `wake_proxy`, `perf`, `firewall`, `steam_profiles`, `auth`, `config`, `app.types.handler_for`.

## Key invariants / gotchas
- **Startup hook order matters**: watchdog → wake_proxy → perf_sampler → firewall.reconcile_all. Changing order can break wake-on-demand or lose the first RAM sample.
- **RAM pre-flight check on "start"**: `api_action("start")` sums active servers' `memory_mb` + the target's; if it exceeds the LXC cgroup limit, returns HTTP 507 before calling systemctl. This guards against OOM kills.
- **Port-free wait on "start"**: calls `control.wait_tcp_port_free()` for Satisfactory to avoid Unreal Engine port-shift on TIME_WAIT.
- All `/api/servers/{name}/files` ops go through `uploads._safe_join()` for path-traversal protection.
- `os._exit(0)` on admin/restart: systemd Restart=always brings it back.

## Common failure modes
- `firewall.reconcile_all` logs error on startup but does NOT abort startup (fails soft).
- If `registry.list_defs()` returns a malformed YAML, it's silently skipped — server won't appear in list.
- `api_stats` may return stale disk figures if `shutil.disk_usage` raises (caught, returns None).

## Where to change what
- Add a new API endpoint: currently add to `main.py` (post-refactor: add to `app/routes/<domain>.py`).
- Change startup sequence: `_startup()` function.
- Change RAM pre-flight logic: look for the 507 check in `api_action`.
- Change auth: `app/auth.py::require_token`.
