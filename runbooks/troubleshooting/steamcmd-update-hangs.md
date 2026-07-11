# Runbook: SteamCMD Update Hangs

## Symptoms
- Install or update job is running for >20 minutes with no progress.
- Job progress bar stuck at a specific percentage.
- Dashboard job tail stops scrolling.
- `steamcmd` process consuming CPU but not making progress.

## Log locations
- **Job tail**: Dashboard → server → job progress tab (live tail).
- **Manager journal**: `journalctl -u gamesrv-manager.service --since '30 min ago' | grep -i steam`
- **SteamCMD output** (if piped to file): `/tmp/steamcmd-<name>.log` (verify with manager code — path may differ).

## Diagnostic commands
```bash
# Check if steamcmd process is running
pgrep -a steamcmd

# Check network connectivity to Steam CDN
curl -I https://steamcdn-a.akamaihd.net/ --connect-timeout 5

# Check available disk space
df -h /srv/gameservers/<name>

# Check if Steam depot is rate-limiting (look for throttle messages)
journalctl -u gamesrv-manager.service | grep -i 'throttle\|rate\|429\|steam'

# Kill a stuck steamcmd and let job fail cleanly
pkill -f steamcmd
```

## Common causes

### 1. Steam CDN bandwidth throttle
- **Symptom**: Progress stalls at a specific percentage, then resumes slowly or not at all.
- **Fix**: Wait it out (Steam CDN throttles anonymous downloads). Try at a different time of day. No workaround available without a Steam account.

### 2. Disk full
- **Symptom**: SteamCMD exits with an error about disk space. Job tail shows write error.
- **Fix**: Free up space in `/srv/gameservers` (check `df -h`). Delete old update cache in `~/.steam/` or `/home/gamesrv/.steam/`.

### 3. SteamCMD binary missing or corrupt
- **Fix**: Re-run `sudo bash /opt/gamesrv/bootstrap.sh` to reinstall SteamCMD.

### 4. Network timeout / Steam outage
- **Symptom**: SteamCMD reports "Timeout downloading item" or connection errors.
- **Fix**: Check https://store.steampowered.com for Steam status. Wait and retry.

### 5. File handle limit too low
- **Symptom**: SteamCMD crashes with "Too many open files".
- **Fix**: Ensure `LimitNOFILE=100000` is in `systemd/gamesrv@.service` and `sudo systemctl daemon-reload` was run.

### 6. Previous incomplete download locked
- **Symptom**: SteamCMD immediately exits with "App already installed" or lock file error.
- **Fix**: 
  ```bash
  rm -f /srv/gameservers/<name>/.steam_lock 2>/dev/null || true
  # Or remove partially downloaded depot:
  rm -rf /srv/gameservers/<name>/steamapps/downloading/
  ```

## Related files/modules
- `app/updater.py` — `trigger_update()` (for manager self-update, not game update)
- `app/jobs.py` — background job registry
- `app/types/steamcmd.py` — SteamCMD invocation logic (verify exact commands/paths in source)
- `facts/services.yaml` — per-game steam_app_id values
