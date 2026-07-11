# Runbook: Watchdog False Positive

## Symptoms
- Server auto-shuts down while players are (or were recently) connected.
- Dashboard shows server stopped unexpectedly.
- `journalctl -u gamesrv-manager.service | grep gamesrv-lifecycle` shows a `STOP` event triggered by watchdog.

## Log locations
- **Manager journal** (lifecycle events): `journalctl -u gamesrv-manager.service | grep gamesrv-lifecycle`
- **Watchdog probe activity**: `journalctl -u gamesrv-manager.service | grep watchdog` (if logged)
- **Per-server journal** (confirm graceful stop): `journalctl -u gamesrv@<name>.service --since '30 min ago'`

## Diagnostic commands
```bash
# Find who triggered the stop
journalctl -u gamesrv-manager.service --since '2 hour ago' | grep 'gamesrv-lifecycle.*STOP.*<name>'

# Check server's idle_shutdown_min setting
grep idle_shutdown_min /opt/gamesrv/servers/<name>.yml

# Check watchdog interval
# (hardcoded: WATCHDOG_INTERVAL_SEC = 15 in app/watchdog.py)

# Manually probe A2S (Steam) to see what watchdog sees
# (replace HOST/PORT; requires python3)
python3 -c "
import socket
q = b'\xff\xff\xff\xffTSource Engine Query\x00'
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(3)
s.sendto(q, ('127.0.0.1', <port>))
try:
    d, _ = s.recvfrom(4096)
    print('Got response, length:', len(d))
    print('Players byte (offset 8+name+map+folder+game+2):', 'parse manually')
except: print('No response / timeout')
"
```

## Common causes

### 1. A2S probe reports 0 players incorrectly (game bug)
- **Cause**: Some games implement A2S_INFO but return 0 players even when clients are connected. Satisfactory is the documented case.
- **Fix for Satisfactory**: The watchdog routes Satisfactory through HTTPS Server API. Ensure `passwords.admin_password` is set in the server YAML (required for accurate count on password-protected servers).
- **Fix for other games**: Consider setting `idle_shutdown_min: null` to disable idle-shutdown for that server.

### 2. `idle_shutdown_min` too short
- **Cause**: Server set to stop after e.g. 5 minutes; probe fails transiently for 5+ minutes while players are connecting.
- **Fix**: Increase `idle_shutdown_min` to a more generous value (e.g., 30 minutes).

### 3. `ever_saw_player` gate not triggered
- **Cause**: Watchdog only starts the countdown after at least one player has been observed. But if probes consistently fail during the player's session, `ever_saw_player` may never be set.
- **Symptom**: Server stops shortly after the player joins but before the probe succeeds.
- **Fix**: This is a known edge case `(likely — verify)`. Increase `PROBE_TIMEOUT_SEC` (hardcoded in `watchdog.py`) or disable idle-shutdown for games with unreliable probes.

### 4. Consecutive probe failures trigger stop
- **Cause (not current behavior)**: Current code does NOT stop on probe failures — it only stops on confirmed 0 players. Probe failures are counted but not acted on. If you're seeing false-positive stops, the probe IS returning players=0 (not timing out).

### 5. Game's A2S response delays after map change / world load
- **Cause**: Some games (ARK, Palworld) stop responding to A2S during a heavy world-save or map transition. If this overlaps the empty-since window, a false shutdown may occur.
- **Fix**: Increase `idle_shutdown_min` or disable idle-shutdown for that server.

## Related files/modules
- `app/watchdog.py` — `Watchdog._tick()`, `_probe_for()`, `ever_saw_player`, `probe_a2s()`, `probe_mc_slp()`
- `app/_context/watchdog.md` — full module summary
- `app/control.py` — `_log_lifecycle()` (confirms who triggered the stop)
- `app/registry.py` — `ServerDef.idle_shutdown_min`
