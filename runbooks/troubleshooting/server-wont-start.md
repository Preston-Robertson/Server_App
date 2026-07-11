# Runbook: Server Won't Start

## Symptoms
- Dashboard shows server as "failed" or stuck on "◐ starting" indefinitely after clicking Start.
- `systemctl status gamesrv@<name>` shows `ActiveState=failed` or `SubState=dead`.
- No process visible for the game.

## Log locations
- **Systemd unit**: `journalctl -u gamesrv@<name>.service -n 100 --no-pager`
- **Manager journal** (for pre-flight refusals): `journalctl -u gamesrv-manager.service --since '5 min ago'`
- **Game's own start log** (if generated): `/srv/gameservers/<name>/console.log` (verify unit name in `facts/systemd-units.yaml`)

## Diagnostic commands
```bash
# Check unit state
systemctl status gamesrv@<name>.service

# View recent unit logs
journalctl -u gamesrv@<name>.service -n 100 --no-pager

# Check if start.sh exists and is executable
ls -la /srv/gameservers/<name>/start.sh

# Check install dir ownership (must be gamesrv:gamesrv)
ls -la /srv/gameservers/<name>/

# Check available disk space
df -h /srv/gameservers /opt/gamesrv/worlds

# Check if port is already in use (replace 7777 with server port)
ss -tlnup | grep <port>
```

## Common causes

### 1. `start.sh` missing or not executable
- **Cause**: Server was never installed. The Install action generates `start.sh`.
- **Fix**: Dashboard → Control tab → Install. Wait for job to complete, then Start.

### 2. RAM pre-flight refused (HTTP 507)
- **Cause**: Sum of all running servers' `memory_mb` + this server's `memory_mb` exceeds the LXC's cgroup limit. Manager returns 507 before calling systemctl.
- **Fix**: Stop another running server first, or reduce `memory_mb` in the server's YAML. Check `facts/paths.yaml` for cgroup memory.

### 3. Wrong install directory ownership
- **Cause**: Files in `/srv/gameservers/<name>/` owned by root instead of `gamesrv`.
- **Fix**: `sudo chown -R gamesrv:gamesrv /srv/gameservers/<name>/`

### 4. Port already in use (TIME_WAIT or another process)
- **Cause**: Previous server instance's TCP socket still in TIME_WAIT, or another process bound the port.
- **Fix**: Wait 60–120 s for TIME_WAIT to clear (manager's `wait_tcp_port_free` handles this for Satisfactory automatically). For Satisfactory, check TCP 8888 is free.

### 5. LimitNOFILE too low (Unreal Engine games: Palworld, ARK, Satisfactory)
- **Cause**: System ulimit below 100000. The template unit sets `LimitNOFILE=100000`; if the unit file wasn't redeployed after an update, the old value may be in effect.
- **Fix**: `sudo systemctl daemon-reload` then retry. Verify: `cat /proc/<game_pid>/limits | grep open`

### 6. Crash-restart loop (NRestarts > 0)
- **Cause**: Game binary exits immediately on start (missing dependency, wrong Java version for Minecraft, etc.).
- **Fix**: Check `journalctl -u gamesrv@<name>.service -n 200 --no-pager` for the exit reason. For Minecraft: verify Java version matches `mc_version`.

## Related files/modules
- `app/control.py` — `start()`, `status()`, `_log_lifecycle()`
- `app/main.py` — RAM pre-flight check in `api_action`
- `facts/systemd-units.yaml` — unit names
- `facts/paths.yaml` — install dir location
- `systemd/gamesrv@.service` — LimitNOFILE, Restart=no, PrivateTmp notes
