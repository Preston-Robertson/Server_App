# Troubleshooting Runbooks — Index
<!-- Read this before diving into a specific runbook. -->

## How to use these runbooks
1. **Identify your symptom** from the list below.
2. Open the matching runbook file.
3. Each runbook follows the same structure: Symptoms → Log locations → Diagnostic commands → Common causes → Fix procedures → Related files/modules.
4. Commands use `<placeholder>` syntax. Verify unit names against `facts/systemd-units.yaml` and paths against `facts/paths.yaml`.

## Runbook index

| File | Symptom |
|---|---|
| `server-wont-start.md` | A server stays "failed" or "inactive" after clicking Start |
| `wake-proxy-not-triggering.md` | Server doesn't wake when a player connects |
| `firewall-port-conflict.md` | Game port blocked; players can't connect |
| `git-backup-failing.md` | World backup push to GitHub fails |
| `steamcmd-update-hangs.md` | Install or update job stalls / never completes |
| `systemd-unit-crash-loop.md` | Server flips between "starting" and "failed" repeatedly |
| `high-cpu-or-memory.md` | LXC CPU or RAM at 100%; dashboard shows high usage |
| `upload-fails.md` | File upload to install or world area fails |
| `watchdog-false-positive.md` | Server auto-shuts-down while players are connected |

## General tips
- **Logs first**: most issues are diagnosed in 30 seconds by reading the right log.
- **Check `facts/systemd-units.yaml`** for the correct unit name before running `systemctl` commands.
- **Check `facts/paths.yaml`** for directory locations before running `ls` commands.
- **Journal**: `journalctl -u gamesrv-manager.service --since '30 min ago'` for manager errors.
- **Per-server journal**: `journalctl -u gamesrv@<name>.service --since '30 min ago'`.
