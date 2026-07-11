# Runbook: Firewall Port Conflict

## Symptoms
- Game is running (systemctl shows active) but players can't connect from LAN.
- `port_allowed()` returns False or None for the game port.
- Players see "Connection timed out" or "No route to host".
- Firewall snapshot shows no managed rule for the server, or wrong mode.

## Log locations
- **Manager journal**: `journalctl -u gamesrv-manager.service --since '30 min ago' | grep firewall`
- **UFW status**: `sudo ufw status verbose`

## Diagnostic commands
```bash
# Check UFW status and managed rules
sudo ufw status numbered | grep gamesrv-auto

# Check if the game port is allowed at all
sudo ufw status | grep <port>

# Check LAN CIDR in use (default: 10.0.0.0/24)
journalctl -u gamesrv-manager.service | grep 'lan_cidr\|LAN_CIDR'

# Verify manager can run ufw via sudo
sudo -n /usr/sbin/ufw status  # should not prompt for password

# Check sudoers drop-in exists
cat /etc/sudoers.d/gamesrv-ufw

# Manually trigger reconcile (if API available)
curl -X POST -H "Authorization: ******" http://localhost:8765/api/firewall/reconcile/<name>
```

## Common causes

### 1. UFW not installed / inactive
- `app/firewall.py` fails soft when UFW isn't installed. If UFW was recently enabled or installed, run a reconcile.
- **Fix**: `sudo ufw enable` (if needed), then trigger reconcile via the API or restart the manager.

### 2. Sudoers drop-in missing
- **Cause**: `bootstrap.sh` not run (or run before UFW was installed).
- **Symptom**: Manager journal shows "sudo: command not found" or "sudo: Operation not permitted".
- **Fix**: Re-run `sudo bash /opt/gamesrv/bootstrap.sh` (idempotent).

### 3. Wrong LAN CIDR
- **Cause**: LAN is not `10.0.0.0/24`. The `GAMESRV_LAN_CIDR` env var is not set, so the default is used.
- **Fix**: Add `GAMESRV_LAN_CIDR=192.168.1.0/24` (or your actual LAN) to `/etc/gamesrv.env`, restart manager.

### 4. Firewall mode set to "lan" but player is on a different subnet
- **Cause**: Server YAML has `firewall.mode: lan` but the player's IP is outside `LAN_CIDR`.
- **Fix**: Change `firewall.mode` to `allowlist` and add the player's subnet to `firewall.allow_ips`, or set `mode: public` (only safe with game-level access controls or Tailscale).

### 5. Managed rules not reconciled after YAML change
- **Cause**: YAML was edited manually without triggering a save/reconcile.
- **Fix**: Save the server def via the dashboard (which triggers `reconcile_server()`), or restart the manager (startup calls `reconcile_all()`).

### 6. Satisfactory TCP 8888 missing
- **Cause**: `reconcile_server` should add TCP 8888 for Satisfactory (app ID 1690800) but didn't run.
- **Symptom**: Players join but disconnect seconds later with "Your connection to the host has been lost".
- **Fix**: Trigger reconcile for the Satisfactory server. Verify `sudo ufw status | grep 8888`.

## Related files/modules
- `app/firewall.py` — `reconcile_server()`, `reconcile_all()`, `snapshot()`, `port_allowed()`
- `app/_context/firewall.md` — full module summary
- `facts/ports.yaml` — per-game port reference
- `scripts/ufw-setup.sh` — initial LAN-lock setup (hand-added rules, never touched by manager)
