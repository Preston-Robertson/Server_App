"""Base contract for a game-type handler."""
from __future__ import annotations

import os
import stat
from pathlib import Path

from ..registry import ServerDef


class TypeHandler:
    """Subclasses implement install() and update(). Both must be idempotent."""

    def __init__(self, sd: ServerDef) -> None:
        self.sd = sd

    # -- lifecycle ops handlers must implement --
    def install(self) -> list[str]:
        raise NotImplementedError

    def update(self) -> list[str]:
        raise NotImplementedError

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
