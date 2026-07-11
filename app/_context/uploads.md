# app/_context/uploads.md
# Context summary for app/uploads.py (446 lines).

## Purpose
File upload/download, directory listing, backup archive creation, and backup restore. Scopes all operations to a server's `install_dir` or `world_dir` via path-traversal protection.

## Public API
- `save_upload(sd, area, dest_rel_path, upload: UploadFile, *, overwrite=False)` → `Path` (async)
- `open_download(sd, area, rel_path)` → `tuple[Path, int]`
- `list_dir(sd, area, rel_path="")` → `list[dict]`
- `delete_file(sd, area, rel_path)` → None
- `make_backup(sd)` → `Path` (creates `<backup_root>/<name>/<timestamp>.tgz`)
- `list_backups(sd)` → `list[dict]`
- `restore_backup(sd, filename)` → `list[str]` (messages; server must be stopped)
- `_safe_join(root, rel)` → `Path` (path-traversal guard — used internally, not exported)

## Called by
`app/main.py` (file list/upload/download/delete endpoints, backup/restore endpoints).

## Calls / depends on
`app.registry.ServerDef`, `fastapi.HTTPException`, `pathlib`, `os`, `shutil`, `tarfile`, `zipfile`, `io`, `time`.

## Key invariants / gotchas
- **`_safe_join` is the security boundary**: all user-supplied paths MUST go through this. It rejects absolute paths and anything that resolves outside `root` via `..`. Raises HTTP 400 on violation.
- **Areas**: only `"install"` (→ `install_dir`) and `"world"` (→ `world_dir`) are valid. Any other area raises HTTP 400.
- **Atomic upload**: streams to a `.part` file, then `os.replace()`. A partial upload never overwrites the real file.
- **Overwrite protection**: by default, uploading to an existing path raises HTTP 409. Pass `overwrite=True` to allow.
- **`make_backup()` creates `backup_root/<name>/` dir** automatically.
- **`restore_backup()` requires server to be stopped**: the caller (main.py) enforces this. Restoring to a running server would corrupt in-use files.
- ZIP files are auto-extracted; other archives are extracted with tarfile.

## Common failure modes
- HTTP 400 "path escapes server root": user passed `../../etc/passwd` or an absolute path. Correct behavior — not a bug.
- HTTP 409 "file exists": upload without `overwrite=true` to an existing path.
- HTTP 404 on download: file was deleted externally or path is wrong.
- `make_backup` fails if `world_dir` doesn't exist or is a broken symlink — surfaces as exception in the background job.

## Where to change what
- Add a new upload area (e.g. `"config"`): add a branch in `_area_root()`.
- Change backup archive format: edit `make_backup()`.
- Change restore behavior: edit `restore_backup()`.
