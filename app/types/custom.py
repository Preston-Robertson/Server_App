"""Custom-type handler: the operator supplies their own start.sh/stop.sh in
install_dir. We just make sure the tmux wrapper is in place and dirs exist.
"""
from __future__ import annotations

from .base import TypeHandler


class CustomHandler(TypeHandler):
    def install(self) -> list[str]:
        self.ensure_dirs()
        msgs: list[str] = []
        env_values = {"GAME_PORT": str(self.sd.port), "MEMORY_MB": str(self.sd.memory_mb)}
        env_values.update(self.sd.extra_env)
        self.write_env_file(env_values)
        msgs.append(f"wrote {self.install_dir/'server.env'}")
        start = self.install_dir / "start.sh"
        if not start.exists():
            msgs.append(
                f"NOTE: create {start} yourself. It MUST launch the game inside "
                f"`tmux new-session -s gs-{self.sd.name} -n game '...'` so console + "
                "graceful stop work."
            )
        return msgs

    def update(self) -> list[str]:
        return self.install()
