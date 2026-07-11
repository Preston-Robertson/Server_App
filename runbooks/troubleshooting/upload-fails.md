# Runbook: Upload Fails

## Symptoms
- File upload via dashboard Files tab returns an error.
- HTTP 4xx error shown in the browser console or dashboard.
- Upload completes but file doesn't appear in listing.

## Log locations
- **Manager journal**: `journalctl -u gamesrv-manager.service --since '10 min ago'`
- **Browser console**: Check for HTTP status code and response body.

## Diagnostic commands
```bash
# Check install dir ownership and permissions
ls -la /srv/gameservers/<name>/

# Check world dir ownership
ls -la /opt/gamesrv/worlds/<name>/

# Check available disk space
df -h /srv/gameservers /opt/gamesrv/worlds

# Test upload via curl (replace TOKEN, NAME, PATH)
curl -X POST \
  -H "Authorization: ****** TOKEN" \
  -F "file=@/tmp/test.jar" \
  -F "path=server.jar" \
  -F "area=install" \
  "http://localhost:8765/api/servers/NAME/files"
```

## Common causes

### 1. HTTP 400 "path escapes server root"
- **Cause**: Upload path contains `..` or is absolute. This is the path-traversal guard.
- **Fix**: Use a relative path without `..` components.

### 2. HTTP 400 "unknown area"
- **Cause**: `area` parameter is not `install` or `world`.
- **Fix**: Use `area=install` or `area=world`.

### 3. HTTP 409 "file exists"
- **Cause**: A file at the target path already exists and `overwrite=true` was not passed.
- **Fix**: Pass `overwrite=true` in the upload request, or delete the existing file first.

### 4. HTTP 413 "Request Entity Too Large"
- **Cause**: Upload exceeds uvicorn's default body size limit (may vary).
- **Fix**: Check uvicorn / FastAPI body size config. For large world files, consider SFTP directly to `/srv/gameservers/<name>/` or `/opt/gamesrv/worlds/<name>/`.

### 5. Permission denied on write
- **Cause**: Files in `install_dir` or `world_dir` owned by root (not `gamesrv`).
- **Fix**: `sudo chown -R gamesrv:gamesrv /srv/gameservers/<name>/`

### 6. Disk full
- **Cause**: No space left on the target filesystem.
- **Fix**: Free up space. The `.part` file from a failed upload will be cleaned up automatically on the next successful attempt or can be deleted manually (`rm *.part`).

## Related files/modules
- `app/uploads.py` — `save_upload()`, `_safe_join()`, `_area_root()`
- `app/_context/uploads.md` — full module summary
- `facts/paths.yaml` — install_root, worlds_root
