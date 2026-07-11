# Agent Entrypoint — Server_App

**You are working on a FastAPI-based game server manager (Minecraft, ARK, Palworld, Satisfactory, Enshrouded, etc.) running on Linux with systemd.** Read this file first, then load ONLY the layers you need.

## How to use this repo (every session)
1. **Facts (ports, paths, systemd units)?** → `facts/*.yaml`
2. **Current state?** → `state/STATUS.md`
3. **What to do next?** → `state/NEXT_ACTIONS.md`
4. **Decisions I must not revert?** → `state/DECISIONS.md` (READ BEFORE CHANGING BEHAVIOR)
5. **Troubleshooting a symptom?** → `runbooks/troubleshooting/<symptom>.md`
6. **What does a module do (before opening the file)?** → `app/_context/<module>.md`
7. **What did the last agent do?** → `sessions/` (only if continuity matters)

## Context-budget rules (IMPORTANT — this repo has large files)
- `app/main.py` is ~2100 lines and being decomposed. Read `app/_context/main.md` FIRST; only open `main.py` if the summary is insufficient.
- `app/wake_proxy.py` (~1120 lines) and `app/watchdog.py` (~610 lines) — same rule: read `_context/` first.
- `README.md` is a ~43 KB **user manual**, not agent context. Do NOT load it for internal work. Use `docs/`, `runbooks/`, and `_context/` instead.
- Do NOT load `app/static/`, `app/templates/`, or example `servers/*.yml` unless the task is directly about them.

## Rules of engagement
- **Ask before destructive ops.** Confirm prereqs.
- **Prefer small, targeted edits.** File-heavy PRs waste time.
- **When you finish a session:** append `sessions/YYYY-MM-DD-<topic>.md` and update `state/STATUS.md` + `state/NEXT_ACTIONS.md`.
- **When you make a non-obvious decision:** add an entry to `state/DECISIONS.md`.
- **Never put secrets in files.** Use `.env.example` as reference for names only.

## Architecture at a glance
FastAPI app in `app/main.py` (being split into `app/routes/*.py` — see `state/DECISIONS.md`). Subsystems:
- **control** — start/stop/restart game servers via systemd (`app/control.py`)
- **wake_proxy** — TCP/UDP proxy that wakes a sleeping backend host on incoming player connection (`app/wake_proxy.py`)
- **watchdog** — health monitoring / idle-shutdown via A2S + SLP probes (`app/watchdog.py`)
- **firewall** — UFW rule management for game ports (`app/firewall.py`)
- **git_source** — pull server configs from a git remote (`app/git_source.py`)
- **git_backup** — push world backups to a private GitHub repo (`app/git_backup.py`)
- **updater** — self-update the manager via a systemd oneshot (`app/updater.py`)
- **uploads** — file uploads/downloads + backup/restore (`app/uploads.py`)
- **env_file** — read/write `/etc/gamesrv.env` for admin UI (`app/env_file.py`)
- **registry** — parse/validate server definition YAML files (`app/registry.py`)
- **config** — frozen `Settings` dataclass loaded from env on startup (`app/config.py`)
- **jobs** — in-memory background job registry for long-running install/update ops (`app/jobs.py`)
- **perf** — background RAM sampler for the dashboard chart (`app/perf.py`)
- **auth** — bearer token validation (`app/auth.py`)
- **steam_profiles** — steamID64 → display name address book (`app/steam_profiles.py`)

## Key paths (see `facts/paths.yaml` for full list)
| Path | Purpose |
|---|---|
| `/opt/gamesrv` | App install dir (`GAMESRV_APP_DIR`) |
| `/opt/gamesrv/servers` | Server definition YAMLs |
| `/srv/gameservers/<name>` | Per-server install dirs |
| `/opt/gamesrv/worlds` | World save dirs (TrueNAS bind mount) |
| `/etc/gamesrv.env` | Runtime env (token, ports, paths) |
| `systemd/` | Unit file templates in-repo |

## Layer index
| Layer | Path | Description |
|---|---|---|
| L1 Facts | `facts/*.yaml` | Structured YAML: ports, paths, services, systemd units |
| L2 State | `state/*.md` | Living status, next actions, binding decisions |
| L3 Runbooks | `runbooks/troubleshooting/` | Symptom-first playbooks |
| L3 Module context | `app/_context/` | Per-module summaries (~250 words each) |
| L4 History | `sessions/` | Append-only agent journal |

## Related docs
- Agent refactor handoff: `docs/AGENT_REFACTOR_HANDOFF.md`
- Adding a new server type: `docs/ADDING_SERVERS.md`
- Usage guide: `docs/USAGE.md`
