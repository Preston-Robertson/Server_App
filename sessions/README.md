# sessions/README.md
# Agent session journal — how to use this directory.

## Purpose
This directory is an **append-only agent journal**. Every agent session that makes significant changes to the repo (code, config, documentation, state) should leave a session log here.

## Why this exists
Without session logs, each new agent starts completely cold with no memory of what was tried, what broke, and what decisions were made. A 5-minute session log saves the next agent 30+ minutes of re-discovery.

## Naming convention
```
YYYY-MM-DD-<topic>.md
```
Examples:
- `2026-07-11-add-agent-docs.md`
- `2026-07-15-decompose-main-py.md`
- `2026-07-20-fix-watchdog-false-positive.md`

Use the date when the session **ends** (or the date you start if it spans midnight). The topic should be a short slug of the main thing you did.

## Rules
- **Append only**: never edit or delete existing session files.
- **One file per session**: create a new file; don't append to an existing one.
- **Use the template**: copy `_TEMPLATE.md`, fill it in.
- **Be honest about failures**: what broke is often more useful than what worked.
- **Keep it short**: the template fields keep it focused. 10–20 minutes to write; saves hours for the next agent.

## After writing your session log
1. Update `state/STATUS.md` with any status changes.
2. Check off completed items in `state/NEXT_ACTIONS.md`.
3. Add any non-obvious decisions to `state/DECISIONS.md`.
