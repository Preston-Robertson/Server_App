"""Read + write the manager's env file for the /admin env editor.

Adapted from luigi-web's env_file.py. Same rules apply:

* **Line-based edit.** For each key in `updates`, replace the first line
  matching `KEY=...`; otherwise append `KEY=VALUE` at the end. Comments,
  blank lines, and unknown-shape lines stay untouched. We never rewrite the
  whole file from scratch.
* **Schema-driven writes for KNOWN_KEYS.** Only keys in `KNOWN_KEYS` or
  matching one of `_EXTRA_KEY_PATTERNS` are writable via the UI.
* **Atomic replace preferred**, falling back to in-place rewrite when only
  the file itself (not its parent) is writable — matches the
  `/etc/gamesrv.env` deployment where the parent dir (`/etc`) is root-only.

The manager reads env only from `os.environ` at startup, so changes here
require either a hot-reload (for keys the manager can rebuild live) or a
restart. For gamesrv, EVERYTHING needs a restart today — the config module
is a frozen `dataclass` loaded once. We flag that on save.
"""
from __future__ import annotations

import os
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class EnvKey:
    name: str
    label: str
    help: str
    section: str
    input_type: str = "text"     # "text" | "password" | "number" | "url"
    is_secret: bool = False


# --- Managed keys (schema-driven form fields on the Admin page) ---
#
# Anything the operator is *likely* to want to tweak lives here with a proper
# label + help text. Free-form extras (per-server RCON passwords, git PATs
# under any name the operator picked) show up in the "Extras" section below,
# discovered from the file's contents.
KNOWN_KEYS: tuple[EnvKey, ...] = (
    # --- Runtime bind / paths --------------------------------------------
    EnvKey("GAMESRV_HOST",         "Bind address",
           "Uvicorn bind address. 0.0.0.0 for LAN, 127.0.0.1 for loopback-only.",
           "Runtime"),
    EnvKey("GAMESRV_PORT",         "Bind port",
           "Uvicorn port for the manager (default 8765).",
           "Runtime", input_type="number"),
    EnvKey("GAMESRV_APP_DIR",      "App directory",
           "Where the manager is checked out. Defaults to /opt/gamesrv.",
           "Runtime"),
    EnvKey("GAMESRV_DEFS_DIR",     "Server defs directory",
           "Where per-server YAML files live. Defaults to /opt/gamesrv/servers.",
           "Runtime"),
    EnvKey("GAMESRV_INSTALL_ROOT", "Install root",
           "Root under which each server's install_dir lives.",
           "Runtime"),
    EnvKey("GAMESRV_WORLDS_ROOT",  "Worlds root",
           "Root for world_dir mounts (usually the TrueNAS bind mount).",
           "Runtime"),
    EnvKey("GAMESRV_BACKUP_ROOT",  "Backups root",
           "Root under which per-server backups are written.",
           "Runtime"),

    # --- Auth ------------------------------------------------------------
    EnvKey("GAMESRV_TOKEN",        "UI/API bearer token",
           "The shared secret. Blank = keep current (empty save won't wipe it).",
           "Auth", input_type="password", is_secret=True),

    # --- GitHub self-update ---------------------------------------------
    EnvKey("GAMESRV_GITHUB_TOKEN", "GitHub PAT (self-update)",
           "Fine-grained PAT for pulling the manager's own repo on update.sh. "
           "Blank = public repo.",
           "GitHub", input_type="password", is_secret=True),
)

_KEYS_BY_NAME: dict[str, EnvKey] = {k.name: k for k in KNOWN_KEYS}

# Any additional key that matches ANY of these patterns is treated as
# writable-via-UI (Extras section). Values that look like secrets (name
# ends with _PW / _PASSWORD / _TOKEN / _PAT / _SECRET / _KEY) get the
# password treatment.
_EXTRA_KEY_PATTERNS = (
    re.compile(r"^MC_[A-Z0-9_]+$"),          # Minecraft servers
    re.compile(r"^PALWORLD_[A-Z0-9_]+$"),    # Palworld
    re.compile(r"^VALHEIM_[A-Z0-9_]+$"),
    re.compile(r"^ARK_[A-Z0-9_]+$"),
    re.compile(r"^GAMESRV_[A-Z0-9_]+$"),
    re.compile(r"^SERVER_[A-Z0-9_]+$"),      # generic namespace
)

_SECRET_SUFFIXES = ("_PW", "_PASSWORD", "_TOKEN", "_PAT", "_SECRET", "_KEY")

# Only KEY=... lines match. Preserves comments and blank lines untouched.
_LINE_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")


@dataclass
class EnvEntry:
    name: str
    value: str
    is_managed: bool                        # in KNOWN_KEYS
    is_extra_writable: bool = False         # matches _EXTRA_KEY_PATTERNS
    is_secret: bool = False
    key: EnvKey | None = None               # schema entry, if managed


# ---------- path + writability ----------

def env_file_path() -> Path:
    """Where the env file lives. Priority: GAMESRV_ENV_FILE > /etc/gamesrv.env."""
    override = os.environ.get("GAMESRV_ENV_FILE", "").strip()
    if override:
        return Path(override).expanduser()
    return Path("/etc/gamesrv.env")


def env_file_writable(path: Path) -> tuple[bool, str]:
    """Return (writable, reason). Prefers atomic-replace via sibling tempfile;
    falls back to in-place rewrite when only the file is writable (typical for
    /etc/gamesrv.env, mode 660 root:gamesrv).
    """
    if not path.exists():
        return False, f"{path} does not exist"
    parent = path.parent
    parent_writable = os.access(parent, os.W_OK)
    file_writable = os.access(path, os.W_OK)
    if parent_writable:
        return True, "atomic replace via sibling tempfile"
    if file_writable:
        return True, "in-place rewrite (parent dir not writable — non-atomic!)"
    return False, (
        f"neither {path} nor {parent} is writable by the manager user. "
        f"On the LXC: `sudo chgrp gamesrv {path} && sudo chmod 660 {path}` "
        "so the manager can edit it."
    )


# ---------- read ----------

def _is_extra_writable(name: str) -> bool:
    return any(pat.match(name) for pat in _EXTRA_KEY_PATTERNS)


def _looks_secret(name: str) -> bool:
    return any(name.endswith(sfx) for sfx in _SECRET_SUFFIXES)


def read_env_file(path: Path) -> dict[str, str]:
    """Parse the file. Comments and blank lines skipped. Later assignments win."""
    out: dict[str, str] = {}
    if not path.exists():
        return out
    with path.open("r", encoding="utf-8") as f:
        for raw in f:
            m = _LINE_RE.match(raw)
            if not m:
                continue
            key = m.group(1)
            val = m.group(2).rstrip("\n")
            # Strip a single pair of surrounding quotes if present.
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                val = val[1:-1]
            out[key] = val
    return out


def list_entries(path: Path) -> list[EnvEntry]:
    """Combine schema + file contents into a UI-friendly list.

    Managed keys always appear (with empty values if not in the file yet).
    Extras only appear if they're present in the file.
    Unknown-shape keys (don't match KNOWN_KEYS OR _EXTRA_KEY_PATTERNS) are
    included as read-only entries so the operator can see them but can't
    edit them via the UI (edit those by SSH-ing in).
    """
    file_vals = read_env_file(path)
    out: list[EnvEntry] = []
    seen: set[str] = set()
    for key in KNOWN_KEYS:
        seen.add(key.name)
        out.append(EnvEntry(
            name=key.name,
            value=file_vals.get(key.name, ""),
            is_managed=True,
            is_secret=key.is_secret,
            key=key,
        ))
    for name, val in file_vals.items():
        if name in seen:
            continue
        out.append(EnvEntry(
            name=name, value=val,
            is_managed=False,
            is_extra_writable=_is_extra_writable(name),
            is_secret=_looks_secret(name),
        ))
    return out


# ---------- write ----------

def _rewrite(path: Path, updates: dict[str, str]) -> None:
    """Line-based patch: replace or append. Preserves comments/blank lines."""
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    lines = text.splitlines(keepends=True)
    # If the file doesn't end with a newline, make sure any appended lines
    # start on their own.
    if lines and not lines[-1].endswith("\n"):
        lines[-1] = lines[-1] + "\n"

    remaining = dict(updates)
    out: list[str] = []
    for raw in lines:
        m = _LINE_RE.match(raw)
        if m and m.group(1) in remaining:
            key = m.group(1)
            new_val = remaining.pop(key)
            out.append(f"{key}={new_val}\n")
        else:
            out.append(raw)
    for key, new_val in remaining.items():
        out.append(f"{key}={new_val}\n")

    new_text = "".join(out)
    # Prefer atomic replace when the parent is writable.
    parent = path.parent
    if os.access(parent, os.W_OK):
        with tempfile.NamedTemporaryFile(
                "w", encoding="utf-8",
                dir=str(parent), prefix=f".{path.name}.", suffix=".tmp",
                delete=False) as tmp:
            tmp_path = Path(tmp.name)
            tmp.write(new_text)
        # Preserve original mode/owner if possible.
        try:
            st = path.stat()
            os.chmod(tmp_path, st.st_mode & 0o777)
        except OSError:
            pass
        os.replace(tmp_path, path)
    else:
        # In-place rewrite — non-atomic. Only used when /etc parent isn't
        # writable by us (mode 660 root:gamesrv). Truncate + rewrite.
        with path.open("w", encoding="utf-8") as f:
            f.write(new_text)


def update_env_file(path: Path, updates: dict[str, str]) -> dict:
    """Apply `updates` to the file. Rules:

    * `updates` values equal to `""` for keys flagged secret in KNOWN_KEYS
      (or matching _SECRET_SUFFIXES) mean "keep the current value" — so a
      user hitting Save without retyping their token doesn't wipe it.
    * Only keys in KNOWN_KEYS or matching _EXTRA_KEY_PATTERNS are accepted.
    * Returns a summary dict for the UI: changed, unchanged_secrets, rejected.

    Raises OSError if the file isn't writable.
    """
    writable, reason = env_file_writable(path)
    if not writable:
        raise OSError(reason)

    current = read_env_file(path)
    to_write: dict[str, str] = {}
    changed: list[str] = []
    unchanged_secrets: list[str] = []
    rejected: list[str] = []

    for key, new_val in updates.items():
        key = key.strip()
        if not key:
            continue

        known = _KEYS_BY_NAME.get(key)
        allowed = known is not None or _is_extra_writable(key)
        if not allowed:
            rejected.append(key)
            continue

        is_secret = (known.is_secret if known else _looks_secret(key))
        if is_secret and new_val == "" and key in current:
            unchanged_secrets.append(key)
            continue

        if current.get(key, "") == new_val:
            continue  # no-op
        to_write[key] = new_val
        changed.append(key)

    if to_write:
        _rewrite(path, to_write)

    return {
        "ok": True,
        "path": str(path),
        "changed": changed,
        "unchanged_secrets": unchanged_secrets,
        "rejected": rejected,
        "writability_note": reason,
    }
