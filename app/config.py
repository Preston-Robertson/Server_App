"""Runtime configuration read from environment (loaded by systemd EnvironmentFile).

Everything is overridable via env vars so the same code runs in dev and prod.
"""
from __future__ import annotations

import os
from pathlib import Path
from dataclasses import dataclass


def _env(key: str, default: str) -> str:
    val = os.environ.get(key, "").strip()
    return val if val else default


@dataclass(frozen=True)
class Settings:
    token: str
    host: str
    port: int
    app_dir: Path
    defs_dir: Path            # per-server YAML definitions
    install_root: Path        # /srv/gameservers/<name>
    worlds_root: Path         # bind mount → TrueNAS
    backup_root: Path
    unit_template: str        # "gamesrv@" -> gamesrv@<name>.service
    github_token: str


def load() -> Settings:
    return Settings(
        token=_env("GAMESRV_TOKEN", ""),
        host=_env("GAMESRV_HOST", "0.0.0.0"),
        port=int(_env("GAMESRV_PORT", "8765")),
        app_dir=Path(_env("GAMESRV_APP_DIR", "/opt/gamesrv")),
        defs_dir=Path(_env("GAMESRV_DEFS_DIR", "/opt/gamesrv/servers")),
        install_root=Path(_env("GAMESRV_INSTALL_ROOT", "/srv/gameservers")),
        worlds_root=Path(_env("GAMESRV_WORLDS_ROOT", "/opt/gamesrv/worlds")),
        backup_root=Path(_env("GAMESRV_BACKUP_ROOT", "/opt/gamesrv/worlds/_backups")),
        unit_template=_env("GAMESRV_UNIT_TEMPLATE", "gamesrv@"),
        github_token=_env("GAMESRV_GITHUB_TOKEN", ""),
    )


settings = load()
