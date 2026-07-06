"""File upload/download + backup helpers.

Preston's ask: "ensure there is a way to upload server data". These endpoints
let you push a new server JAR, drop mods/config/plugins, or restore a world
backup — all scoped to the server's install_dir or world_dir.
"""
from __future__ import annotations

import io
import os
import shutil
import tarfile
import time
from pathlib import Path

from fastapi import HTTPException, UploadFile

from .registry import ServerDef


# What each "area" name maps to on disk. Prevents callers from writing anywhere.
def _area_root(sd: ServerDef, area: str) -> Path:
    if area == "install":
        return Path(sd.install_dir).resolve()
    if area == "world":
        return Path(sd.world_dir).resolve()
    raise HTTPException(status_code=400, detail=f"unknown area: {area!r} (want 'install' or 'world')")


def _safe_join(root: Path, rel: str) -> Path:
    """Reject absolute paths, empty, or anything that escapes root via ..

    This is the OWASP path-traversal guard. Any callers touching user input
    MUST go through this.
    """
    if not rel or rel.strip() in ("", "."):
        return root
    # Normalise separators; forbid absolute paths.
    rel_p = Path(rel.replace("\\", "/"))
    if rel_p.is_absolute():
        raise HTTPException(status_code=400, detail="path must be relative")
    target = (root / rel_p).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=400, detail="path escapes server root") from None
    return target


async def save_upload(
    sd: ServerDef,
    area: str,
    dest_rel_path: str,
    upload: UploadFile,
    *,
    overwrite: bool = False,
) -> Path:
    root = _area_root(sd, area)
    root.mkdir(parents=True, exist_ok=True)
    target = _safe_join(root, dest_rel_path)
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.exists() and not overwrite:
        raise HTTPException(status_code=409, detail="file exists; pass overwrite=true")

    # Stream to a .part file, then atomic rename so a partial upload is never
    # picked up as the real file.
    tmp = target.with_suffix(target.suffix + ".part")
    with tmp.open("wb") as f:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, target)
    return target


def open_download(sd: ServerDef, area: str, rel_path: str) -> tuple[Path, int]:
    target = _safe_join(_area_root(sd, area), rel_path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="not a file")
    return target, target.stat().st_size


def list_dir(sd: ServerDef, area: str, rel_path: str = "") -> list[dict]:
    root = _area_root(sd, area)
    root.mkdir(parents=True, exist_ok=True)
    target = _safe_join(root, rel_path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="path not found")
    if target.is_file():
        st = target.stat()
        return [{"name": target.name, "is_dir": False, "size": st.st_size, "mtime": int(st.st_mtime)}]
    out = []
    for child in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        st = child.stat()
        out.append({
            "name": child.name,
            "is_dir": child.is_dir(),
            "size": 0 if child.is_dir() else st.st_size,
            "mtime": int(st.st_mtime),
        })
    return out


def delete_path(sd: ServerDef, area: str, rel_path: str) -> None:
    target = _safe_join(_area_root(sd, area), rel_path)
    if target == _area_root(sd, area):
        raise HTTPException(status_code=400, detail="refusing to delete server root")
    if not target.exists():
        raise HTTPException(status_code=404, detail="not found")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()


# ---------- backups ----------

def make_backup(sd: ServerDef, backup_root: Path) -> Path:
    """Tarball the world_dir (or backup.target) into backup_root/<name>/<ts>.tgz."""
    src = Path(sd.backup.target or sd.world_dir).resolve()
    if not src.exists():
        raise HTTPException(status_code=404, detail=f"nothing to back up at {src}")
    dest_dir = backup_root / sd.name
    dest_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    dest = dest_dir / f"{sd.name}-{ts}.tgz"
    tmp = dest.with_suffix(".tgz.part")
    with tarfile.open(tmp, "w:gz") as tar:
        tar.add(src, arcname=src.name)
    os.replace(tmp, dest)
    return dest


def list_backups(sd: ServerDef, backup_root: Path) -> list[dict]:
    d = backup_root / sd.name
    if not d.exists():
        return []
    out = []
    for p in sorted(d.glob("*.tgz"), reverse=True):
        st = p.stat()
        out.append({"name": p.name, "size": st.st_size, "mtime": int(st.st_mtime)})
    return out


def restore_backup(sd: ServerDef, backup_root: Path, backup_name: str) -> None:
    """Extract a backup back over world_dir. Server MUST be stopped first."""
    if "/" in backup_name or "\\" in backup_name or backup_name.startswith("."):
        raise HTTPException(status_code=400, detail="invalid backup name")
    src = backup_root / sd.name / backup_name
    if not src.is_file():
        raise HTTPException(status_code=404, detail="backup not found")
    dest = Path(sd.world_dir).resolve()
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Extract into a sibling temp dir then swap — never mutate live worlds in place.
    staging = dest.parent / f".{dest.name}.restore-{int(time.time())}"
    staging.mkdir()
    try:
        with tarfile.open(src, "r:gz") as tar:
            # Safe extract: reject any entry that escapes staging.
            for member in tar.getmembers():
                member_path = (staging / member.name).resolve()
                try:
                    member_path.relative_to(staging.resolve())
                except ValueError as e:
                    raise HTTPException(status_code=400, detail=f"unsafe tar entry: {member.name}") from e
            tar.extractall(staging)  # noqa: S202  -- guarded above
        # Move existing world aside, promote restored copy.
        if dest.exists():
            aside = dest.parent / f".{dest.name}.replaced-{int(time.time())}"
            os.replace(dest, aside)
        # Backups are tarred with arcname=src.name, so restored payload sits one level in.
        entries = list(staging.iterdir())
        if len(entries) == 1 and entries[0].is_dir():
            os.replace(entries[0], dest)
            staging.rmdir()
        else:
            os.replace(staging, dest)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        raise


def human_bytes(n: int | None) -> str:
    if n is None:
        return "-"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024  # type: ignore[assignment]
    return f"{n:.1f} PB"


__all__ = [
    "save_upload", "open_download", "list_dir", "delete_path",
    "make_backup", "list_backups", "restore_backup", "human_bytes",
]

# Re-export io for callers that stream StreamingResponse
_ = io
