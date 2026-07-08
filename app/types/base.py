"""Base contract for a game-type handler."""
from __future__ import annotations

import os
import stat
from pathlib import Path
from typing import Callable, Optional

from ..registry import ServerDef


ProgressCallback = Callable[[dict], None]


# Hard upper bound for the stop.sh internal wait loop. Must stay strictly
# under the systemd unit's TimeoutStopSec (300s in systemd/gamesrv@.service)
# so systemd never fires its own timeout while stop.sh is still trying to
# save cleanly. Handlers may pick a lower per-type default and users can
# override via ServerDef.stop_timeout_sec (also clamped here).
STOP_TIMEOUT_MAX_SEC = 285
STOP_TIMEOUT_MIN_SEC = 10


def resolve_stop_timeout(sd: ServerDef, default_sec: int) -> int:
    """Return the effective stop.sh wait (in seconds) for ``sd``.

    Uses ``sd.stop_timeout_sec`` when set, else the handler's per-type
    default. Always clamped to [STOP_TIMEOUT_MIN_SEC, STOP_TIMEOUT_MAX_SEC].
    """
    raw = sd.stop_timeout_sec if sd.stop_timeout_sec else default_sec
    return max(STOP_TIMEOUT_MIN_SEC, min(STOP_TIMEOUT_MAX_SEC, int(raw)))


class TypeHandler:
    """Subclasses implement install() and update(). Both must be idempotent.

    Long-running handlers (SteamCMD) can report incremental progress by
    calling ``self._emit(phase=..., percent=..., bytes_done=..., bytes_total=...,
    line=...)``. When no progress callback is attached (direct/CLI use) the
    emit is a no-op, so handlers stay usable outside the web server.
    """

    def __init__(self, sd: ServerDef) -> None:
        self.sd = sd
        self._progress_cb: Optional[ProgressCallback] = None

    # -- lifecycle ops handlers must implement --
    def install(self) -> list[str]:
        raise NotImplementedError

    def update(self) -> list[str]:
        raise NotImplementedError

    # -- progress plumbing (opt-in for handlers that stream) --
    def set_progress_cb(self, cb: Optional[ProgressCallback]) -> None:
        self._progress_cb = cb

    def _emit(self, **event) -> None:
        cb = self._progress_cb
        if not cb:
            return
        try:
            cb(event)
        except Exception:
            # Never let a UI-side error break the install. Progress is
            # cosmetic; the install itself is authoritative.
            pass

    # -- shared helpers --
    @property
    def install_dir(self) -> Path:
        return Path(self.sd.install_dir)

    @property
    def world_dir(self) -> Path:
        return Path(self.sd.world_dir)

    def ensure_dirs(self) -> None:
        self.install_dir.mkdir(parents=True, exist_ok=True)
        self.world_dir.mkdir(parents=True, exist_ok=True)

    def write_script(self, name: str, contents: str) -> Path:
        p = self.install_dir / name
        p.write_text(contents, encoding="utf-8")
        p.chmod(p.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        return p

    def write_env_file(self, values: dict[str, str]) -> Path:
        """Write server.env (loaded by the systemd template unit)."""
        p = self.install_dir / "server.env"
        lines = [f"{k}={v}" for k, v in values.items()]
        p.write_text("\n".join(lines) + "\n", encoding="utf-8")
        os.chmod(p, 0o640)
        return p

    def patch_server_properties(self, key: str, value: str) -> str:
        """Idempotently set ``key=value`` in install_dir/server.properties.

        Used by the Minecraft handlers when wake-on-demand is on to force
        ``server-port`` to the internal port (so the wake proxy can own
        the public port). Creates the file with just this one line if it
        doesn't exist yet — Minecraft fills in the rest of the defaults on
        first launch.
        """
        p = self.install_dir / "server.properties"
        line = f"{key}={value}"
        if not p.exists():
            p.write_text(line + "\n", encoding="utf-8")
            return f"created {p.name} with {line}"
        text = p.read_text(encoding="utf-8")
        # Match key= at start of any line; preserve line endings by splitting.
        out_lines = []
        matched = False
        for orig in text.splitlines():
            stripped = orig.lstrip()
            if stripped.startswith(f"{key}=") and not stripped.startswith("#"):
                out_lines.append(line)
                matched = True
            else:
                out_lines.append(orig)
        if not matched:
            out_lines.append(line)
        new_text = "\n".join(out_lines) + ("\n" if text.endswith("\n") else "")
        if new_text != text:
            p.write_text(new_text, encoding="utf-8")
            return f"patched {p.name}: {line}"
        return f"{p.name} already had {line}"
