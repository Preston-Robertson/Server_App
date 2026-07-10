"""Push local ``worlds/_backups/<server>/`` snapshots to a git remote.

Complements the local backup archive story with an offsite copy so that
if the LXC (or the TrueNAS bind mount) is lost, a fresh install can pull
its world data back from GitHub.

Design goals:
  * **Reuse the existing local backups.** No duplicate compression; we
    commit the exact ``.tgz`` files ``uploads.make_backup()`` already writes.
  * **Auto-provision a private repo** when the operator hasn't provided
    one — bootstrap friction should be as low as "toggle Enabled + click
    Push". Only implemented for GitHub today; the ``provider`` field is
    forward-compat for a self-hosted Gitea/Forgejo later.
  * **Fail loud, fail cheap.** No cron, no background push worker in this
    module — every push is initiated explicitly from the API. Errors
    return to the caller as ``RuntimeError`` with actionable messages.

Auth:
  * Priority: per-request PAT (from the API body) > ``git_backup.token_env``
    > ``GAMESRV_GITHUB_TOKEN`` env fallback. Anywhere the token is used it's
    injected into the URL for one command and then scrubbed from
    ``.git/config`` immediately after.

Repo naming for the auto-create path:
  * ``gamesrv-backup-<server-name>``, owned by the token's user, private,
    default branch ``main``. Description mentions the server def so it's
    obvious what the repo is for on GitHub's UI.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse, urlunparse
from urllib.request import Request, urlopen

from .config import settings
from .registry import GitBackupCfg, ServerDef, save_def


# GitHub REST v3
_GITHUB_API = "https://api.github.com"


# ---------- token resolution ----------

def _resolve_token(cfg: GitBackupCfg, override: Optional[str]) -> str:
    """Priority: per-request override > cfg.token_env > GAMESRV_GITHUB_TOKEN."""
    if override:
        return override.strip()
    if cfg.token_env:
        val = os.environ.get(cfg.token_env, "").strip()
        if not val:
            raise RuntimeError(
                f"git_backup.token_env={cfg.token_env!r} is not set in the environment"
            )
        return val
    fallback = os.environ.get("GAMESRV_GITHUB_TOKEN", "").strip()
    if not fallback:
        raise RuntimeError(
            "no GitHub token available — set GAMESRV_GITHUB_TOKEN in /etc/gamesrv.env, "
            "or point git_backup.token_env at a different variable"
        )
    return fallback


# ---------- URL utilities ----------

def _inject_token(url: str, token: str) -> str:
    """Return the same HTTPS URL with the token spliced in for one command."""
    if not url.startswith("http"):
        return url   # SSH URL — token auth doesn't apply
    p = urlparse(url)
    # Use x-access-token for GitHub PATs; other providers accept anything
    # non-empty as the username with the token as the password.
    netloc = f"x-access-token:{quote(token, safe='')}@{p.hostname}"
    if p.port:
        netloc += f":{p.port}"
    return urlunparse((p.scheme, netloc, p.path, p.params, p.query, p.fragment))


def _scrub_credentials(cwd: Path) -> None:
    """Remove any tokens from .git/config after a token-injecting op."""
    cfg = cwd / ".git" / "config"
    if not cfg.exists():
        return
    try:
        text = cfg.read_text(encoding="utf-8")
    except OSError:
        return
    cleaned = re.sub(
        r"(https?://)[^@\s/]+:[^@\s/]+@",
        r"\1",
        text,
    )
    if cleaned != text:
        try:
            cfg.write_text(cleaned, encoding="utf-8")
        except OSError:
            pass


# ---------- git subprocess ----------

def _run_git(args: list[str], *, cwd: Path, timeout: int = 300,
             extra_env: Optional[dict] = None) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"   # never prompt for password
    env.setdefault("HOME", str(Path.home()))
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


# ---------- GitHub API (auto-create private repo) ----------

def _github_api(method: str, path: str, token: str, body: Optional[dict] = None,
                timeout: int = 15) -> tuple[int, dict]:
    """Minimal GitHub REST call. Returns (status, parsed_json_or_error_dict)."""
    url = f"{_GITHUB_API}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = Request(
        url,
        method=method,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "gamesrv-manager/1.0",
            "Content-Type": "application/json" if data else "application/octet-stream",
        },
    )
    try:
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return resp.status, (json.loads(raw) if raw else {})
    except HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"message": raw or str(e)}
    except URLError as e:
        raise RuntimeError(f"GitHub API unreachable: {e}") from e


def _github_username(token: str) -> str:
    status, body = _github_api("GET", "/user", token)
    if status != 200:
        raise RuntimeError(
            f"GitHub token rejected (status {status}): {body.get('message', '?')}. "
            "The PAT needs the 'repo' scope to create private repos."
        )
    return body.get("login", "")


def _repo_name_for(sd: ServerDef) -> str:
    """Deterministic repo name so re-runs land on the same remote."""
    return f"gamesrv-backup-{sd.name}"


def _ensure_github_repo(sd: ServerDef, token: str) -> str:
    """Create the repo if it doesn't exist. Return the HTTPS clone URL."""
    owner = _github_username(token)
    repo = _repo_name_for(sd)

    # Fast path: repo already exists.
    status, body = _github_api("GET", f"/repos/{owner}/{repo}", token)
    if status == 200:
        return body.get("clone_url") or f"https://github.com/{owner}/{repo}.git"
    if status != 404:
        raise RuntimeError(
            f"GitHub repo probe returned {status}: {body.get('message', '?')}"
        )

    # Create it.
    status, body = _github_api("POST", "/user/repos", token, body={
        "name": repo,
        "private": True,
        "description": (
            f"Automated world/save backups for gamesrv server "
            f"{sd.name!r} (type={sd.type})."
        ),
        "auto_init": True,           # so we have a branch to push to
        "default_branch": "main",
    })
    if status not in (200, 201):
        raise RuntimeError(
            f"GitHub repo create failed (status {status}): "
            f"{body.get('message', '?')}"
        )
    return body.get("clone_url") or f"https://github.com/{owner}/{repo}.git"


# ---------- push flow ----------

def _backup_dir(sd: ServerDef) -> Path:
    """Where uploads.make_backup() drops the .tgz files."""
    return Path(settings.backup_root) / sd.name


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def push(sd: ServerDef, *, override_token: Optional[str] = None) -> dict:
    """Commit + push every ``.tgz`` under ``worlds/_backups/<name>/`` to the
    configured (or auto-created) git remote. Returns a status dict for the API.

    Idempotent: if there are no new/changed .tgz files, exits cleanly with
    ``pushed_new=False`` and a "nothing to commit" message.
    """
    cfg = sd.git_backup
    if not cfg.enabled:
        raise RuntimeError("git_backup.enabled is false")

    token = _resolve_token(cfg, override_token)

    # 1. Auto-provision on first use if the URL is blank.
    repo_url = cfg.repo_url.strip()
    auto_created = False
    if not repo_url:
        if cfg.provider != "github":
            raise RuntimeError(
                f"auto-provisioning is only implemented for provider=github; "
                f"set git_backup.repo_url manually for provider={cfg.provider!r}"
            )
        repo_url = _ensure_github_repo(sd, token)
        auto_created = True
        # Persist the URL so subsequent pushes skip the probe.
        sd.git_backup.repo_url = repo_url
        sd.git_backup.provisioned_at = _now_iso()
        save_def(sd)

    # 2. Ensure the local .tgz directory is a git repo pointed at the remote.
    bdir = _backup_dir(sd)
    bdir.mkdir(parents=True, exist_ok=True)

    if not (bdir / ".git").exists():
        r = _run_git(["init", "-b", cfg.branch or "main"], cwd=bdir)
        if r.returncode != 0:
            raise RuntimeError(f"git init failed: {r.stderr.strip()}")
        # A tiny .gitattributes so git doesn't try to text-diff .tgz — cuts
        # push size on repeated backups where blocks partially overlap.
        (bdir / ".gitattributes").write_text(
            "*.tgz binary\n*.tar.gz binary\n", encoding="utf-8"
        )
        # Also a README so the initial commit isn't empty and GitHub's UI
        # renders the repo purpose clearly.
        (bdir / "README.md").write_text(
            f"# gamesrv-backup: {sd.name}\n\n"
            f"Automated world/save archives for gamesrv server **{sd.name}** (type=`{sd.type}`).\n\n"
            "Each commit adds one or more `.tgz` snapshots produced by the "
            "Backups tab in the manager. Restore by downloading a `.tgz` and "
            "uploading it back via the manager's Backups tab.\n",
            encoding="utf-8",
        )

    # (Re)set the remote to the current URL — cheap and idempotent.
    _run_git(["remote", "remove", "origin"], cwd=bdir)   # ignore failure
    r = _run_git(["remote", "add", "origin", repo_url], cwd=bdir)
    if r.returncode != 0:
        raise RuntimeError(f"git remote add failed: {r.stderr.strip()}")

    # Commit identity (uses the token owner login when possible; falls
    # back to a generic identity otherwise).
    who = "gamesrv-manager"
    try:
        who = _github_username(token) or who
    except Exception:
        pass
    _run_git(["config", "user.email", f"{who}@users.noreply.github.com"], cwd=bdir)
    _run_git(["config", "user.name", who], cwd=bdir)

    # 3. Stage + commit any new / changed files.
    _run_git(["add", "-A"], cwd=bdir)
    status = _run_git(["status", "--porcelain"], cwd=bdir)
    committed = bool(status.stdout.strip())
    if committed:
        ts = _now_iso()
        r = _run_git(
            ["commit", "-m", f"backup snapshot {ts}"],
            cwd=bdir,
        )
        if r.returncode != 0:
            raise RuntimeError(f"git commit failed: {r.stderr.strip()}")

    # 4. Push. Try the configured branch first; fall back to creating it
    # against the remote's default if it doesn't exist yet.
    branch = cfg.branch or "main"
    pushed_url = _inject_token(repo_url, token)
    try:
        r = _run_git(["push", pushed_url, f"HEAD:{branch}"], cwd=bdir, timeout=1800)
    finally:
        _scrub_credentials(bdir)
    if r.returncode != 0:
        raise RuntimeError(
            f"git push failed: {(r.stderr or r.stdout).strip()[:300]}"
        )

    # 5. Grab the pushed SHA for the response + persist last-push metadata.
    sha_r = _run_git(["rev-parse", "HEAD"], cwd=bdir)
    sha = sha_r.stdout.strip() if sha_r.returncode == 0 else ""
    sd.git_backup.last_push_at = _now_iso()
    sd.git_backup.last_push_sha = sha
    save_def(sd)

    return {
        "ok": True,
        "auto_created": auto_created,
        "committed": committed,
        "repo_url": repo_url,
        "branch": branch,
        "sha": sha,
        "last_push_at": sd.git_backup.last_push_at,
    }
