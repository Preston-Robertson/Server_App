# Runbook: systemd Unit Crash Loop

## Symptoms
- Server card on dashboard shows "◐ starting" forever, never "✓ running".
- `NRestarts` counter in server status is incrementing.
- Server uptime resets every few seconds or minutes.
- Dashboard may show "restart loop (N)" if the UI surfaces NRestarts.

## Log locations
- **Unit journal**: `journalctl -u gamesrv@<name>.service -n 200 --no-pager`
- **Manager journal**: `journalctl -u gamesrv-manager.service | grep gamesrv-lifecycle`

## Diagnostic commands
```bash
# Full unit status
systemctl status gamesrv@<name>.service

# Recent logs with timestamps
journalctl -u gamesrv@<name>.service --since '30 min ago' --no-pager

# Check exit code of last execution
systemctl show gamesrv@<name>.service --property=ExecMainStatus

# Check NRestarts (should be 0 for a healthy unit with Restart=no)
systemctl show gamesrv@<name>.service --property=NRestarts

# Check if start.sh has exec permission
ls -la /srv/gameservers/<name>/start.sh

# Check console.log written by start.sh (if exists)
tail -50 /srv/gameservers/<name>/console.log 2>/dev/null
```

## Common causes

### 1. `Restart=no` (normal — crash stays failed, not a loop)
- The template unit uses `Restart=no` intentionally. With `Restart=no`, `NRestarts` only increments on MANUAL restarts (operator clicking Restart), not automatic ones.
- A unit stuck in "failed" with NRestarts=0 is not a crash loop — it's a crashed-and-stayed-dead unit. Read the exit reason from the journal.

### 2. Per-server drop-in `Restart=on-failure` causing real loop
- **Cause**: A drop-in override at `/etc/systemd/system/gamesrv@<name>.service.d/restart.conf` sets `Restart=on-failure`.
- **Symptom**: NRestarts keeps climbing; uptime resets frequently; journal shows same startup sequence repeating.
- **Fix**: Remove or edit the drop-in: `rm /etc/systemd/system/gamesrv@<name>.service.d/restart.conf && systemctl daemon-reload`.

### 3. Game binary missing after reinstall / bad install
- **Symptom**: start.sh exits immediately with "No such file or directory" for the game executable.
- **Fix**: Run Install again from the dashboard.

### 4. Minecraft: wrong Java version
- **Symptom**: JVM exits with "Unsupported class file major version" in the journal.
- **Fix**: Install correct Java version. 1.20.x needs Java 17, 1.21.x needs Java 21.

### 5. Minecraft Forge: missing `run.sh` or EULA not accepted
- **Symptom**: `run.sh: not found` or "You need to agree to the EULA" in the journal.
- **Fix**: Upload the Forge server tree; set `eula=true` in `eula.txt`.

### 6. OOM kill
- **Symptom**: `journalctl -u gamesrv@<name>` shows "Killed" with no other message; `dmesg | grep -i oom` shows OOM killer.
- **Fix**: Reduce other servers' load, increase LXC memory, or add a per-server MemoryMax drop-in.

## Related files/modules
- `app/control.py` — `status()`, `_log_lifecycle()`, `NRestarts` handling
- `systemd/gamesrv@.service` — `Restart=no` rationale comments
- `state/DECISIONS.md` — "Restart=no in gamesrv@.service is intentional"
