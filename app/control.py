"""systemctl / journalctl / tmux wrappers.

The manager runs as unprivileged `gamesrv`; systemctl for `gamesrv@*` units is
granted narrowly via the polkit rule in scripts/49-gamesrv.rules. See
docs/USAGE.md for the exact permission surface.
"""
from __future__ import annotations

import shlex
import shutil
import subprocess
from dataclasses import dataclass

from .config import settings
from .registry import ServerDef


def _unit(name: str) -> str:
    return f"{settings.unit_template}{name}.service"


def _run(cmd: list[str], *, timeout: int = 15, check: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=check,
    )


# ---------- lifecycle ----------

def start(sd: ServerDef) -> subprocess.CompletedProcess:
    return _run(["systemctl", "start", _unit(sd.name)])


# Must comfortably exceed the unit's TimeoutStopSec (300s in
# systemd/gamesrv@.service) plus a bit of syscall overhead — otherwise
# subprocess.run raises TimeoutExpired for stops that systemd would have
# completed cleanly. The API layer catches TimeoutExpired and returns 504,
# but we'd rather not hit it for a stop that's actually still going.
_STOP_TIMEOUT_SEC = 330


def stop(sd: ServerDef) -> subprocess.CompletedProcess:
    # Graceful stop is handled by the unit's ExecStop (sends stop_cmd via tmux).
    return _run(["systemctl", "stop", _unit(sd.name)], timeout=_STOP_TIMEOUT_SEC)


def restart(sd: ServerDef) -> subprocess.CompletedProcess:
    return _run(["systemctl", "restart", _unit(sd.name)], timeout=_STOP_TIMEOUT_SEC)


def enable(sd: ServerDef) -> subprocess.CompletedProcess:
    return _run(["systemctl", "enable", _unit(sd.name)])


def disable(sd: ServerDef) -> subprocess.CompletedProcess:
    return _run(["systemctl", "disable", _unit(sd.name)])


# ---------- status ----------

@dataclass
class ServerStatus:
    name: str
    active: str        # active / inactive / failed / activating / ...
    enabled: str       # enabled / disabled / static
    sub: str           # running / dead / exited
    pid: int | None
    mem_bytes: int | None
    cpu_usec: int | None
    uptime_sec: int | None


def status(sd: ServerDef) -> ServerStatus:
    unit = _unit(sd.name)
    props = _run([
        "systemctl", "show", unit,
        "--property=ActiveState,SubState,UnitFileState,MainPID,MemoryCurrent,CPUUsageNSec,ActiveEnterTimestampMonotonic",
    ])
    kv: dict[str, str] = {}
    for line in props.stdout.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            kv[k] = v

    def _int_or_none(v: str) -> int | None:
        try:
            n = int(v)
            # systemd uses "[not set]" or huge sentinel values for unset counters
            if n <= 0 or n > 10**18:
                return None
            return n
        except (ValueError, TypeError):
            return None

    active = kv.get("ActiveState", "unknown")
    sub = kv.get("SubState", "unknown")
    enabled = kv.get("UnitFileState", "unknown")
    pid = _int_or_none(kv.get("MainPID", "0"))
    mem = _int_or_none(kv.get("MemoryCurrent", "0"))
    cpu = _int_or_none(kv.get("CPUUsageNSec", "0"))

    uptime = None
    if active == "active":
        # Rough uptime from monotonic timestamp (usec since boot)
        active_ts = _int_or_none(kv.get("ActiveEnterTimestampMonotonic", "0"))
        if active_ts:
            try:
                with open("/proc/uptime", encoding="ascii") as f:
                    boot_up_sec = float(f.read().split()[0])
                started_sec = active_ts / 1_000_000
                uptime = max(0, int(boot_up_sec - started_sec))
            except OSError:
                pass

    return ServerStatus(
        name=sd.name,
        active=active,
        enabled=enabled,
        sub=sub,
        pid=pid,
        mem_bytes=mem,
        cpu_usec=cpu,
        uptime_sec=uptime,
    )


# ---------- logs ----------

def tail_logs(sd: ServerDef, lines: int = 200) -> str:
    r = _run(["journalctl", "-u", _unit(sd.name), "-n", str(int(lines)), "--no-pager", "-o", "short-iso"])
    out = (r.stdout or "") + (r.stderr or "")
    # journalctl prints a "not seeing messages" hint when the caller lacks
    # systemd-journal group membership. Elevate that to an actionable error
    # instead of returning what looks like a working-but-empty tail.
    if ("systemd-journal" in out and "not seeing messages" in out) or \
       ("No journal files were opened" in out):
        return (
            "PERMISSION: the manager user cannot read the systemd journal.\n"
            "Fix on the LXC:\n"
            "  sudo usermod -aG systemd-journal gamesrv\n"
            "  sudo systemctl restart gamesrv-manager.service\n"
            "(bootstrap.sh does this automatically on any re-run.)\n\n"
            "--- raw journalctl output ---\n" + out
        )
    return r.stdout or r.stderr


# ---------- console (tmux send-keys) ----------
# Each server's start.sh launches inside a tmux session named `gs-<server>`
# (see systemd/gamesrv@.service and app/types/*). That gives us a real stdin
# channel systemd otherwise can't provide.

def _session(name: str) -> str:
    return f"gs-{name}"


def console_available(sd: ServerDef) -> bool:
    if not shutil.which("tmux"):
        return False
    r = _run(["tmux", "has-session", "-t", _session(sd.name)])
    return r.returncode == 0


def send_console(sd: ServerDef, command: str) -> None:
    if not command:
        raise ValueError("empty command")
    if any(ch in command for ch in ("\r", "\n")):
        raise ValueError("command must not contain newlines")
    if not console_available(sd):
        raise RuntimeError("tmux session not available — is the server running?")
    _run(["tmux", "send-keys", "-t", _session(sd.name), command, "Enter"], check=True)


def graceful_console_stop(sd: ServerDef) -> None:
    """Called by systemd ExecStop; sends stop_cmd to the tmux session, then waits."""
    if not sd.stop_cmd or not console_available(sd):
        return
    for line in sd.stop_cmd.splitlines():
        line = line.strip()
        if line:
            _run(["tmux", "send-keys", "-t", _session(sd.name), line, "Enter"])


def shell_quote(s: str) -> str:
    return shlex.quote(s)
