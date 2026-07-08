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
import zipfile
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


# ---------- archive upload + safe extract ----------
#
# Same safety guarantees as restore_backup(): staging dir first, then reject
# any archive member whose resolved path would escape the target root, then
# swap files into place. Refuses symlink members outright to avoid the
# classic "symlink pointing at /etc/shadow that we then overwrite" trick.

_ARCHIVE_SUFFIXES = (".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2")


def _looks_like_archive(name: str) -> bool:
    n = name.lower()
    return any(n.endswith(s) for s in _ARCHIVE_SUFFIXES)


async def extract_upload(
    sd: ServerDef,
    area: str,
    dest_subdir: str,
    upload: UploadFile,
    *,
    overwrite: bool = False,
) -> dict:
    """Stream an uploaded archive to a temp file, then safely extract it.

    dest_subdir is relative to the area root. Existing files are refused
    unless overwrite=True (in which case the target subdir is emptied first).
    Returns a small summary suitable for a JSON response.
    """
    if not upload.filename or not _looks_like_archive(upload.filename):
        raise HTTPException(status_code=400, detail=(
            "archive upload must be one of: " + ", ".join(_ARCHIVE_SUFFIXES)
        ))

    root = _area_root(sd, area)
    root.mkdir(parents=True, exist_ok=True)
    target = _safe_join(root, dest_subdir) if dest_subdir else root
    target.mkdir(parents=True, exist_ok=True)

    # Buffer the upload to disk first — zipfile/tarfile want a seekable stream.
    tmp_dir = root.parent / f".{root.name}.extract-{int(time.time())}"
    tmp_dir.mkdir()
    tmp_archive = tmp_dir / (upload.filename or "upload.bin")
    try:
        with tmp_archive.open("wb") as f:
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)

        staging = tmp_dir / "extracted"
        staging.mkdir()

        name_lc = upload.filename.lower()
        if name_lc.endswith(".zip"):
            entries = _extract_zip_safe(tmp_archive, staging)
        else:
            entries = _extract_tar_safe(tmp_archive, staging)

        # Optionally clear the destination subdir before merging in.
        if overwrite and target != root and target.exists():
            for child in target.iterdir():
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child)
                else:
                    child.unlink()
        elif overwrite and target == root:
            # Overwriting the area root is refused — too dangerous.
            raise HTTPException(status_code=400, detail=(
                "overwrite=true requires a dest_subdir; refusing to wipe the area root"
            ))

        # Merge staged contents onto target. Directories are created as needed;
        # files replace existing ones. This is the "unpack into place" step.
        merged = 0
        for src_root, dirs, files in os.walk(staging):
            src_rel = Path(src_root).relative_to(staging)
            dest_root = target / src_rel
            dest_root.mkdir(parents=True, exist_ok=True)
            for fname in files:
                src_file = Path(src_root) / fname
                dest_file = dest_root / fname
                # If the destination already exists and we haven't been asked to
                # overwrite, keep the existing file and count it as skipped.
                if dest_file.exists() and not overwrite:
                    continue
                if dest_file.exists():
                    dest_file.unlink()
                shutil.move(str(src_file), str(dest_file))
                merged += 1

        return {
            "ok": True,
            "archive": upload.filename,
            "extracted_to": str(target),
            "entries_in_archive": entries,
            "files_written": merged,
        }
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _extract_zip_safe(archive: Path, staging: Path) -> int:
    """Extract a .zip, rejecting escape attempts and symlink members."""
    with zipfile.ZipFile(archive) as zf:
        # Guard: reject any member whose resolved path escapes staging.
        members = zf.infolist()
        for m in members:
            _guard_member_name(m.filename, staging)
            # ZIP unix mode is in external_attr >> 16. S_IFLNK = 0o120000.
            unix_mode = (m.external_attr >> 16) & 0xFFFF
            if unix_mode and (unix_mode & 0o170000) == 0o120000:
                raise HTTPException(status_code=400, detail=(
                    f"refusing to extract symlink from zip: {m.filename}"
                ))
        zf.extractall(staging)  # guarded above  # noqa: S202
        return len(members)


def _extract_tar_safe(archive: Path, staging: Path) -> int:
    """Extract .tar/.tar.gz/.tgz/.tar.bz2, rejecting symlinks and escape paths."""
    with tarfile.open(archive) as tf:
        members = tf.getmembers()
        for m in members:
            _guard_member_name(m.name, staging)
            if m.issym() or m.islnk():
                raise HTTPException(status_code=400, detail=(
                    f"refusing to extract link from tar: {m.name}"
                ))
            if m.isdev():
                raise HTTPException(status_code=400, detail=(
                    f"refusing device node from tar: {m.name}"
                ))
        # Python 3.12+ has a `filter=` argument; use it if present for defense
        # in depth. Older Pythons rely on the guards above.
        try:
            tf.extractall(staging, filter="data")  # type: ignore[arg-type]  # noqa: S202
        except TypeError:
            tf.extractall(staging)  # noqa: S202
        return len(members)


def _guard_member_name(name: str, staging: Path) -> None:
    if not name or name.strip() in ("", "."):
        return
    if name.startswith("/") or ".." in Path(name).parts:
        raise HTTPException(status_code=400, detail=f"unsafe archive entry: {name}")
    resolved = (staging / name).resolve()
    try:
        resolved.relative_to(staging.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail=f"archive entry escapes root: {name}") from None


# ---------- backups ----------

def make_backup(sd: ServerDef, backup_root: Path, on_event=None) -> Path:
    """Tarball the world_dir (or backup.target) into backup_root/<name>/<ts>.tgz.

    Optional ``on_event`` callback (used by the job registry) receives
    incremental progress dicts as the archive is built. Total is the
    uncompressed source size — the final .tgz will be smaller.
    """
    src = Path(sd.backup.target or sd.world_dir).resolve()
    if not src.exists():
        raise HTTPException(status_code=404, detail=f"nothing to back up at {src}")
    dest_dir = backup_root / sd.name
    dest_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    dest = dest_dir / f"{sd.name}-{ts}.tgz"
    tmp = dest.with_suffix(".tgz.part")

    # Pre-scan so the progress bar shows a meaningful percent from the start.
    if on_event:
        on_event({"phase": "scanning", "percent": 0.0, "line": f"scanning {src}"})
    total_bytes = 0
    total_files = 0
    for p in src.rglob("*"):
        if p.is_file():
            try:
                total_bytes += p.stat().st_size
            except OSError:
                pass
            total_files += 1
    if on_event:
        on_event({
            "phase": "archiving",
            "percent": 0.0,
            "bytes_done": 0,
            "bytes_total": total_bytes,
            "line": f"{total_files} files, {human_bytes(total_bytes)} uncompressed",
        })

    done_bytes = [0]  # boxed so the filter closure can mutate

    def _tar_filter(ti):
        if ti.isfile() and ti.size:
            done_bytes[0] += ti.size
        if on_event:
            pct = 100.0 * done_bytes[0] / total_bytes if total_bytes else 0.0
            on_event({
                "phase": "archiving",
                "percent": min(100.0, pct),
                "bytes_done": done_bytes[0],
                "bytes_total": total_bytes,
                "line": ti.name,
            })
        return ti

    with tarfile.open(tmp, "w:gz") as tar:
        tar.add(src, arcname=src.name, filter=_tar_filter)
    os.replace(tmp, dest)

    if on_event:
        on_event({
            "phase": "complete",
            "percent": 100.0,
            "line": f"wrote {dest.name} ({human_bytes(dest.stat().st_size)} on disk)",
        })
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


def restore_backup(sd: ServerDef, backup_root: Path, backup_name: str, on_event=None) -> None:
    """Extract a backup back over world_dir. Server MUST be stopped first.

    Optional ``on_event`` callback receives incremental progress as members
    are extracted (percent is by uncompressed member size).
    """
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
            if on_event:
                on_event({"phase": "reading archive", "percent": 0.0, "line": src.name})
            members = tar.getmembers()
            # Safe extract: reject any entry that escapes staging before we
            # start writing anything.
            for member in members:
                member_path = (staging / member.name).resolve()
                try:
                    member_path.relative_to(staging.resolve())
                except ValueError as e:
                    raise HTTPException(status_code=400, detail=f"unsafe tar entry: {member.name}") from e

            total = sum(m.size for m in members if m.isfile()) or 1
            done = 0
            n = len(members)
            if on_event:
                on_event({
                    "phase": "extracting",
                    "percent": 0.0,
                    "bytes_done": 0,
                    "bytes_total": total,
                    "line": f"{n} entries, {human_bytes(total)} uncompressed",
                })
            for i, m in enumerate(members):
                tar.extract(m, staging)  # noqa: S202 -- guarded above
                if m.isfile():
                    done += m.size
                if on_event and (i % 25 == 0 or i == n - 1):
                    pct = 100.0 * done / total
                    on_event({
                        "phase": "extracting",
                        "percent": min(100.0, pct),
                        "bytes_done": done,
                        "bytes_total": total,
                        "line": m.name,
                    })
        # Move existing world aside, promote restored copy.
        if on_event:
            on_event({"phase": "swapping world", "percent": 99.0, "line": str(dest)})
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
        if on_event:
            on_event({"phase": "complete", "percent": 100.0, "line": f"restored {src.name}"})
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
    "extract_upload",
    "make_backup", "list_backups", "restore_backup", "human_bytes",
]

# Re-export io for callers that stream StreamingResponse
_ = io
