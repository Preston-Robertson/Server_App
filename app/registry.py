"""Server-definition registry: YAML files in settings.defs_dir.

One YAML per game server. Schema is documented in servers/*.example.yml and
docs/ADDING_SERVERS.md.
"""
from __future__ import annotations

import ipaddress
import re
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, field_validator

from .config import settings


# Server names must be safe to embed in systemd unit names, paths, and shell.
_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
_STEAMID64_RE = re.compile(r"^\d{17}$")


class RconCfg(BaseModel):
    enabled: bool = False
    port: int | None = None
    password_env: str | None = None  # env var name, NEVER inline password


class BackupCfg(BaseModel):
    enabled: bool = True
    target: str | None = None  # defaults to world_dir


class PasswordsCfg(BaseModel):
    """Game server + admin passwords.

    Injected on Install into the game's own config file or launch line
    (per-game logic lives in the type handler). Empty string = leave
    the game's default alone.

    **Stored inline in the YAML** — keep `servers/*.yml` out of any
    public git remote if you use these fields. A future release will
    add `*_env` companions that resolve from `/etc/gamesrv.env` at
    Install time.

    Per-game applicability:

      * Palworld  — server_password → `ServerPassword=`, admin_password → `AdminPassword=`
                    (written into `Pal/Saved/Config/LinuxServer/PalWorldSettings.ini`).
      * ARK SE/SA — appended to the launch URL as
                    `?ServerPassword=...?ServerAdminPassword=...`. Avoid `?`,
                    `&`, `"`, `'`, spaces.
      * Valheim   — server_password → `-password "..."` (admin_password ignored;
                    Valheim uses `adminlist.txt` steamID64s instead).
      * Satisfactory / Minecraft / Enshrouded — passwords fields are
        ignored (those games negotiate admin secrets differently).
    """
    server_password: str = ""
    admin_password: str = ""


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


class AccessCfg(BaseModel):
    """Per-server access control.

    Three modes:
      - "public"             — anyone reachable on the port can join
                               (subject to whatever the game itself enforces:
                               password, whitelist, etc.)
      - "steamid_allowlist"  — only listed steamID64s may join. Enforcement
                               is per-game; ARK is native (writes
                               PlayerExclusiveJoinList.txt + adds
                               -exclusivejoin). Games that don't natively
                               support it (Palworld, Satisfactory, Valheim,
                               Enshrouded) fall back to password only, with
                               a warning in the install output.
      - "ip_allowlist"       — enforced at the firewall (UFW). Requires the
                               separate `gamesrv-firewall` helper (see
                               docs/ADDING_SERVERS.md). If Tailscale is in
                               play, prefer Tailscale ACLs instead.
    """
    mode: str = "public"
    allowed_steamids: list[str] = Field(default_factory=list)
    allowed_ips: list[str] = Field(default_factory=list)

    @field_validator("mode")
    @classmethod
    def _valid_mode(cls, v: str) -> str:
        allowed = {"public", "steamid_allowlist", "ip_allowlist"}
        if v not in allowed:
            raise ValueError(f"access.mode must be one of {sorted(allowed)}, got {v!r}")
        return v

    @field_validator("allowed_steamids")
    @classmethod
    def _valid_steamids(cls, v: list) -> list[str]:
        out: list[str] = []
        for sid in v:
            s = str(sid).strip()
            if not _STEAMID64_RE.match(s):
                raise ValueError(f"invalid Steam ID: {sid!r} (expected 17-digit steamID64)")
            out.append(s)
        return out

    @field_validator("allowed_ips")
    @classmethod
    def _valid_ips(cls, v: list) -> list[str]:
        out: list[str] = []
        for ip in v:
            s = str(ip).strip()
            try:
                # strict=False so both single IPs and CIDRs are accepted.
                ipaddress.ip_network(s, strict=False)
            except ValueError as e:
                raise ValueError(f"invalid IP or CIDR: {ip!r}") from e
            out.append(s)
        return out


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
    access: AccessCfg = Field(default_factory=AccessCfg)
    passwords: PasswordsCfg = Field(default_factory=PasswordsCfg)
    # Scale-to-zero: if set, the watchdog stops this server after N minutes
    # of zero players (polled via A2S_INFO for Steam games, SLP for Minecraft).
    # Null / 0 = disabled. Fresh start clears the timer.
    idle_shutdown_min: int | None = None
    # Wake-on-demand (UDP-only games in v1). When true, the wake-proxy owns
    # the public `port` and the game process binds `port + 10000` internally.
    # Client packets are buffered while the wake completes, then replayed —
    # no "first attempt fails" for the client. Reinstall required after
    # toggling so start.sh uses the correct port.
    wake_on_demand: bool = False
    # How long the wake-proxy will hold client packets waiting for the game
    # to become responsive. Larger values suit heavy games (ARK ~90 s).
    wake_timeout_sec: int = 90

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
