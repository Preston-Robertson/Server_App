# app/_context/updater.md
# Context summary for app/updater.py (174 lines).

## Purpose
Self-update trigger for the manager: delegates the actual update work (git pull, pip install, systemctl restart) to a dedicated systemd oneshot unit (`gamesrv-updater.service`) so the update lives in its own cgroup and survives the manager restart at the end.

## Public API
- `trigger_update()` → `dict` (`{ok, already_running, message}`)
- `read_update_log(lines=200)` → `str` (tails `/opt/gamesrv/logs/update.log`, falls back to journalctl)
- `UPDATER_UNIT = "gamesrv-updater.service"`

## Called by
`app/main.py` (`POST /api/manager/update` and `GET /api/manager/update/log` endpoints).

## Calls / depends on
`app.config.settings`, `subprocess` (`systemctl start --no-block`, `journalctl`), `pathlib`, `os`, `time`.

## Key invariants / gotchas
- **`--no-block`**: `systemctl start --no-block` returns immediately; the manager keeps serving requests while the oneshot runs. The update eventually calls `systemctl restart gamesrv-manager.service`.
- **Double-fire guard**: if the updater unit is already `activating`, `trigger_update()` returns `{ok: False, already_running: True}` without starting another instance.
- **Log file**: `update.sh` tees its output to `logs/update.log` AND the systemd journal. `read_update_log` prefers the file (fast) but falls back to journalctl when the file is missing (e.g., immediately after first button click).
- **Requires polkit rule**: the `gamesrv` user can only start `gamesrv-updater.service` because `scripts/49-gamesrv.rules` grants it. Missing polkit rule → `systemctl start` returns non-zero → HTTP 500.
- **The actual update logic is in `update.sh`**: this module is a thin trigger. To change update behavior, edit `update.sh`.

## Common failure modes
- HTTP 500 "failed to start updater": polkit rule not installed (bootstrap.sh not run as root, or polkit not available).
- `read_update_log` returns empty / "journalctl" fallback: update just triggered and file doesn't exist yet; or `APP_DIR/logs/` doesn't exist.
- Update starts but manager never comes back: `update.sh` rollback path failed; check the journal for `gamesrv-updater.service`.

## Where to change what
- Change update behavior (git branch, venv reinstall, rollback): edit `update.sh`.
- Change log location: `LOG_FILE` in `update.sh` + `read_update_log()` in this module.
- Change the updater unit name: `UPDATER_UNIT` constant here + unit file in `systemd/`.
