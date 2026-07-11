# app/_context/control.md
# Context summary for app/control.py (394 lines).

## Purpose
systemctl / journalctl / tmux wrappers that manage game server lifecycle: start, stop, restart, enable, disable, status polling, log tailing, and console interaction via tmux send-keys.

## Public API
- `start(sd)` / `stop(sd)` / `restart(sd)` / `enable(sd)` / `disable(sd)` → `subprocess.CompletedProcess`
- `status(sd)` → `ServerStatus` dataclass (active, sub, enabled, pid, mem_bytes, cpu_usec, uptime_sec, n_restarts)
- `tail_logs(sd, lines=200)` → `str` (journalctl output)
- `console_available(sd)` → `bool` (checks tmux session exists)
- `send_console(sd, command)` → None (sends keys via tmux)
- `graceful_console_stop(sd)` → None (sends stop_cmd via tmux)
- `wait_tcp_port_free(port, timeout=90.0)` → `bool`
- `shell_quote(s)` → `str`

## Called by
`app/main.py` (all lifecycle API endpoints), `app/watchdog.py` (idle-shutdown calls `control.stop`), `app/wake_proxy.py` (wake worker calls `control.start` then polls `control.status`).

## Calls / depends on
`subprocess`, `socket` (for port-bind probe), `tmux` CLI, `systemctl`, `journalctl`, `/proc/<pid>/status`, `/proc/uptime`.

## Key invariants / gotchas
- **tmux session name**: `gs-<server-name>`. Socket flag `-L gs-<name>` used so each server has its own private tmux server (avoids session name collisions across servers).
- **`_STOP_TIMEOUT_SEC = 330`**: exceeds the unit's `TimeoutStopSec=300` so subprocess.run doesn't raise `TimeoutExpired` for a stop systemd would complete.
- **Memory sanity fallback**: if `MemoryCurrent` from systemd < 8 MiB for an active unit, falls back to summing the tmux session's process-tree RSS via `/proc`. Fixes "848 KB" display bug for games whose process tree escapes the cgroup.
- **`_log_lifecycle()`**: emits a caller-chain line to stderr on every start/stop/restart. Search journal for `gamesrv-lifecycle` to trace who triggered a lifecycle event.
- **n_restarts**: if non-zero with low uptime, signals a crash-restart loop (even with `Restart=no`, `NRestarts` counts manual restarts).
- `wait_tcp_port_free` probes by actually attempting `bind()` (without SO_REUSEADDR) — same condition FactoryServer (Satisfactory) will see.

## Common failure modes
- **journalctl returns empty**: manager user not in `systemd-journal` group. Fix: `usermod -aG systemd-journal gamesrv`. `tail_logs` detects this and returns an actionable error message.
- **tmux session missing**: `send_console` raises `RuntimeError("tmux session not available")` — game must be running.
- **status shows wrong memory**: tmux process tree escaped cgroup; the sanity fallback should catch this, but if tmux isn't installed, `_tmux_tree_rss_bytes` returns None.

## Where to change what
- Add a new lifecycle action: add a function here + wire it in `main.py::api_action`.
- Change stop timeout: `_STOP_TIMEOUT_SEC` constant (must stay > `TimeoutStopSec` in the unit).
- Change tmux session naming: `_session(name)` function (must match what `app/types/*.py` generates in `start.sh`).
