# Runbook: High CPU or Memory

## Symptoms
- Dashboard RAM bar near or at 100%.
- LXC becomes unresponsive or game servers lag.
- `top` / `htop` shows a game process or the manager consuming excessive CPU.
- OOM kills in `dmesg`.

## Log locations
- **Dashboard**: Header stats bar shows aggregate RAM + per-server RAM.
- **Manager perf history**: `/api/stats` returns current; perf_sampler holds 24h history.
- **Kernel OOM log**: `dmesg | grep -i 'oom\|killed'`
- **Per-server memory**: Dashboard → server card shows current RSS.

## Diagnostic commands
```bash
# Current memory by process
ps aux --sort=-%mem | head -20

# Per-server cgroup memory (if cgroup v2)
cat /sys/fs/cgroup/system.slice/gamesrv@<name>.service/memory.current

# Or via manager's systemctl show:
systemctl show gamesrv@<name>.service --property=MemoryCurrent

# Check LXC cgroup limit
cat /sys/fs/cgroup/memory.max 2>/dev/null || \
  cat /sys/fs/cgroup/memory/memory.limit_in_bytes

# Check disk I/O (heavy I/O can look like CPU load)
iostat -x 1 5

# Check for runaway SteamCMD (install/update job)
pgrep -a steamcmd
```

## Common causes

### 1. Too many servers running simultaneously
- **Fix**: Stop low-priority servers. Dashboard → stop servers with few/no players.
- Use `idle_shutdown_min` to automatically stop idle servers.

### 2. Game server memory leak / world too large
- **Cause**: Some modded packs (Forge + many mods) gradually consume more RAM over days.
- **Fix**: Restart the server. For Minecraft: consider enabling GC tuning in `java_args`.

### 3. SteamCMD install/update consuming RAM
- **Cause**: An active install job runs steamcmd in the background.
- **Fix**: Wait for it to complete. Check job status in dashboard.

### 4. Manager itself consuming high RAM
- **Cause**: Unusual — the FastAPI manager is lightweight. Check for a memory leak in a background thread.
- **Diagnostic**: `cat /proc/$(pgrep -f uvicorn)/status | grep VmRSS`

### 5. Memory reported incorrectly ("848 KB" for a running game)
- **Cause**: Game process escaped the cgroup (tmux process tree issue). The dashboard RAM figure is wrong, not the actual usage.
- **Fix**: `app/control.py` has a sanity fallback to sum the tmux session's RSS. This should self-correct. If not, check tmux installation.
- See: `app/_context/control.md` → "Memory sanity fallback".

### 6. OOM kill loop
- **Cause**: LXC memory limit too low for the configured servers.
- **Fix**: Increase LXC memory in Proxmox, or reduce `memory_mb` in server YAMLs (pre-flight check uses these values).

## Related files/modules
- `app/perf.py` — `PerfSampler`, 24h RAM history
- `app/_context/perf.md` — perf module summary
- `app/control.py` — `_tmux_tree_rss_bytes()`, `_CGROUP_MEM_SANITY_FLOOR`
- `app/main.py` — RAM pre-flight check (507 guard), `_read_cgroup_mem_limit()`
- `facts/ports.yaml` — (not directly related, but useful for understanding traffic load)
