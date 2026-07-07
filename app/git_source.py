"""Git-source sync for server files.

Design:
  - Each server may declare a `git_source: {url, ref, subdir, world_subdir,
    token_env, exclude}` block. See app/registry.py.
  - The .git tree lives in a sibling cache directory (`<install_dir>.gitsrc/`),
    NOT inside install_dir itself, so the running game never has to look at
    .git files (or accidentally serve them).
  - "Sync" =
        clone-or-fetch → checkout ref → copy relevant subtree(s) into place.
    Copy is done with `rsync -a --delete-excluded` when available (fast +
    honours excludes cleanly). We fall back to a Python copytree when rsync
    isn't installed.
  - Auth: for HTTPS + PAT, we inject `x-access-token:<pat>@` into the URL at
    call time. The PAT itself is only ever read from an env var whose name
    the operator picked (`git_source.token_env`). Nothing sensitive gets
    written to disk.
  - Ready for local git servers (Gitea/Forgejo/GitLab) — the code has no
    github-specific behavior; anything git-flavored works.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from .registry import ServerDef, GitSourceCfg


# Recognized URL shapes: https://, http://, ssh://, or scp-style git@host:path.
_HTTPS_RE = re.compile(r"^https?://", re.IGNORECASE)
_SSH_URL_RE = re.compile(r"^(ssh://|[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:)")

# Default excludes: skip runtime data even if the repo accidentally contains it.
_DEFAULT_EXCLUDES = (
    ".git", ".github", "logs", "*.log",
    "world", "world_nether", "world_the_end",   # Minecraft worlds — live on TrueNAS
)


class GitError(RuntimeError):
    pass


# ---------- URL helpers ----------

def _validate_url(url: str) -> None:
    url = (url or "").strip()
    if not url:
        raise GitError("git_source.url is empty")
    # Refuse local file:// URLs — no reason to clone from disk paths and it's
    # the kind of thing that's usually a misconfiguration.
    if url.lower().startswith("file:"):
        raise GitError("file:// git URLs are not allowed")
    if not (_HTTPS_RE.match(url) or _SSH_URL_RE.match(url)):
        raise GitError(f"unsupported git URL shape: {url!r}")


def _url_with_token(url: str, token: str) -> str:
    """Inject `x-access-token:<PAT>@` into an HTTPS URL. SSH URLs unchanged."""
    if not token or not _HTTPS_RE.match(url):
        return url
    parts = urlsplit(url)
    # netloc without any existing userinfo — we replace it wholesale.
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    new_netloc = f"x-access-token:{token}@{host}"
    return urlunsplit((parts.scheme, new_netloc, parts.path, parts.query, parts.fragment))


def _resolve_token(cfg: GitSourceCfg, override: str | None = None) -> str:
    """Priority: explicit override (per-request PAT) > cfg.token_env > none."""
    if override:
        return override.strip()
    if not cfg.token_env:
        return ""
    val = os.environ.get(cfg.token_env, "").strip()
    if not val:
        # A configured token_env that's unset in /etc/gamesrv.env is a
        # misconfiguration; surface it clearly instead of silently trying an
        # unauthenticated clone (which will 404 on private repos).
        raise GitError(
            f"git_source.token_env={cfg.token_env!r} is not set in the environment"
        )
    return val


def _auth_hint(stderr: str, has_token: bool) -> str:
    """Turn git's cryptic 'terminal prompts disabled' into an actionable message."""
    stderr_lc = (stderr or "").lower()
    looks_authy = (
        "terminal prompts disabled" in stderr_lc
        or "could not read username" in stderr_lc
        or "authentication failed" in stderr_lc
        or "403" in stderr_lc
    )
    if not looks_authy:
        return _tail(stderr)
    if has_token:
        return (
            "Authentication rejected. Double-check the PAT (or the value in "
            "GAMESRV.env under token_env) — it may be expired, revoked, or "
            "lack Contents: Read access to this repo.\n\n"
            + _tail(stderr)
        )
    return (
        "This repository appears to be private and no token was supplied.\n"
        "Fix: on the Git tab, paste a fine-grained PAT into the "
        "\"PAT for this sync\" field (Contents: Read only, scoped to this "
        "repo). It is NOT persisted anywhere — you only need to re-enter "
        "it when the deployed SHA falls behind.\n"
        "Alternative: set the PAT in /etc/gamesrv.env under any name "
        "(e.g. MC_MODDED_DPR_GIT_PAT=...) and put that name in the "
        "\"Token env var name\" field.\n\n"
        + _tail(stderr)
    )


# ---------- subprocess wrapper ----------

def _run_git(cmd: list[str], *, cwd: Path | None = None, timeout: int = 300) -> subprocess.CompletedProcess:
    """Run a git command with a clean env. Returns the CompletedProcess so the
    caller can decide whether stderr should surface to the UI."""
    env = os.environ.copy()
    # Force non-interactive: no SSH keyboard prompts, no credential helper.
    env["GIT_TERMINAL_PROMPT"] = "0"
    env.setdefault("HOME", str(Path.home()))
    return subprocess.run(
        ["git", *cmd],
        cwd=str(cwd) if cwd else None,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _tail(text: str, n: int = 30) -> str:
    return "\n".join(text.splitlines()[-n:])


# ---------- paths ----------

def _cache_dir(sd: ServerDef) -> Path:
    """Sibling of install_dir, named `<install_dir>.gitsrc`. We keep the .git
    tree out of the runtime install dir on purpose."""
    p = Path(sd.install_dir).resolve()
    return p.parent / f"{p.name}.gitsrc"


# ---------- copy / sync ----------

def _rsync_available() -> bool:
    return shutil.which("rsync") is not None


def _rsync_copy(src: Path, dst: Path, excludes: list[str]) -> None:
    """rsync src/ contents into dst/, honouring excludes. `--delete-excluded`
    ONLY deletes files in dst that match an exclude pattern — it does NOT
    delete arbitrary user files, which matters because dst may contain hand
    uploads (server.jar, generated configs) not present in the repo."""
    dst.mkdir(parents=True, exist_ok=True)
    args = ["rsync", "-a", "--human-readable", "--delete-excluded"]
    for pat in excludes:
        args += ["--exclude", pat]
    # Trailing slash on src means "contents of", so dst gets the tree, not
    # a `src` subdir inside it.
    args += [str(src) + "/", str(dst) + "/"]
    r = subprocess.run(args, capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        raise GitError(f"rsync failed (exit {r.returncode}):\n{_tail(r.stderr)}")


def _py_copytree(src: Path, dst: Path, excludes: list[str]) -> None:
    """Fallback when rsync isn't installed. Same semantics: copy tree into dst,
    skip excluded paths. Not a delta transfer — every file is re-read."""
    from fnmatch import fnmatch

    def is_excluded(rel: str) -> bool:
        for pat in excludes:
            if fnmatch(rel, pat) or fnmatch(rel.split("/")[0], pat):
                return True
        return False

    dst.mkdir(parents=True, exist_ok=True)
    for root, dirs, files in os.walk(src):
        rel_root = Path(root).relative_to(src)
        # Prune excluded dirs in-place so os.walk skips descending into them.
        dirs[:] = [d for d in dirs if not is_excluded(str(rel_root / d))]
        (dst / rel_root).mkdir(parents=True, exist_ok=True)
        for fname in files:
            rel = str(rel_root / fname)
            if is_excluded(rel):
                continue
            shutil.copy2(src / rel_root / fname, dst / rel_root / fname)


# ---------- public API ----------

def sync(sd: ServerDef, *, dry_run: bool = False, token: str | None = None) -> dict:
    """Clone-or-fetch, checkout the requested ref, and copy the tree into
    install_dir (and optionally world_dir).

    A per-request `token` overrides cfg.token_env. It is used only for this
    call and never persisted to disk — the git remote URL is scrubbed after
    fetch to prevent it landing in .git/config.

    Returns a JSON-serialisable dict for the API response. Does NOT mutate
    the on-disk server def — callers who want to record the deployed SHA
    should call registry.save_def(sd) after updating sd.git_source.
    """
    cfg = sd.git_source
    _validate_url(cfg.url)

    cache = _cache_dir(sd)
    install_dir = Path(sd.install_dir).resolve()
    world_dir = Path(sd.world_dir).resolve()

    steps: list[str] = []
    resolved_token = _resolve_token(cfg, override=token)
    has_token = bool(resolved_token)
    auth_url = _url_with_token(cfg.url, resolved_token)

    # -- step 1: clone or fetch --
    if (cache / ".git").exists():
        steps.append(f"cache exists at {cache}, fetching...")
        r = _run_git(["remote", "set-url", "origin", auth_url], cwd=cache)
        if r.returncode != 0:
            raise GitError(f"git remote set-url failed:\n{_auth_hint(r.stderr, has_token)}")
        r = _run_git(["fetch", "--all", "--prune", "--tags"], cwd=cache)
        if r.returncode != 0:
            # Scrub the token URL out even on failure.
            _run_git(["remote", "set-url", "origin", cfg.url], cwd=cache)
            raise GitError(f"git fetch failed:\n{_auth_hint(r.stderr, has_token)}")
    else:
        cache.parent.mkdir(parents=True, exist_ok=True)
        if cache.exists():
            # Non-git leftover directory. Refuse to touch it silently.
            raise GitError(f"cache dir {cache} exists but is not a git repo; remove it manually")
        steps.append(f"cloning {cfg.url} into {cache}...")
        r = _run_git(["clone", "--no-checkout", auth_url, str(cache)], timeout=1800)
        if r.returncode != 0:
            # Clone leaves a partial dir; sweep it so the next attempt is a
            # clean clone rather than a "cache exists but no .git" refusal.
            if cache.exists() and not (cache / ".git").exists():
                shutil.rmtree(cache, ignore_errors=True)
            raise GitError(f"git clone failed:\n{_auth_hint(r.stderr, has_token)}")

    # After a fetch/clone, scrub the token out of the stored remote URL —
    # git leaves it in `.git/config` otherwise.
    if resolved_token:
        _run_git(["remote", "set-url", "origin", cfg.url], cwd=cache)

    # -- step 2: resolve ref --
    ref = (cfg.ref or "").strip()
    if not ref:
        # Detect the remote's default branch.
        r = _run_git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd=cache)
        if r.returncode == 0 and r.stdout.strip():
            ref = r.stdout.strip().rsplit("/", 1)[-1]
        else:
            # Fall back to whatever HEAD currently points at.
            r = _run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=cache)
            ref = (r.stdout or "").strip() or "HEAD"
    steps.append(f"using ref: {ref}")

    # -- step 3: checkout ref (detached is fine — we don't commit here) --
    r = _run_git(["checkout", "-f", "--detach", f"origin/{ref}"], cwd=cache)
    if r.returncode != 0:
        # Might be a tag or SHA rather than a branch.
        r = _run_git(["checkout", "-f", "--detach", ref], cwd=cache)
        if r.returncode != 0:
            raise GitError(f"git checkout {ref!r} failed:\n{_tail(r.stderr)}")

    # Grab the resolved SHA for reporting + storage.
    r = _run_git(["rev-parse", "HEAD"], cwd=cache)
    sha = (r.stdout or "").strip()
    steps.append(f"resolved to {sha[:12]}")

    if dry_run:
        return {
            "ok": True, "dry_run": True,
            "cache": str(cache), "ref": ref, "sha": sha, "steps": steps,
        }

    # -- step 4: copy subtree(s) into place --
    src_root = cache
    if cfg.subdir:
        sub = (cache / cfg.subdir).resolve()
        try:
            sub.relative_to(cache)
        except ValueError as e:
            raise GitError(f"subdir escapes repo: {cfg.subdir!r}") from e
        if not sub.exists():
            raise GitError(f"subdir {cfg.subdir!r} not found in repo")
        src_root = sub

    excludes = list(_DEFAULT_EXCLUDES) + list(cfg.exclude or [])
    # If world_subdir is set, exclude it from the install-dir copy — it'll be
    # copied into world_dir separately.
    if cfg.world_subdir:
        excludes.append(cfg.world_subdir)
        excludes.append(f"{cfg.world_subdir}/")

    install_dir.mkdir(parents=True, exist_ok=True)
    steps.append(f"syncing repo tree -> {install_dir} (excludes: {excludes})")
    if _rsync_available():
        _rsync_copy(src_root, install_dir, excludes)
    else:
        _py_copytree(src_root, install_dir, excludes)

    world_written = 0
    if cfg.world_subdir:
        wsrc = (cache / cfg.world_subdir).resolve()
        try:
            wsrc.relative_to(cache)
        except ValueError as e:
            raise GitError(f"world_subdir escapes repo: {cfg.world_subdir!r}") from e
        if wsrc.exists():
            world_dir.mkdir(parents=True, exist_ok=True)
            steps.append(f"syncing {cfg.world_subdir} -> {world_dir}")
            if _rsync_available():
                _rsync_copy(wsrc, world_dir, [".git"])
            else:
                _py_copytree(wsrc, world_dir, [".git"])
            world_written = 1
        else:
            steps.append(f"world_subdir {cfg.world_subdir!r} not present at this ref; skipping")

    return {
        "ok": True,
        "ref": ref,
        "sha": sha,
        "short_sha": sha[:12],
        "cache": str(cache),
        "install_dir": str(install_dir),
        "world_updated": world_written == 1,
        "steps": steps,
        "deployed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


def remote_head(sd: ServerDef, *, token: str | None = None) -> dict:
    """Ask the remote what its current head is for the configured ref, WITHOUT
    fetching everything. Used by the UI to show 'update available' hints."""
    cfg = sd.git_source
    _validate_url(cfg.url)
    resolved_token = _resolve_token(cfg, override=token)
    has_token = bool(resolved_token)
    auth_url = _url_with_token(cfg.url, resolved_token)

    ref = (cfg.ref or "HEAD").strip()
    r = _run_git(["ls-remote", auth_url, ref], timeout=60)
    if r.returncode != 0:
        return {"ok": False, "error": _auth_hint(r.stderr, has_token)}
    # ls-remote format: "<sha>\t<refname>". Take the first hit.
    first = (r.stdout.splitlines() or [""])[0].split("\t", 1)
    if not first or not first[0]:
        return {"ok": False, "error": f"ref {ref!r} not found on remote"}
    remote_sha = first[0].strip()
    return {
        "ok": True,
        "ref": ref,
        "remote_sha": remote_sha,
        "remote_short_sha": remote_sha[:12],
        "deployed_sha": cfg.deployed_sha,
        "deployed_short_sha": (cfg.deployed_sha or "")[:12],
        "update_available": bool(cfg.deployed_sha) and cfg.deployed_sha != remote_sha,
    }


def clear_cache(sd: ServerDef) -> dict:
    """Remove the .gitsrc cache. Next sync will do a fresh clone."""
    cache = _cache_dir(sd)
    if cache.exists():
        shutil.rmtree(cache)
        return {"ok": True, "removed": str(cache)}
    return {"ok": True, "message": "nothing to remove"}
