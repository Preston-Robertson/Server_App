# GitHub Copilot Instructions — Server_App

<!-- This file is auto-loaded by GitHub Copilot for every coding session in this repo. -->

## Start every session here
**Always read `AGENTS.md` at the repo root before doing any work.** It tells you:
- Which layer to load for your task (facts / state / runbooks / module context)
- Which files are large and should NOT be opened cold
- The current architecture and subsystem map

## Large-file rule (context budget)
Before opening any of these, read its `app/_context/` summary first:
- `app/main.py` (~2100 lines) → read `app/_context/main.md` first
- `app/wake_proxy.py` (~1120 lines) → read `app/_context/wake_proxy.md` first
- `app/watchdog.py` (~610 lines) → read `app/_context/watchdog.md` first
- `README.md` is the **end-user manual** — do NOT open it for internal/agent work

## New routes / endpoints
- **Do NOT add new endpoints to `app/main.py`** once the Layer B refactor lands.
- New endpoints go in `app/routes/<domain>.py` as an `APIRouter`.
- See `state/DECISIONS.md` for the binding decision on this, and
  `docs/AGENT_REFACTOR_HANDOFF.md` for the refactor spec.

## Secrets
- **Never commit secrets.** `/etc/gamesrv.env` stays off-disk.
- Use `.env.example` for key names only. Reference env var *names*, not values.
- Per-server passwords live in server YAMLs (`servers/<name>.yml`) which must
  stay out of any public git remote.

## Before proposing large changes
1. Run a smoke test: `curl http://localhost:8765/healthz` (or equivalent).
2. Read the relevant `app/_context/<module>.md` to understand invariants.
3. Check `state/DECISIONS.md` for decisions you must not revert.

## After completing work
- Append `sessions/YYYY-MM-DD-<topic>.md` (use `sessions/_TEMPLATE.md`).
- Update `state/STATUS.md` and `state/NEXT_ACTIONS.md`.
- Log any non-obvious decision in `state/DECISIONS.md`.

## Key conventions
- All auth goes through `app/auth.py::require_token` — do not inline token checks.
- All firewall changes go through `app/firewall.py::reconcile_server` — do not call `ufw` directly.
- All job tracking goes through `app/jobs.py::registry` — do not spawn bare threads for long ops.
- Logging: print to `sys.stderr` with a `[module]` prefix (e.g. `[firewall]`, `[wake_proxy]`).
