"""Self-update trigger. Actual git/venv work happens in update.sh (§6).

We shell out so the update script can outlive the manager process (systemd
restart at the end of update.sh brings us back up).
"""
from __future__ import annotations

import subprocess
import time
from pathlib import Path

from .config import settings


def trigger_update() -> dict:
    """Fire-and-forget: launch update.sh detached from this request."""
    script = settings.app_dir / "update.sh"
    if not script.exists():
        return {"ok": False, "error": f"update.sh not found at {script}"}
    log = settings.app_dir / "logs" / "update.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    with log.open("a", encoding="utf-8") as f:
        f.write(f"\n=== update triggered at {ts} ===\n")
    subprocess.Popen(
        ["bash", str(script)],
        cwd=str(settings.app_dir),
        stdout=open(log, "a", encoding="utf-8"),
        stderr=subprocess.STDOUT,
        start_new_session=True,  # survive our restart at the end of update.sh
    )
    return {"ok": True, "log": str(log)}


def update_log_tail(lines: int = 200) -> str:
    log = settings.app_dir / "logs" / "update.log"
    if not log.exists():
        return "(no update log yet)"
    with log.open("r", encoding="utf-8") as f:
        data = f.readlines()
    return "".join(data[-lines:])
