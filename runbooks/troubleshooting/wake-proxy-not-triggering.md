# Runbook: Wake Proxy Not Triggering

## Symptoms
- Server has `wake_on_demand: true` but game doesn't start when a player connects.
- Dashboard shows server as "stopped" despite player connection attempts.
- Wake proxy status (if surfaced in dashboard) shows the server as not waking.
- Players see "Connection refused" or timeout instead of a loading screen.

## Log locations
- **Manager journal**: `journalctl -u gamesrv-manager.service --since '10 min ago' | grep wake_proxy`
- **Proxy activity**: look for `[wake_proxy] <name>:` lines in the manager journal.

## Diagnostic commands
```bash
# Check manager journal for wake_proxy activity
journalctl -u gamesrv-manager.service --since '10 min ago' | grep -i wake

# Verify public port is owned by the manager (not the game directly)
ss -tlnup | grep <port>
# Should show 'python' (uvicorn/manager), NOT the game binary

# Verify game's internal port (public_port + 10000)
ss -tlnup | grep <internal_port>

# Check if server has wake_on_demand in its YAML
grep wake_on_demand /opt/gamesrv/servers/<name>.yml

# Check wake_proxy singleton status (if API endpoint available)
curl -H "Authorization: ******" http://localhost:8765/api/wake
```

## Common causes

### 1. `wake_on_demand: true` not set in server YAML
- **Fix**: Edit the server YAML, set `wake_on_demand: true`, save. Reinstall the server (Install action regenerates `start.sh` with `port + 10000`).

### 2. Reinstall not done after toggling `wake_on_demand`
- **Cause**: `start.sh` still binds the original port. The proxy and game both try to own the same port.
- **Fix**: Control tab → Install (regenerates `start.sh` with correct internal port). Then Start.

### 3. Port already bound by game process (race condition)
- **Cause**: Game started manually or from a different path before the proxy bound the port.
- **Fix**: Stop the game manually, restart the manager (`sudo systemctl restart gamesrv-manager.service`). The proxy re-binds on startup.

### 4. Minecraft wake whitelist blocking
- **Cause**: `wake_whitelist` is non-empty and the connecting player's username is not on the list.
- **Symptom**: Player receives a disconnect message like "Server is sleeping — you are not on the wake whitelist".
- **Fix**: Add the player's Minecraft username (case-insensitive) to `wake_whitelist` in the server YAML.

### 5. Wake timeout too short
- **Cause**: `wake_timeout_sec` (default 90 s) too short for a heavy game (ARK, Enshrouded/Wine can take 3+ minutes).
- **Fix**: Increase `wake_timeout_sec` in the server YAML (e.g., `wake_timeout_sec: 180`).

### 6. UDP: A2S probe failing for Satisfactory
- **Cause**: Wake proxy for UDP games promotes to "running" on systemctl-active (not A2S). If promotion already happened but client packets still drop: game crashed after promotion.
- **Fix**: Check game journal, restart server manually.

## Related files/modules
- `app/wake_proxy.py` — `WakeProxy` class, `WAKE_INTERNAL_OFFSET = 10000`
- `app/_context/wake_proxy.md` — full module summary
- `app/watchdog.py` — `probe_a2s`, `probe_mc_slp` (also used by wake_proxy for readiness)
- `app/registry.py` — `ServerDef.wake_on_demand`, `wake_timeout_sec`, `wake_whitelist`
- `facts/ports.yaml` — `wake_on_demand.internal_port_offset`
