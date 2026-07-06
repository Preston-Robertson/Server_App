"""Self-update trigger.

Design: the actual work (git pull, pip install, systemctl restart) needs
root AND needs to live in a cgroup that survives the manager restart. We
get both by delegating to a dedicated systemd oneshot unit,
`gamesrv-updater.service`, which the polkit rule lets us start.

Log source: update.sh `tee`s its output to /opt/gamesrv/logs/update.log,
and it also lands in the journal for `gamesrv-updater.service`. We prefer
the file (so the endpoint returns fast text) but fall back to journalctl
when the file is missing/empty — the most common case is "you just clicked
the button, log file doesn't exist yet, tell the user what happened".
"""
from __future__ import annotations

import subprocess
import time
from pathlib import Path

from .config import settings


UPDATER_UNIT = "gamesrv-updater.service"


def _run(cmd: list[str], timeout: int = 10) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _updater_status() -> dict:
    """Returns a small dict describing the current updater unit state."""
    r = _run(["systemctl", "show", UPDATER_UNIT,
              "--property=ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp"])
    kv: dict[str, str] = {}
    for line in r.stdout.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            kv[k] = v
    return kv


def trigger_update() -> dict:
    """Kick off the oneshot updater and return immediately.

    We use `--no-block` so systemd queues the job and returns; the manager
    can go on serving requests until the oneshot restarts it. Any error
    starting the unit itself (e.g. polkit denied) is surfaced right away.
    """
    # If it's already running, don't double-fire.
    st = _updater_status()
    if st.get("ActiveState") == "activating":
        return {
            "ok": False,
            "already_running": True,
            "message": "update already in progress — check the log",
        }

    r = _run(["systemctl", "start", "--no-block", UPDATER_UNIT])
    if r.returncode != 0:
        return {
            "ok": False,
            "error": f"systemctl start {UPDATER_UNIT} failed (exit {r.returncode})",
            "stderr": r.stderr.strip(),
            "hint": (
                "polkit may not permit this. Verify /etc/polkit-1/rules.d/49-gamesrv.rules "
                "is installed and includes gamesrv-updater.service, then "
                "`sudo systemctl restart polkit`."
            ),
        }
    return {
        "ok": True,
        "unit": UPDATER_UNIT,
        "message": (
            "update oneshot queued. Follow /api/manager/update/log or run: "
            f"journalctl -u {UPDATER_UNIT} -f"
        ),
    }


def update_log_tail(lines: int = 200) -> str:
    """Return the update log — file first, journal fallback."""
    log = settings.app_dir / "logs" / "update.log"
    header = ""

    # Header shows current updater unit state so the user can tell whether
    # the job is running, done, or never actually started.
    st = _updater_status()
    if st:
        active = st.get("ActiveState", "?")
        sub = st.get("SubState", "?")
        result = st.get("Result", "?")
        header = (
            f"[updater unit: {UPDATER_UNIT}  state={active}/{sub}  result={result}]\n"
            "---------------------------------------------------------------\n"
        )

    file_text = ""
    if log.exists() and log.stat().st_size > 0:
        with log.open("r", encoding="utf-8", errors="replace") as f:
            file_text = "".join(f.readlines()[-lines:])
    else:
        # No file yet — fall back to journalctl so the user sees SOMETHING
        # (e.g. permission errors before update.sh got far enough to tee).
        jr = _run(
            ["journalctl", "-u", UPDATER_UNIT, "-n", str(int(lines)),
             "--no-pager", "-o", "short-iso"],
            timeout=8,
        )
        file_text = (jr.stdout or jr.stderr or
                     "(no update.log and no journal entries yet)")

    return header + file_text


def _touch_log_marker(msg: str) -> None:
    """Test helper — writes a line to update.log so the endpoint shows it."""
    log = settings.app_dir / "logs" / "update.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("a", encoding="utf-8") as f:
        f.write(f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] {msg}\n")
