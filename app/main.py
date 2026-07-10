"""FastAPI entrypoint. Routes:

  GET  /                          — dashboard
  GET  /healthz                   — health check (unauthenticated)
  GET  /api/stats                 — aggregate dashboard header stats
  GET  /api/servers               — list defs + status
  POST /api/servers               — create/update a def
  DEL  /api/servers/{name}        — remove a def (does NOT delete files)
  GET  /api/servers/{name}        — full detail
  POST /api/servers/{name}/action — start/stop/restart/enable/disable
  POST /api/servers/{name}/install — kick off type-handler install (async job)
  POST /api/servers/{name}/update  — kick off type-handler update (async job)
  GET  /api/servers/{name}/job     — current install/update job progress
  POST /api/servers/{name}/console — send a console command
  GET  /api/servers/{name}/logs   — journalctl tail
  GET  /api/servers/{name}/files  — list files under area (install|world)
  POST /api/servers/{name}/files  — upload a file
  GET  /api/servers/{name}/files/download  — download a file
  DEL  /api/servers/{name}/files  — delete a file
  POST /api/servers/{name}/backup — snapshot world_dir to tgz (async job)
  GET  /api/servers/{name}/backups — list snapshots
  POST /api/servers/{name}/restore — restore a snapshot (async job; server must be stopped)
  POST /api/manager/update        — self-update the manager from GitHub
  GET  /api/manager/update/log    — tail update.log

All /api endpoints require Bearer token. The dashboard prompts for it and
stores it in localStorage.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

import subprocess

from fastapi import Depends, FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from . import control, registry, uploads, updater, git_source, git_backup, env_file, jobs, watchdog, wake_proxy, perf, firewall, steam_profiles
from .auth import require_token
from .config import settings
from .types import handler_for


app = FastAPI(title="Game Server Manager", version="0.1.0")

_APP_ROOT = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(_APP_ROOT / "templates"))
app.mount("/static", StaticFiles(directory=str(_APP_ROOT / "static")), name="static")

# Manager start time — surfaced via /api/stats for the dashboard header.
import time as _time
_MANAGER_STARTED_MONO = _time.monotonic()


@app.on_event("startup")
def _startup() -> None:
    # Idle-shutdown watchdog: polls player counts and stops empty servers.
    # Servers without `idle_shutdown_min` set are ignored, so this is safe
    # to always run.
    watchdog.watchdog.start()
    # UDP wake-on-demand proxy. Only binds the public port of servers with
    # wake_on_demand=true; unmentioned defs incur zero cost.
    wake_proxy.wake_proxy.start()
    # Background RAM sampler for the dashboard history chart. Samples the
    # same aggregate the /api/stats endpoint returns, at a fixed cadence,
    # so the chart is smooth regardless of when the UI polls.
    perf.perf_sampler.start(_collect_ram_sample)
    # Reconcile per-server UFW rules against ServerDef.firewall on boot.
    # Fails soft if ufw isn't installed or sudoers isn't configured —
    # errors go to the journal, manager still starts.
    try:
        firewall.reconcile_all()
    except Exception as e:
        print(f"[startup] firewall.reconcile_all failed: {e}", flush=True)


# ---------- health / dashboard ----------

@app.get("/healthz", response_class=PlainTextResponse)
def healthz() -> str:
    return "ok"


@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("index.html", {"request": request})


def _read_cgroup_mem_limit() -> int | None:
    """Return the LXC / container memory limit in bytes, or None.

    Reads cgroup v2 first (memory.max), then falls back to v1
    (memory.limit_in_bytes). Both report "max" / a huge sentinel when no
    limit is set — treat those as None so the frontend can decide whether
    to divide by MemTotal instead.
    """
    try:
        with open("/sys/fs/cgroup/memory.max", encoding="ascii") as f:
            v = f.read().strip()
        if v and v != "max":
            n = int(v)
            if 0 < n < 10**18:
                return n
    except OSError:
        pass
    try:
        with open("/sys/fs/cgroup/memory/memory.limit_in_bytes", encoding="ascii") as f:
            n = int(f.read().strip())
        if 0 < n < 10**18:
            return n
    except (OSError, ValueError):
        pass
    return None


def _read_meminfo_total() -> int | None:
    try:
        with open("/proc/meminfo", encoding="ascii") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    kb = int(line.split()[1])
                    return kb * 1024
    except (OSError, ValueError, IndexError):
        pass
    return None


def _disk_usage(path: Path) -> dict | None:
    import shutil as _sh
    try:
        du = _sh.disk_usage(str(path))
        return {"total": du.total, "used": du.used, "free": du.free}
    except OSError:
        return None


@app.get("/api/stats", dependencies=[Depends(require_token)])
def api_stats() -> dict:
    """Aggregate stats for the dashboard header: server counts, combined
    RAM usage across all running servers, and disk usage of the install
    and world roots. Cheap enough to poll on the 5s dashboard refresh.
    """
    total = running = failed = stopped = 0
    ram_used = 0
    # "reserved" = memory_mb sum for servers that are currently active. A
    # stopped server's memory_mb doesn't consume anything on the host, so
    # counting it here would give a misleading "we're out of RAM" signal.
    ram_reserved = 0
    ram_configured = 0   # sum across all defs (informational only)
    for sd in registry.list_defs():
        total += 1
        try:
            st = control.status(sd)
        except Exception:
            continue
        cap_bytes = (sd.memory_mb or 0) * 1024 * 1024
        ram_configured += cap_bytes
        if st.active == "active":
            running += 1
            ram_reserved += cap_bytes
        elif st.active == "failed":
            failed += 1
        else:
            stopped += 1
        if st.mem_bytes:
            ram_used += st.mem_bytes

    limit = _read_cgroup_mem_limit()
    mem_total = _read_meminfo_total()
    # Prefer the LXC/container limit as the denominator; fall back to
    # MemTotal (which inside an LXC is usually the container's view anyway).
    ram_limit = limit or mem_total
    ram_percent = (100.0 * ram_used / ram_limit) if (ram_limit and ram_used) else 0.0
    ram_available = max(0, (ram_limit or 0) - ram_reserved) if ram_limit else 0

    return {
        "servers": {
            "total": total, "running": running,
            "failed": failed, "stopped": stopped,
        },
        "ram": {
            "used_bytes": ram_used,
            "limit_bytes": ram_limit,
            "reserved_bytes": ram_reserved,        # active-only (what's actually held)
            "configured_bytes": ram_configured,    # sum across all defs (informational)
            "available_bytes": ram_available,      # limit - reserved (headroom for a new start)
            "percent": round(ram_percent, 1),
        },
        "disk": {
            "install_root": _disk_usage(settings.install_root),
            "worlds_root":  _disk_usage(settings.worlds_root),
            "backup_root":  _disk_usage(settings.backup_root),
        },
        "manager": {
            "uptime_sec": int(_time.monotonic() - _MANAGER_STARTED_MONO),
        },
    }


def _ram_snapshot(exclude_name: str | None = None) -> dict:
    """Compute available RAM headroom right now.

    Reserved = sum of memory_mb for currently-active servers (optionally
    excluding one — used by the start pre-flight check so that restarting
    an already-active server doesn't double-count its own reservation).
    """
    reserved = 0
    for sd in registry.list_defs():
        if exclude_name is not None and sd.name == exclude_name:
            continue
        try:
            st = control.status(sd)
        except Exception:
            continue
        if st.active == "active":
            reserved += (sd.memory_mb or 0) * 1024 * 1024
    limit = _read_cgroup_mem_limit() or _read_meminfo_total() or 0
    return {
        "limit_bytes": limit,
        "reserved_bytes": reserved,
        "available_bytes": max(0, limit - reserved) if limit else 0,
    }


def _collect_ram_sample() -> dict:
    """Called by the background sampler. Returns one datapoint for the
    RAM history chart. Kept tiny — the sampler stores these verbatim."""
    running = 0
    ram_used = 0
    ram_reserved = 0
    for sd in registry.list_defs():
        try:
            st = control.status(sd)
        except Exception:
            continue
        if st.active == "active":
            running += 1
            ram_reserved += (sd.memory_mb or 0) * 1024 * 1024
        if st.mem_bytes:
            ram_used += st.mem_bytes
    limit = _read_cgroup_mem_limit() or _read_meminfo_total() or 0
    return {
        "t_ms": int(_time.time() * 1000),
        "used_bytes": ram_used,
        "reserved_bytes": ram_reserved,
        "limit_bytes": limit,
        "running": running,
    }


@app.get("/api/stats/history", dependencies=[Depends(require_token)])
def api_stats_history(minutes: int = 60) -> dict:
    """Rolling RAM history for the dashboard chart.

    ``minutes`` bounds how far back to return (1..1440). Points are
    sampled by a background thread at a fixed cadence (see perf.py) so
    the shape doesn't jitter with UI poll timing.
    """
    minutes = max(1, min(1440, int(minutes)))
    samples = perf.perf_sampler.history(minutes)
    return {
        "minutes": minutes,
        "sample_interval_sec": perf.SAMPLE_INTERVAL_SEC,
        "samples": samples,
    }


# ---------- server registry ----------

def _installed_state(sd) -> bool:
    """Cheap "did install run successfully" heuristic.

    Every handler writes ``install_dir/start.sh`` at the tail of its
    install(), so the presence of that script — with non-trivial size
    — is our marker. Custom servers ship start.sh by hand, in which
    case this correctly still reports installed.
    """
    try:
        p = Path(sd.install_dir) / "start.sh"
        if not p.exists():
            return False
        # Any non-empty file counts; empty is treated as "install didn't
        # actually run" so the card doesn't lie.
        return p.stat().st_size > 0
    except OSError:
        return False


def _job_snapshot(name: str) -> dict | None:
    """Compact job status for the /api/servers card, or None if no job
    is known for this server. Latest job replaces the previous one; if
    the last known job is done and stale we still surface a summary so
    the UI can flash "install failed" briefly."""
    j = jobs.registry.get(name)
    if not j:
        return None
    return {
        "kind": j.kind,
        "done": j.done,
        "ok": j.ok,
        "phase": j.progress.phase or ("" if j.done else "starting…"),
        "percent": round(j.progress.percent, 1),
        "error": j.error,
        "elapsed_sec": int((j.finished_at or _time.time()) - j.started_at),
    }


@app.get("/api/servers", dependencies=[Depends(require_token)])
def api_list_servers() -> list[dict]:
    out = []
    wd_snap = watchdog.watchdog.snapshot()
    wake_snap = wake_proxy.wake_proxy.snapshot()
    for sd in registry.list_defs():
        st = control.status(sd)
        out.append({
            "def": sd.model_dump(mode="json"),
            "status": {
                "active": st.active, "sub": st.sub, "enabled": st.enabled,
                "pid": st.pid, "mem_bytes": st.mem_bytes,
                "uptime_sec": st.uptime_sec,
                "n_restarts": st.n_restarts,
                "console_available": control.console_available(sd),
                "installed": _installed_state(sd),
                "probe_supported": watchdog.probe_supported(sd),
            },
            "watchdog": wd_snap.get(sd.name),
            "wake": wake_snap.get(sd.name),
            "job": _job_snapshot(sd.name),
        })
    return out


@app.get("/api/servers/{name}", dependencies=[Depends(require_token)])
def api_get_server(name: str) -> dict:
    sd = registry.load_def(name)
    st = control.status(sd)
    return {
        "def": sd.model_dump(mode="json"),
        "status": {
            "active": st.active, "sub": st.sub, "enabled": st.enabled,
            "pid": st.pid, "mem_bytes": st.mem_bytes,
            "uptime_sec": st.uptime_sec,
            "n_restarts": st.n_restarts,
            "console_available": control.console_available(sd),
            "installed": _installed_state(sd),
            "probe_supported": watchdog.probe_supported(sd),
        },
        "watchdog": watchdog.watchdog.snapshot().get(name),
        "wake": wake_proxy.wake_proxy.snapshot().get(name),
        "job": _job_snapshot(name),
        "backups": uploads.list_backups(sd, settings.backup_root),
    }


@app.post("/api/servers", dependencies=[Depends(require_token)])
def api_upsert_server(sd: registry.ServerDef) -> dict:
    # Diff against the on-disk def BEFORE saving so we can detect whether
    # any launch-affecting field changed. If it did AND the server is
    # currently running, we auto-restart it — otherwise the operator ends
    # up with a running game that no longer matches its own yaml (the
    # classic "I toggled wake_on_demand and now nothing works because
    # start.sh is stale AND the wake-proxy is fighting the game for the
    # port" trap). This is aggressive on purpose: silently letting the
    # runtime drift from the config is the #1 source of debugging pain.
    prev: Optional[registry.ServerDef] = None
    try:
        prev = registry.load_def(sd.name)
    except FileNotFoundError:
        prev = None
    except Exception:
        prev = None

    # Reject port collisions BEFORE writing anything — the second server
    # would silently fail at Start with "address already in use" and the
    # operator would have to dig through journalctl to figure out which
    # other server owned :{port}. Refuse loudly with an actionable message
    # instead. Compares against the running def set, so renaming/updating
    # a server to keep its own port is a no-op (prev.name == sd.name).
    for other in registry.list_defs():
        if other.name == sd.name:
            continue
        if int(other.port) == int(sd.port):
            raise HTTPException(
                status_code=409,
                detail=(
                    f"port {sd.port} is already used by server '{other.name}' "
                    f"(type={other.type}). Pick a different port for '{sd.name}' "
                    f"or delete/change the other server first."
                ),
            )

    registry.save_def(sd)

    # Always regenerate launch scripts so start.sh reflects the new yaml.
    # Non-fatal — a broken configure() shouldn't block a def save.
    try:
        handler_for(sd).configure()
    except Exception:
        pass

    # Reconcile firewall rules for this server. Non-fatal: even if UFW
    # isn't available (dev host, missing sudoers) the def still saves.
    try:
        fw_result = firewall.reconcile_server(sd)
    except Exception as e:
        fw_result = {"ok": False, "detail": f"exception: {e}"}

    # Fields that require the game process to be restarted for the change
    # to take effect (start.sh port, wake_on_demand toggle, memory cap,
    # per-game access/password launch flags, etc). Cosmetic fields
    # (auto_start_on_boot, backup, git_*) are excluded — they don't
    # affect the running process.
    _LAUNCH_AFFECTING = (
        "type", "port", "memory_mb", "java_args", "start_cmd", "stop_cmd",
        "steam_app_id", "steam_beta", "extra_env", "stop_timeout_sec",
        "wake_on_demand", "wake_timeout_sec", "wake_whitelist",
        "mc_version", "forge_version",
    )
    changed_fields: list[str] = []
    if prev is not None:
        for f in _LAUNCH_AFFECTING:
            if getattr(prev, f, None) != getattr(sd, f, None):
                changed_fields.append(f)
        # Nested pydantic models — compare via model_dump for structural equality.
        for f in ("access", "passwords", "rcon"):
            if getattr(prev, f, None).model_dump() != getattr(sd, f, None).model_dump():
                changed_fields.append(f)

    auto_restart: dict = {"attempted": False, "ok": False, "detail": ""}
    if changed_fields:
        try:
            st = control.status(sd)
            if st.active == "active":
                auto_restart["attempted"] = True
                r = control.restart(sd)
                auto_restart["ok"] = r.returncode == 0
                auto_restart["detail"] = (
                    f"restarted to apply changes to {', '.join(changed_fields)}"
                    if r.returncode == 0
                    else f"restart failed (rc={r.returncode}): {(r.stderr or r.stdout or '').strip()[:400]}"
                )
        except Exception as e:
            auto_restart["detail"] = f"restart skipped: {e}"

    return {
        "ok": True,
        "path": str((settings.defs_dir / f'{sd.name}.yml')),
        "firewall": fw_result,
        "changed_launch_fields": changed_fields,
        "auto_restart": auto_restart,
    }


@app.get("/api/firewall", dependencies=[Depends(require_token)])
def api_firewall_snapshot() -> dict:
    """Diagnostics for the firewall UI: which auto-managed rules are live."""
    return firewall.snapshot()


@app.get("/api/diagnostics/network", dependencies=[Depends(require_token)])
def api_diagnostics_network() -> dict:
    """Detect the "server bound locally but unreachable from LAN" failure mode.

    The manager runs INSIDE an unprivileged LXC, so it can't fix — or even
    directly see — the Proxmox HOST's firewall / bridge-nf-call-iptables
    config that most often eats UDP packets. What it CAN see is a
    fingerprint that only matches this scenario:

      * A server has been in systemd ``active`` state for >5 min AND
      * its readiness probe (A2S/SLP/HTTPS) has never succeeded, AND
      * the game socket has Recv-Q == 0 in ``ss`` (nothing has arrived
        on the port to be read).

    That combination is diagnostic of "packets never reached the LXC",
    which points at the host firewall / bridge-nf. Any OTHER failure
    mode (game crashed, wrong port, config broken) would either flip
    the systemd state to failed OR would show packets queuing in
    Recv-Q as the game reads them and drops.

    Returns per-server flags so the UI can highlight the ones that
    look externally-unreachable and point the operator at
    ``scripts/proxmox-host-fix.sh``.
    """
    from .watchdog import watchdog as _wd
    wd_snap = _wd.snapshot()
    sockets = _read_udp_socket_recv_q()

    results = []
    for sd in registry.list_defs():
        try:
            st = control.status(sd)
        except Exception:
            continue
        wd = wd_snap.get(sd.name, {})
        probe_supported = watchdog.probe_supported(sd)
        starting_sec = int(wd.get("starting_sec") or 0)
        ready = bool(wd.get("ready"))

        # Recv-Q on the game's primary port. If we can't see the port,
        # we skip the diagnostic (custom types / unknown ports).
        recv_q = sockets.get(int(sd.port))

        # "Externally unreachable" fingerprint. All three must hold:
        looks_unreachable = (
            st.active == "active"
            and probe_supported
            and not ready
            and starting_sec >= 5 * 60
            and recv_q == 0
        )

        results.append({
            "name": sd.name,
            "port": int(sd.port),
            "active": st.active,
            "ready": ready,
            "starting_sec": starting_sec,
            "recv_q": recv_q,
            "looks_externally_unreachable": looks_unreachable,
        })

    return {
        "servers": results,
        # Static, single source of truth for the fix instructions the
        # UI can render as a copy-paste block.
        "host_fix_script": "scripts/proxmox-host-fix.sh",
        "host_fix_hint": (
            "SSH into the Proxmox VE host (NOT this LXC) and run: "
            "sudo bash /opt/gamesrv/scripts/proxmox-host-fix.sh — "
            "the manager can't touch host firewall/bridge settings from "
            "inside an unprivileged container."
        ),
    }


def _read_udp_socket_recv_q() -> dict[int, int]:
    """Parse /proc/net/udp{,6} for our own veth's UDP sockets.

    Returns ``{local_port: recv_q_bytes}`` for every UDP socket bound on
    the local host (any interface). Used by
    ``api_diagnostics_network`` to detect the "port bound but nothing
    arriving" fingerprint.

    Format reference: kernel exposes hex-encoded fields. Column 5 is
    ``rx_queue:tx_queue`` (bytes queued to be read : bytes queued to be
    written). We only care about rx_queue.
    """
    out: dict[int, int] = {}
    for path in ("/proc/net/udp", "/proc/net/udp6"):
        try:
            with open(path, encoding="ascii") as f:
                lines = f.readlines()
        except OSError:
            continue
        # Skip header row.
        for line in lines[1:]:
            fields = line.split()
            if len(fields) < 5:
                continue
            # local_address is HEX_IP:HEX_PORT — we only need the port.
            local = fields[1]
            if ":" not in local:
                continue
            try:
                port = int(local.split(":", 1)[1], 16)
            except ValueError:
                continue
            queues = fields[4]
            try:
                rx_hex = queues.split(":", 1)[0]
                rx = int(rx_hex, 16)
            except (ValueError, IndexError):
                continue
            # If the same port shows up in both udp and udp6, prefer the
            # larger recv-q so a single lively socket wins over an idle one.
            prev = out.get(port)
            if prev is None or rx > prev:
                out[port] = rx
    return out


# ---------- steam profiles (address book of steamID64 → display name) ----------

class SteamProfileBody(BaseModel):
    steamid: str
    name: str = ""


@app.get("/api/steam-profiles", dependencies=[Depends(require_token)])
def api_steam_profiles() -> dict:
    """Return the full manager-wide address book."""
    return {"profiles": steam_profiles.load_all()}


@app.post("/api/steam-profiles", dependencies=[Depends(require_token)])
def api_steam_profile_upsert(body: SteamProfileBody) -> dict:
    try:
        profiles = steam_profiles.upsert(body.steamid, body.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True, "profiles": profiles}


@app.delete("/api/steam-profiles/{steamid}", dependencies=[Depends(require_token)])
def api_steam_profile_delete(steamid: str) -> dict:
    return {"ok": True, "profiles": steam_profiles.delete(steamid)}


@app.get("/api/steam-profiles/lookup", dependencies=[Depends(require_token)])
def api_steam_profile_lookup(steamid: str) -> dict:
    """Fetch a Steam display name via the public community XML endpoint.

    Best-effort: returns ``name = null`` when the profile is private, the
    ID is malformed, or the network is unreachable. The frontend uses
    this to pre-fill the name field when adding a new SteamID.
    """
    name = steam_profiles.lookup_public_name(steamid)
    return {"steamid": steamid, "name": name}


@app.delete("/api/servers/{name}", dependencies=[Depends(require_token)])
def api_delete_server(name: str) -> dict:
    registry.delete_def(name)
    # Wipe any UFW rules the manager put in place for this server so
    # deleting a def actually closes its port. Delete happens even if
    # the def is already gone — the reconciler is a no-op then.
    try:
        firewall._delete_managed_for(name)   # module-private but stable
    except Exception:
        pass
    return {"ok": True}


# ---------- lifecycle ----------

class ActionBody(BaseModel):
    action: str  # start | stop | restart | enable | disable


@app.post("/api/servers/{name}/action", dependencies=[Depends(require_token)])
def api_action(name: str, body: ActionBody) -> dict:
    sd = registry.load_def(name)
    fn = {
        "start": control.start,
        "stop": control.stop,
        "restart": control.restart,
        "enable": control.enable,
        "disable": control.disable,
    }.get(body.action)
    if fn is None:
        raise HTTPException(status_code=400, detail=f"unknown action {body.action!r}")
    # Pre-flight RAM check for start/restart. We don't reserve RAM until
    # a server is active, so multiple servers can share a host as long as
    # only a subset are up at any time. If asking to start would push the
    # total past the container's RAM limit, refuse with 507 — the operator
    # can stop another server and retry, instead of getting a cryptic
    # OOM-kill mid-boot.
    if body.action in ("start", "restart"):
        try:
            cur_status = control.status(sd)
        except Exception:
            cur_status = None
        already_active = bool(cur_status and cur_status.active == "active")
        # For restart of an already-active server, its own reservation is
        # about to be released and re-taken — exclude it from the sum so
        # we don't double-count.
        snap = _ram_snapshot(exclude_name=sd.name if already_active else None)
        needed = (sd.memory_mb or 0) * 1024 * 1024
        if snap["limit_bytes"] and needed > snap["available_bytes"]:
            avail_mb = snap["available_bytes"] // (1024 * 1024)
            resv_mb = snap["reserved_bytes"] // (1024 * 1024)
            limit_mb = snap["limit_bytes"] // (1024 * 1024)
            raise HTTPException(
                status_code=507,
                detail=(
                    f"Not enough RAM to start {sd.name}: needs "
                    f"{sd.memory_mb} MB, only ~{avail_mb} MB available "
                    f"({resv_mb} MB reserved by other active servers, "
                    f"limit {limit_mb} MB). Stop another server first "
                    "or lower this server's memory_mb."
                ),
            )

        # Regenerate launch scripts (start.sh / stop.sh / server.env /
        # server.properties) from the current ServerDef BEFORE handing off
        # to systemctl. This makes launch-affecting fields — port,
        # wake_on_demand, memory_mb, java_args, passwords, extra_env,
        # stop_timeout_sec — take effect on the very next start without
        # requiring the operator to click Install.
        #
        # Does NOT re-download anything (no steamcmd, no jar fetch) — this
        # is pure file-writing from the YAML. Only game-type handlers that
        # implement configure() do anything; the custom type is a no-op.
        # Failures here are fatal for the start: a broken configure() would
        # mean starting the game with a stale/incorrect script, which is
        # exactly the class of bug this hook exists to prevent.
        try:
            handler = handler_for(sd)
            handler.configure()
        except NotImplementedError:
            pass   # older handler without a configure() override — skip.
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=(
                    f"Regenerating launch scripts for {sd.name} failed: {e}. "
                    "Fix the server definition and try again, or click Install "
                    "if the install_dir is missing."
                ),
            ) from e
    try:
        r = fn(sd)
    except subprocess.TimeoutExpired as e:
        # systemctl didn't return in time — usually means the game is still
        # shutting down (Minecraft world-save can take a while). The stop
        # itself is still in progress on the host; the operator can poll
        # /api/servers to see when SubState flips to dead.
        raise HTTPException(
            status_code=504,
            detail=(
                f"systemctl {body.action} did not return within "
                f"{int(e.timeout)}s — the server is likely still shutting "
                "down. Refresh the dashboard in a moment."
            ),
        ) from e
    return {
        "ok": r.returncode == 0,
        "returncode": r.returncode,
        "stdout": r.stdout,
        "stderr": r.stderr,
    }


@app.post("/api/servers/{name}/install", dependencies=[Depends(require_token)])
def api_install(name: str) -> dict:
    """Kick off an install job in a background thread.

    Returns immediately with the job id. Poll GET /api/servers/{name}/job
    for progress (phase, percent, bytes, live tail). Only one install or
    update job may run per server at a time.
    """
    sd = registry.load_def(name)
    if jobs.registry.is_running(name):
        raise HTTPException(status_code=409, detail="an install or update is already running for this server")
    handler = handler_for(sd)

    def _target(cb):
        handler.set_progress_cb(cb)
        return handler.install()

    try:
        job = jobs.registry.start(name, "install", _target)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return {"ok": True, "job_id": job.id, "server": name, "kind": "install"}


@app.post("/api/servers/{name}/update", dependencies=[Depends(require_token)])
def api_type_update(name: str) -> dict:
    """Same job machinery as install; for SteamCMD games this re-runs
    +app_update validate (patches to the latest build)."""
    sd = registry.load_def(name)
    if jobs.registry.is_running(name):
        raise HTTPException(status_code=409, detail="an install or update is already running for this server")
    handler = handler_for(sd)

    def _target(cb):
        handler.set_progress_cb(cb)
        return handler.update()

    try:
        job = jobs.registry.start(name, "update", _target)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return {"ok": True, "job_id": job.id, "server": name, "kind": "update"}


@app.get("/api/servers/{name}/job", dependencies=[Depends(require_token)])
def api_server_job(name: str) -> dict:
    """Current install/update job state for this server.

    Returns {"exists": False} if no job has ever been started (or the
    manager restarted since). Otherwise returns the full job snapshot:
    kind, done, ok, error, elapsed_sec, progress {phase, percent, bytes_*},
    tail (last ~200 lines), and messages (populated on completion).
    """
    j = jobs.registry.get(name)
    if not j:
        return {"exists": False}
    return {"exists": True, **j.to_dict()}


# ---------- console + logs ----------

class ConsoleBody(BaseModel):
    command: str


@app.post("/api/servers/{name}/console", dependencies=[Depends(require_token)])
def api_console(name: str, body: ConsoleBody) -> dict:
    sd = registry.load_def(name)
    try:
        control.send_console(sd, body.command)
    except (ValueError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True, "sent": body.command}


@app.get("/api/servers/{name}/diagnose", dependencies=[Depends(require_token)])
def api_diagnose_stuck(name: str) -> dict:
    """Read /proc introspection for a stuck game process.

    When a server's chip stays "◐ starting" forever, the game is either
    (a) exited but systemd is restart-looping (n_restarts > 0), (b) doing
    real work (RAM growing), or (c) blocked on a syscall and going
    nowhere. Case (c) is the trap: process is alive, no crash, no error —
    but nothing is happening. This endpoint gives X-ray vision into (c)
    by reading /proc fields for the game's PID.

    Kernel-provided fields we read:
      * wchan  — the function the process (main thread) is blocked in.
                 Names like ``futex_wait_queue_me`` (lock contention),
                 ``poll_schedule_timeout`` (network/IO wait),
                 ``io_schedule`` (disk IO), ``sk_wait_data`` (socket
                 recv). This alone usually names the culprit.
      * stack  — kernel-space call stack. Frames all the way from the
                 syscall entry down to the blocking point.
      * status — State line (R/S/D/Z), VmRSS, thread count. "D" is the
                 fingerprint of a syscall stuck in the kernel (usually
                 disk IO or NFS).
      * open_fds — first ~40 open file descriptors + their targets.
                   Reveals whether the process is waiting on a specific
                   file, socket, or pipe.
      * thread_wchans — same for the first ~15 threads. Palworld has
                        ~40 threads and the blocking one may not be
                        the main.
    """
    from pathlib import Path
    sd = registry.load_def(name)
    try:
        st = control.status(sd)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"status failed: {e}") from e

    if st.active != "active" or not st.pid:
        return {
            "ok": False,
            "reason": "not-active",
            "detail": f"unit is {st.active!r}, MainPID={st.pid}. Diagnose is only "
                      "meaningful when the unit is active — start the server first.",
            "unit_state": st.active,
        }

    # start.sh is the MainPID; the actual game is a descendant. Walk
    # /proc looking for a real game binary under this systemd unit's
    # cgroup. Falls back to MainPID if we can't find a better one.
    unit_prefix = f"gamesrv@{sd.name}.service"
    target_pid = _find_game_pid_under_unit(unit_prefix) or st.pid

    def _read(path: str, default: str = "(unreadable)", limit: int = 8192) -> str:
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                return f.read(limit)
        except (OSError, PermissionError) as e:
            return f"{default}: {e}"

    proc = Path(f"/proc/{target_pid}")
    if not proc.exists():
        return {
            "ok": False,
            "reason": "pid-gone",
            "detail": f"PID {target_pid} vanished between status check and diagnose. Try again.",
        }

    result: dict = {
        "ok": True,
        "server": name,
        "unit_active": st.active,
        "systemd_main_pid": st.pid,
        "game_pid": target_pid,
        "wchan": _read(f"/proc/{target_pid}/wchan", limit=256).strip(),
        "comm": _read(f"/proc/{target_pid}/comm", limit=64).strip(),
    }

    status_text = _read(f"/proc/{target_pid}/status", limit=4096)
    interesting_keys = ("Name:", "State:", "VmRSS:", "VmSize:", "Threads:",
                        "voluntary_ctxt_switches:", "nonvoluntary_ctxt_switches:")
    result["status"] = "\n".join(
        line for line in status_text.splitlines()
        if any(line.startswith(k) for k in interesting_keys)
    )

    result["kernel_stack"] = _read(f"/proc/{target_pid}/stack", limit=4096)

    fds_dir = proc / "fd"
    fds: list[str] = []
    try:
        entries = sorted(fds_dir.iterdir(),
                         key=lambda p: int(p.name) if p.name.isdigit() else 999)
        for fd in entries[:40]:
            try:
                target = str(fd.readlink()) if fd.is_symlink() else "(not a link)"
            except OSError:
                target = "(unreadable)"
            fds.append(f"{fd.name} -> {target}")
    except OSError as e:
        fds.append(f"(cannot list fds: {e})")
    result["open_fds"] = fds

    thread_wchans: list[str] = []
    try:
        task_dir = proc / "task"
        for tid_dir in sorted(task_dir.iterdir())[:15]:
            wc = _read(f"{tid_dir}/wchan", limit=128).strip()
            cm = _read(f"{tid_dir}/comm", limit=64).strip()
            thread_wchans.append(f"tid={tid_dir.name} comm={cm} wchan={wc}")
    except OSError:
        pass
    result["thread_wchans"] = thread_wchans

    wchan = result["wchan"]
    hint = ""
    if not wchan or wchan == "0":
        hint = ("wchan is empty/0 — the process is either RUNNING (not blocked) "
                "or in a state without a wait channel. If RAM is growing, it's "
                "working. Check thread_wchans below to see if ANY thread is "
                "blocked — Palworld has ~40 threads and only one may be stuck.")
    elif "futex" in wchan:
        hint = ("Main thread is blocked on a futex (user-space lock). Usually "
                "waiting for another thread to release a mutex. Look at "
                "thread_wchans below to find WHICH other thread is stuck.")
    elif "poll" in wchan or "epoll" in wchan or "select" in wchan:
        hint = ("Blocked in an event loop waiting for I/O. Check open_fds for a "
                "socket/pipe. Common for network stalls (Steam login, master "
                "server registration).")
    elif "io_schedule" in wchan or "wait_on_page" in wchan:
        hint = "Blocked on DISK I/O. If any FD is on a slow/NFS mount, that's the cause."
    elif "sk_wait_data" in wchan or "tcp_recvmsg" in wchan or "udp_recvmsg" in wchan:
        hint = ("Blocked waiting for network data. Check open_fds for the socket. "
                "Usually means an outbound service (Steam, Sentry, master server) "
                "isn't responding.")
    result["hint"] = hint

    return result


def _find_game_pid_under_unit(unit_prefix: str) -> Optional[int]:
    """Walk /proc looking for a game-ish PID under the given systemd unit.

    Reads /proc/<pid>/cgroup and returns the first PID whose cgroup path
    contains the systemd unit AND whose comm isn't shell/sleep/tmux (i.e.
    the actual game binary, not start.sh or its `sleep 1` loop).
    """
    from pathlib import Path
    shell_ish = {"sh", "bash", "sleep", "tmux", "tmux: server", "start.sh"}
    for pid_dir in Path("/proc").iterdir():
        if not pid_dir.name.isdigit():
            continue
        try:
            cg = (pid_dir / "cgroup").read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if unit_prefix not in cg:
            continue
        try:
            comm = (pid_dir / "comm").read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            comm = ""
        if comm in shell_ish:
            continue
        try:
            return int(pid_dir.name)
        except ValueError:
            continue
    return None


@app.get("/api/servers/{name}/logs", response_class=PlainTextResponse, dependencies=[Depends(require_token)])
def api_logs(name: str, lines: int = 200) -> str:
    sd = registry.load_def(name)
    return control.tail_logs(sd, lines=max(1, min(2000, lines)))


@app.get("/api/servers/{name}/game-log", response_class=PlainTextResponse, dependencies=[Depends(require_token)])
def api_game_log(name: str, lines: int = 200) -> str:
    """Tail the game process's own log file (Minecraft's logs/latest.log).

    The `/logs` endpoint returns the systemd journal, which for tmux-hosted
    game servers only shows manager/start.sh output — not the game's own
    stdout with player joins, chat, mod init lines, etc. This endpoint
    exposes the game log directly so operators can see real events.

    Returns 404 for server types whose log location isn't well-defined
    (custom, generic steamcmd).
    """
    sd = registry.load_def(name)
    log_path = _game_log_path(sd)
    if log_path is None:
        raise HTTPException(
            status_code=404,
            detail=f"no known game log for type {sd.type!r}",
        )
    if not log_path.exists():
        return (
            f"(game log not created yet: {log_path})\n"
            "Start the server; the log appears once the game process writes to it."
        )
    n = max(1, min(2000, lines))
    # Efficient tail: seek to a byte offset that's a rough overestimate of
    # `n` lines (Minecraft lines average ~200 bytes but wildly vary with
    # stack traces), read forward, keep the last `n`. Avoids loading a
    # multi-MB log into memory when the operator only asked for 200 lines.
    approx_bytes = n * 512
    try:
        size = log_path.stat().st_size
        with log_path.open("rb") as f:
            if size > approx_bytes:
                f.seek(size - approx_bytes)
                f.readline()   # discard the (likely partial) leading line
            data = f.read()
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"read failed: {e}") from e
    text = data.decode("utf-8", errors="replace")
    tail = text.splitlines()[-n:]
    return "\n".join(tail)


def _game_log_path(sd) -> Optional[Path]:
    """Return the path to the game's own log file for this server, if any.

    Kept small on purpose: adding new types is a one-line change here.
    """
    if sd.type in ("minecraft-java", "minecraft-forge"):
        return Path(sd.install_dir) / "logs" / "latest.log"
    # Satisfactory (steam_app_id 1690800) — the Unreal Engine log.
    if sd.type == "steamcmd" and sd.steam_app_id == 1690800:
        return Path(sd.install_dir) / "FactoryGame" / "Saved" / "Logs" / "FactoryGame.log"
    # Every manager-generated SteamCMD start.sh pipes its tmux pane to
    # install_dir/console.log (see app/types/steamcmd.py _START_TEMPLATE).
    # That's the only place the game's actual stdout lives for games like
    # Palworld / Valheim / generic SteamCMD, because tmux swallows stdout
    # before it can reach the systemd journal. Return that path so the
    # dashboard's Console tab shows real game output. If the file doesn't
    # exist yet, the /game-log endpoint returns a helpful "not created
    # yet — start the server" message instead of falling back to the
    # (near-empty) journal.
    if sd.type == "steamcmd":
        return Path(sd.install_dir) / "console.log"
    # Custom types have no standard log location — the frontend falls back
    # to the systemd journal view when this returns None.
    return None


# ---------- files: upload / download / list / delete ----------

@app.get("/api/servers/{name}/files", dependencies=[Depends(require_token)])
def api_files_list(name: str, area: str = "install", path: str = "") -> list[dict]:
    sd = registry.load_def(name)
    return uploads.list_dir(sd, area, path)


@app.post("/api/servers/{name}/files", dependencies=[Depends(require_token)])
async def api_files_upload(
    name: str,
    file: UploadFile,
    area: str = Form("install"),
    path: str = Form(""),
    overwrite: bool = Form(False),
) -> dict:
    sd = registry.load_def(name)
    dest_rel = path or (file.filename or "")
    if not dest_rel:
        raise HTTPException(status_code=400, detail="path or filename required")
    saved = await uploads.save_upload(sd, area, dest_rel, file, overwrite=overwrite)
    return {"ok": True, "saved": str(saved), "bytes": saved.stat().st_size}


@app.post("/api/servers/{name}/files/extract", dependencies=[Depends(require_token)])
async def api_files_extract(
    name: str,
    file: UploadFile,
    area: str = Form("install"),
    dest_subdir: str = Form(""),
    overwrite: bool = Form(False),
) -> dict:
    """Upload a .zip / .tar.gz / .tgz / .tar / .tar.bz2 archive and extract it
    into the requested area (optionally into a subdirectory). One HTTP round
    trip beats N uploads for large trees like a whole Forge server or a
    world backup exported from another host.
    """
    sd = registry.load_def(name)
    return await uploads.extract_upload(sd, area, dest_subdir, file, overwrite=overwrite)


@app.get("/api/servers/{name}/files/download", dependencies=[Depends(require_token)])
def api_files_download(name: str, area: str = "install", path: str = "") -> FileResponse:
    sd = registry.load_def(name)
    target, _ = uploads.open_download(sd, area, path)
    return FileResponse(target, filename=target.name)


@app.delete("/api/servers/{name}/files", dependencies=[Depends(require_token)])
def api_files_delete(name: str, area: str = "install", path: str = "") -> dict:
    sd = registry.load_def(name)
    uploads.delete_path(sd, area, path)
    return {"ok": True}


# ---------- git source ----------

class GitSyncBody(BaseModel):
    dry_run: bool = False
    token: str | None = None   # per-request PAT; never persisted anywhere


@app.post("/api/servers/{name}/git/sync", dependencies=[Depends(require_token)])
def api_git_sync(name: str, body: GitSyncBody | None = None) -> dict:
    """Clone (first time) or fetch + fast-forward the configured git source,
    then rsync the tree into install_dir (and world_dir if world_subdir is
    set). On success, records deployed_sha/ref/at back into the server def.

    Body may include a per-request `token` for private repos — used only for
    this call and never written to disk. Alternatively, set the PAT in
    /etc/gamesrv.env under any name and reference it via git_source.token_env.
    """
    sd = registry.load_def(name)
    if not sd.git_source.url:
        raise HTTPException(status_code=400, detail="server has no git_source.url configured")
    try:
        r = git_source.sync(
            sd,
            dry_run=bool(body and body.dry_run),
            token=(body.token if body and body.token else None),
        )
    except git_source.GitError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # unexpected — surface class name so we don't leak paths/tokens
        raise HTTPException(status_code=500, detail=f"git sync failed: {e.__class__.__name__}") from e

    if not (body and body.dry_run):
        sd.git_source.deployed_sha = r.get("sha", "")
        sd.git_source.deployed_ref = r.get("ref", "")
        sd.git_source.deployed_at = r.get("deployed_at", "")
        registry.save_def(sd)
    return r


class GitStatusBody(BaseModel):
    token: str | None = None


@app.post("/api/servers/{name}/git/status", dependencies=[Depends(require_token)])
def api_git_status_post(name: str, body: GitStatusBody | None = None) -> dict:
    """Cheap probe of the remote HEAD for the configured ref. Uses
    `git ls-remote` — no clone, no fetch. Body may include a per-request
    PAT for private repos.
    """
    sd = registry.load_def(name)
    if not sd.git_source.url:
        return {"ok": False, "error": "no git_source configured"}
    try:
        return git_source.remote_head(
            sd, token=(body.token if body and body.token else None)
        )
    except git_source.GitError as e:
        return {"ok": False, "error": str(e)}


@app.get("/api/servers/{name}/git/status", dependencies=[Depends(require_token)])
def api_git_status_get(name: str) -> dict:
    """Convenience GET for the auth-via-env-only case (no per-request token)."""
    return api_git_status_post(name, None)


@app.post("/api/servers/{name}/git/clear-cache", dependencies=[Depends(require_token)])
def api_git_clear_cache(name: str) -> dict:
    sd = registry.load_def(name)
    return git_source.clear_cache(sd)


# ---------- git backup (push .tgz snapshots to a private git remote) ----------

class GitBackupPushBody(BaseModel):
    token: str = ""


@app.post("/api/servers/{name}/git-backup/push", dependencies=[Depends(require_token)])
def api_git_backup_push(name: str, body: GitBackupPushBody | None = None) -> dict:
    """Commit every .tgz snapshot under ``worlds/_backups/<name>/`` and push
    it to the configured git remote. If ``git_backup.repo_url`` is empty
    and the provider is GitHub, a private ``gamesrv-backup-<name>`` repo
    is auto-created under the token owner on the first push.

    Body may include a one-shot ``token`` override for testing new PATs
    without editing ``/etc/gamesrv.env``; otherwise the manager uses
    ``git_backup.token_env`` or the ``GAMESRV_GITHUB_TOKEN`` fallback.
    """
    sd = registry.load_def(name)
    override = (body.token if body else "") or None
    try:
        return git_backup.push(sd, override_token=override)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# ---------- backups ----------

@app.post("/api/servers/{name}/backup", dependencies=[Depends(require_token)])
def api_backup(name: str) -> dict:
    """Kick off a backup job. Polls at GET /api/servers/{name}/job."""
    sd = registry.load_def(name)
    if jobs.registry.is_running(name):
        raise HTTPException(status_code=409, detail="an install/update/backup is already running for this server")

    def _target(cb):
        dest = uploads.make_backup(sd, settings.backup_root, on_event=cb)
        return [f"wrote {dest} ({dest.stat().st_size} bytes)"]

    try:
        job = jobs.registry.start(name, "backup", _target)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return {"ok": True, "job_id": job.id, "server": name, "kind": "backup"}


@app.get("/api/servers/{name}/backups", dependencies=[Depends(require_token)])
def api_backups_list(name: str) -> list[dict]:
    sd = registry.load_def(name)
    return uploads.list_backups(sd, settings.backup_root)


class RestoreBody(BaseModel):
    backup_name: str


@app.post("/api/servers/{name}/restore", dependencies=[Depends(require_token)])
def api_restore(name: str, body: RestoreBody) -> dict:
    """Kick off a restore job. Rejects up front if the server is running or
    another job is in flight — cheap safety before the thread starts."""
    sd = registry.load_def(name)
    st = control.status(sd)
    if st.active == "active":
        raise HTTPException(status_code=409, detail="stop the server before restoring")
    if jobs.registry.is_running(name):
        raise HTTPException(status_code=409, detail="an install/update/backup is already running for this server")
    backup_name = body.backup_name

    def _target(cb):
        uploads.restore_backup(sd, settings.backup_root, backup_name, on_event=cb)
        return [f"restored {backup_name} into {sd.world_dir}"]

    try:
        job = jobs.registry.start(name, "restore", _target)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return {"ok": True, "job_id": job.id, "server": name, "kind": "restore"}


# ---------- self-update ----------

@app.post("/api/manager/update", dependencies=[Depends(require_token)])
def api_manager_update() -> dict:
    return updater.trigger_update()


@app.get("/api/manager/update/log", response_class=PlainTextResponse, dependencies=[Depends(require_token)])
def api_manager_update_log(lines: int = 200) -> str:
    return updater.update_log_tail(lines=max(1, min(2000, lines)))


@app.post("/api/manager/restart", dependencies=[Depends(require_token)])
def api_manager_restart() -> dict:
    """Bounce the manager without pulling code. systemd Restart=always
    brings it back. Useful after editing /etc/gamesrv.env via the Admin
    env editor, since env is only read at startup."""
    return updater.request_restart()


@app.get("/api/manager/info", dependencies=[Depends(require_token)])
def api_manager_info() -> dict:
    return updater.runtime_info()


# ---------- env editor ----------

@app.get("/api/manager/env", dependencies=[Depends(require_token)])
def api_manager_env() -> dict:
    """Return the current env-file contents, structured for the UI.

    Secrets ARE included in the JSON — the endpoint is behind the bearer
    token and served over the LAN-only manager port. If you need stricter
    handling later, we can redact secret values here and require a separate
    "reveal" call.
    """
    path = env_file.env_file_path()
    writable, reason = env_file.env_file_writable(path)
    entries = env_file.list_entries(path)
    return {
        "path": str(path),
        "writable": writable,
        "writable_reason": reason,
        "known": [
            {
                "name": e.name, "value": e.value,
                "is_secret": e.is_secret,
                "label": e.key.label if e.key else e.name,
                "help": e.key.help if e.key else "",
                "section": e.key.section if e.key else "Other",
                "input_type": e.key.input_type if e.key else "text",
            }
            for e in entries if e.is_managed
        ],
        "extras": [
            {
                "name": e.name, "value": e.value,
                "is_secret": e.is_secret,
                "writable": e.is_extra_writable,
            }
            for e in entries if not e.is_managed
        ],
    }


class EnvSaveBody(BaseModel):
    updates: dict[str, str]


@app.post("/api/manager/env", dependencies=[Depends(require_token)])
def api_manager_env_save(body: EnvSaveBody) -> dict:
    path = env_file.env_file_path()
    try:
        return env_file.update_env_file(path, body.updates)
    except OSError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e


# ---------- error handler: don't leak stack traces ----------

@app.exception_handler(Exception)
async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
    # Uvicorn's own logger will still capture the traceback server-side.
    return JSONResponse(status_code=500, content={"detail": f"internal error: {exc.__class__.__name__}"})


# suppress unused-import warnings from static analyzers on Optional
_ = Optional
