"""Server-definition registry: YAML files in settings.defs_dir.

One YAML per game server. Schema is documented in servers/*.example.yml and
docs/ADDING_SERVERS.md.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, field_validator

from .config import settings


# Server names must be safe to embed in systemd unit names, paths, and shell.
_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{1,31}$")


class RconCfg(BaseModel):
    enabled: bool = False
    port: int | None = None
    password_env: str | None = None  # env var name, NEVER inline password


class BackupCfg(BaseModel):
    enabled: bool = True
    target: str | None = None  # defaults to world_dir


class GitSourceCfg(BaseModel):
    """Optional git remote to sync server files from.

    Designed to work with GitHub today AND self-hosted Gitea/Forgejo/GitLab
    later — every field is generic to a git URL. Auth for private repos:
    put the PAT in /etc/gamesrv.env under some name and reference it via
    token_env (never inline the value).
    """
    url: str = ""                       # https://github.com/user/repo(.git)  |  git@host:user/repo
    ref: str = ""                       # branch/tag/commit; blank = default branch
    subdir: str = ""                    # if the server files aren't at repo root
    world_subdir: str = ""              # extracted into world_dir instead of install_dir
    token_env: str = ""                 # env var name for HTTPS PAT (empty = public/SSH)
    exclude: list[str] = Field(default_factory=list)   # extra path patterns to skip when syncing
    # Populated by the sync operation — read-only from the user's POV.
    deployed_sha: str = ""
    deployed_ref: str = ""
    deployed_at: str = ""               # ISO timestamp


class ServerDef(BaseModel):
    name: str
    type: str  # minecraft-java | minecraft-forge | steamcmd | custom
    install_dir: str
    world_dir: str
    port: int
    memory_mb: int = 2048
    java_args: str = ""
    start_cmd: str = "./start.sh"
    stop_cmd: str = ""            # console command sent via tmux before ExecStop kills
    auto_start_on_boot: bool = True
    # steamcmd-specific
    steam_app_id: int | None = None
    steam_beta: str | None = None
    # minecraft-forge-specific (informational; surfaced on the dashboard)
    mc_version: str | None = None       # e.g. "1.20.1"
    forge_version: str | None = None    # e.g. "47.3.0"
    # generic
    extra_env: dict[str, str] = Field(default_factory=dict)
    rcon: RconCfg = Field(default_factory=RconCfg)
    backup: BackupCfg = Field(default_factory=BackupCfg)
    git_source: GitSourceCfg = Field(default_factory=GitSourceCfg)

    @field_validator("name")
    @classmethod
    def _valid_name(cls, v: str) -> str:
        if not _NAME_RE.match(v):
            raise ValueError("name must be lowercase [a-z0-9-], 2–32 chars, start with a letter")
        return v

    @field_validator("type")
    @classmethod
    def _valid_type(cls, v: str) -> str:
        if v not in {"minecraft-java", "minecraft-forge", "steamcmd", "custom"}:
            raise ValueError(f"unknown type: {v}")
        return v


def _def_path(name: str) -> Path:
    return settings.defs_dir / f"{name}.yml"


def list_defs() -> list[ServerDef]:
    settings.defs_dir.mkdir(parents=True, exist_ok=True)
    out: list[ServerDef] = []
    for p in sorted(settings.defs_dir.glob("*.yml")):
        if p.name.endswith(".example.yml"):
            continue
        try:
            out.append(load_def(p.stem))
        except Exception:
            # Skip malformed files rather than crashing the whole listing.
            continue
    return out


def load_def(name: str) -> ServerDef:
    if not _NAME_RE.match(name):
        raise ValueError("invalid server name")
    path = _def_path(name)
    if not path.exists():
        raise FileNotFoundError(f"no such server: {name}")
    with path.open("r", encoding="utf-8") as f:
        data: dict[str, Any] = yaml.safe_load(f) or {}
    data.setdefault("name", name)
    return ServerDef.model_validate(data)


def save_def(sd: ServerDef) -> Path:
    settings.defs_dir.mkdir(parents=True, exist_ok=True)
    path = _def_path(sd.name)
    with path.open("w", encoding="utf-8") as f:
        yaml.safe_dump(sd.model_dump(mode="json"), f, sort_keys=False)
    return path


def delete_def(name: str) -> None:
    p = _def_path(name)
    if p.exists():
        p.unlink()
