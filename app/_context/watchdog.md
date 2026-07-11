# app/_context/watchdog.md
# Context summary for app/watchdog.py (610 lines).

## Purpose
Idle-shutdown watchdog: a background thread that polls running servers' player counts every 15 seconds via game-native query protocols (A2S_INFO for Steam games, SLP for Minecraft, HTTPS API for Satisfactory) and automatically stops servers that have been empty for `idle_shutdown_min` minutes.

## Public API
- `watchdog = Watchdog()` — singleton at module level
- `watchdog.start()` → None (called from `main.py` startup)
- `watchdog.stop()` → None
- `watchdog.server_state(name)` → `Optional[_State]` (current probe state: players, ready timestamp, empty-since)
- `probe_a2s(host, port, timeout)` → `Optional[ProbeResult]` (used by wake_proxy too)
- `probe_mc_slp(host, port, timeout)` → `Optional[ProbeResult]`
- `probe_supported(sd)` → `bool`

## Called by
`app/main.py` (`_startup()` calls `watchdog.start()`; detail endpoint reads `watchdog.server_state()`). `app/wake_proxy.py` imports `probe_a2s` and `probe_mc_slp` directly for wake-readiness checks.

## Calls / depends on
`app.control` (`control.status()` to check if server is active, `control.stop()` to shut it down), `app.registry` (`list_defs()`), `http.client`, `ssl`, `socket`, `struct`, `threading`.

## Key invariants / gotchas
- **`ever_saw_player` gate**: idle-shutdown countdown only starts after at least one player has connected during the current run. Prevents auto-killing a freshly-booted server before anyone joins.
- **Single probe failure = ignored**: `consecutive_probe_fails` is tracked but only used for surfacing state; a single timeout doesn't trigger any action.
- **Satisfactory**: A2S_INFO is unreliable (often reports 0 players). Routes through HTTPS Server API (`QueryServerState`). Requires `passwords.admin_password` for accurate player count on password-protected servers; falls back to `HealthCheck` (ready/not-ready only) on open servers.
- **`first_ready_ms`**: set on first successful probe. Used by the dashboard to flip from "starting" to "running".
- **State is in-memory only**: manager restart resets all timers.
- `WATCHDOG_INTERVAL_SEC = 15`, `PROBE_TIMEOUT_SEC = 3.0`.
- All probes are to `127.0.0.1` (loopback) regardless of configured bind address.

## Common failure modes
- **False positive idle-shutdown**: probe times out repeatedly while players are actually connected. The `ever_saw_player` gate partially mitigates this but doesn't eliminate it. Mark as `(likely — verify)`.
- **Satisfactory player count always 0**: no admin password configured, server uses password protection → HealthCheck succeeds but `QueryServerState` returns 401 → `players=None` → countdown never runs.
- **Watchdog stops a server the operator just started**: if `idle_shutdown_min` is short (e.g. 5) and the operator starts a server but no one joins within that window.

## Where to change what
- Add probe support for a new game type: add a branch in `_probe_for(sd)`.
- Change poll interval: `WATCHDOG_INTERVAL_SEC` constant.
- Change probe timeout: `PROBE_TIMEOUT_SEC` constant.
- Change idle-shutdown logic: `Watchdog._tick()` method.
