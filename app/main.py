"""FastAPI entrypoint. Routes:

  GET  /                          — dashboard
  GET  /healthz                   — health check (unauthenticated)
  GET  /api/servers               — list defs + status
  POST /api/servers               — create/update a def
  DEL  /api/servers/{name}        — remove a def (does NOT delete files)
  GET  /api/servers/{name}        — full detail
  POST /api/servers/{name}/action — start/stop/restart/enable/disable
  POST /api/servers/{name}/install — run type-handler install
  POST /api/servers/{name}/update  — run type-handler update (steamcmd re-runs +app_update)
  POST /api/servers/{name}/console — send a console command
  GET  /api/servers/{name}/logs   — journalctl tail
  GET  /api/servers/{name}/files  — list files under area (install|world)
  POST /api/servers/{name}/files  — upload a file
  GET  /api/servers/{name}/files/download  — download a file
  DEL  /api/servers/{name}/files  — delete a file
  POST /api/servers/{name}/backup — snapshot world_dir to tgz
  GET  /api/servers/{name}/backups — list snapshots
  POST /api/servers/{name}/restore — restore a snapshot (server must be stopped)
  POST /api/manager/update        — self-update the manager from GitHub
  GET  /api/manager/update/log    — tail update.log

All /api endpoints require Bearer token. The dashboard prompts for it and
stores it in localStorage.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from . import control, registry, uploads, updater, git_source
from .auth import require_token
from .config import settings
from .types import handler_for


app = FastAPI(title="Game Server Manager", version="0.1.0")

_APP_ROOT = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(_APP_ROOT / "templates"))
app.mount("/static", StaticFiles(directory=str(_APP_ROOT / "static")), name="static")


# ---------- health / dashboard ----------

@app.get("/healthz", response_class=PlainTextResponse)
def healthz() -> str:
    return "ok"


@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("index.html", {"request": request})


# ---------- server registry ----------

@app.get("/api/servers", dependencies=[Depends(require_token)])
def api_list_servers() -> list[dict]:
    out = []
    for sd in registry.list_defs():
        st = control.status(sd)
        out.append({
            "def": sd.model_dump(mode="json"),
            "status": {
                "active": st.active, "sub": st.sub, "enabled": st.enabled,
                "pid": st.pid, "mem_bytes": st.mem_bytes,
                "uptime_sec": st.uptime_sec,
                "console_available": control.console_available(sd),
            },
        })
    return out


@app.get("/api/servers/{name}", dependencies=[Depends(require_token)])
def api_get_server(name: str) -> dict:
    sd = registry.load_def(name)
    st = control.status(sd)
    return {
        "def": sd.model_dump(mode="json"),
        "status": {
            "active": st.active, "sub": st.sub, "enabled": st.enabled,
            "pid": st.pid, "mem_bytes": st.mem_bytes,
            "uptime_sec": st.uptime_sec,
            "console_available": control.console_available(sd),
        },
        "backups": uploads.list_backups(sd, settings.backup_root),
    }


@app.post("/api/servers", dependencies=[Depends(require_token)])
def api_upsert_server(sd: registry.ServerDef) -> dict:
    registry.save_def(sd)
    return {"ok": True, "path": str((settings.defs_dir / f'{sd.name}.yml'))}


@app.delete("/api/servers/{name}", dependencies=[Depends(require_token)])
def api_delete_server(name: str) -> dict:
    registry.delete_def(name)
    return {"ok": True}


# ---------- lifecycle ----------

class ActionBody(BaseModel):
    action: str  # start | stop | restart | enable | disable


@app.post("/api/servers/{name}/action", dependencies=[Depends(require_token)])
def api_action(name: str, body: ActionBody) -> dict:
    sd = registry.load_def(name)
    fn = {
        "start": control.start,
        "stop": control.stop,
        "restart": control.restart,
        "enable": control.enable,
        "disable": control.disable,
    }.get(body.action)
    if fn is None:
        raise HTTPException(status_code=400, detail=f"unknown action {body.action!r}")
    r = fn(sd)
    return {
        "ok": r.returncode == 0,
        "returncode": r.returncode,
        "stdout": r.stdout,
        "stderr": r.stderr,
    }


@app.post("/api/servers/{name}/install", dependencies=[Depends(require_token)])
def api_install(name: str) -> dict:
    sd = registry.load_def(name)
    try:
        msgs = handler_for(sd).install()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"ok": True, "messages": msgs}


@app.post("/api/servers/{name}/update", dependencies=[Depends(require_token)])
def api_type_update(name: str) -> dict:
    sd = registry.load_def(name)
    try:
        msgs = handler_for(sd).update()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"ok": True, "messages": msgs}


# ---------- console + logs ----------

class ConsoleBody(BaseModel):
    command: str


@app.post("/api/servers/{name}/console", dependencies=[Depends(require_token)])
def api_console(name: str, body: ConsoleBody) -> dict:
    sd = registry.load_def(name)
    try:
        control.send_console(sd, body.command)
    except (ValueError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True, "sent": body.command}


@app.get("/api/servers/{name}/logs", response_class=PlainTextResponse, dependencies=[Depends(require_token)])
def api_logs(name: str, lines: int = 200) -> str:
    sd = registry.load_def(name)
    return control.tail_logs(sd, lines=max(1, min(2000, lines)))


# ---------- files: upload / download / list / delete ----------

@app.get("/api/servers/{name}/files", dependencies=[Depends(require_token)])
def api_files_list(name: str, area: str = "install", path: str = "") -> list[dict]:
    sd = registry.load_def(name)
    return uploads.list_dir(sd, area, path)


@app.post("/api/servers/{name}/files", dependencies=[Depends(require_token)])
async def api_files_upload(
    name: str,
    file: UploadFile,
    area: str = Form("install"),
    path: str = Form(""),
    overwrite: bool = Form(False),
) -> dict:
    sd = registry.load_def(name)
    dest_rel = path or (file.filename or "")
    if not dest_rel:
        raise HTTPException(status_code=400, detail="path or filename required")
    saved = await uploads.save_upload(sd, area, dest_rel, file, overwrite=overwrite)
    return {"ok": True, "saved": str(saved), "bytes": saved.stat().st_size}


@app.post("/api/servers/{name}/files/extract", dependencies=[Depends(require_token)])
async def api_files_extract(
    name: str,
    file: UploadFile,
    area: str = Form("install"),
    dest_subdir: str = Form(""),
    overwrite: bool = Form(False),
) -> dict:
    """Upload a .zip / .tar.gz / .tgz / .tar / .tar.bz2 archive and extract it
    into the requested area (optionally into a subdirectory). One HTTP round
    trip beats N uploads for large trees like a whole Forge server or a
    world backup exported from another host.
    """
    sd = registry.load_def(name)
    return await uploads.extract_upload(sd, area, dest_subdir, file, overwrite=overwrite)


@app.get("/api/servers/{name}/files/download", dependencies=[Depends(require_token)])
def api_files_download(name: str, area: str = "install", path: str = "") -> FileResponse:
    sd = registry.load_def(name)
    target, _ = uploads.open_download(sd, area, path)
    return FileResponse(target, filename=target.name)


@app.delete("/api/servers/{name}/files", dependencies=[Depends(require_token)])
def api_files_delete(name: str, area: str = "install", path: str = "") -> dict:
    sd = registry.load_def(name)
    uploads.delete_path(sd, area, path)
    return {"ok": True}


# ---------- git source ----------

class GitSyncBody(BaseModel):
    dry_run: bool = False


@app.post("/api/servers/{name}/git/sync", dependencies=[Depends(require_token)])
def api_git_sync(name: str, body: GitSyncBody | None = None) -> dict:
    """Clone (first time) or fetch + fast-forward the configured git source,
    then rsync the tree into install_dir (and world_dir if world_subdir is
    set). On success, records deployed_sha/ref/at back into the server def.
    """
    sd = registry.load_def(name)
    if not sd.git_source.url:
        raise HTTPException(status_code=400, detail="server has no git_source.url configured")
    try:
        r = git_source.sync(sd, dry_run=bool(body and body.dry_run))
    except git_source.GitError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # unexpected — surface class name so we don't leak paths/tokens
        raise HTTPException(status_code=500, detail=f"git sync failed: {e.__class__.__name__}") from e

    if not (body and body.dry_run):
        sd.git_source.deployed_sha = r.get("sha", "")
        sd.git_source.deployed_ref = r.get("ref", "")
        sd.git_source.deployed_at = r.get("deployed_at", "")
        registry.save_def(sd)
    return r


@app.get("/api/servers/{name}/git/status", dependencies=[Depends(require_token)])
def api_git_status(name: str) -> dict:
    """Cheap probe of the remote HEAD for the configured ref. Uses
    `git ls-remote` — no clone, no fetch. Used by the UI to show
    'update available' hints on the Git tab."""
    sd = registry.load_def(name)
    if not sd.git_source.url:
        return {"ok": False, "error": "no git_source configured"}
    try:
        return git_source.remote_head(sd)
    except git_source.GitError as e:
        return {"ok": False, "error": str(e)}


@app.post("/api/servers/{name}/git/clear-cache", dependencies=[Depends(require_token)])
def api_git_clear_cache(name: str) -> dict:
    sd = registry.load_def(name)
    return git_source.clear_cache(sd)


# ---------- backups ----------

@app.post("/api/servers/{name}/backup", dependencies=[Depends(require_token)])
def api_backup(name: str) -> dict:
    sd = registry.load_def(name)
    dest = uploads.make_backup(sd, settings.backup_root)
    return {"ok": True, "backup": str(dest), "bytes": dest.stat().st_size}


@app.get("/api/servers/{name}/backups", dependencies=[Depends(require_token)])
def api_backups_list(name: str) -> list[dict]:
    sd = registry.load_def(name)
    return uploads.list_backups(sd, settings.backup_root)


class RestoreBody(BaseModel):
    backup_name: str


@app.post("/api/servers/{name}/restore", dependencies=[Depends(require_token)])
def api_restore(name: str, body: RestoreBody) -> dict:
    sd = registry.load_def(name)
    st = control.status(sd)
    if st.active == "active":
        raise HTTPException(status_code=409, detail="stop the server before restoring")
    uploads.restore_backup(sd, settings.backup_root, body.backup_name)
    return {"ok": True}


# ---------- self-update ----------

@app.post("/api/manager/update", dependencies=[Depends(require_token)])
def api_manager_update() -> dict:
    return updater.trigger_update()


@app.get("/api/manager/update/log", response_class=PlainTextResponse, dependencies=[Depends(require_token)])
def api_manager_update_log(lines: int = 200) -> str:
    return updater.update_log_tail(lines=max(1, min(2000, lines)))


# ---------- error handler: don't leak stack traces ----------

@app.exception_handler(Exception)
async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
    # Uvicorn's own logger will still capture the traceback server-side.
    return JSONResponse(status_code=500, content={"detail": f"internal error: {exc.__class__.__name__}"})


# suppress unused-import warnings from static analyzers on Optional
_ = Optional
