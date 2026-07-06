"""Per-server type handlers.

Each handler owns two operations:
  install(sd)  — first-time provisioning (create dirs, download binary, write start.sh)
  update(sd)   — pull a new version of the game software (NOT the manager itself)

Update is intentionally separate from install so re-updating is idempotent.
"""
from __future__ import annotations

from ..registry import ServerDef
from .base import TypeHandler
from .minecraft_java import MinecraftJavaHandler
from .minecraft_forge import MinecraftForgeHandler
from .steamcmd import SteamCmdHandler
from .custom import CustomHandler


_HANDLERS: dict[str, type[TypeHandler]] = {
    "minecraft-java": MinecraftJavaHandler,
    "minecraft-forge": MinecraftForgeHandler,
    "steamcmd": SteamCmdHandler,
    "custom": CustomHandler,
}


def handler_for(sd: ServerDef) -> TypeHandler:
    cls = _HANDLERS.get(sd.type)
    if cls is None:
        raise ValueError(f"no handler for type {sd.type!r}")
    return cls(sd)
