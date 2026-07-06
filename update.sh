#!/usr/bin/env bash
# update.sh — self-update from GitHub, per plan §6.
#
# Runs as root (systemd manager launches us with sudo/detached), because we
# need to `systemctl restart gamesrv-manager.service` at the end. Everything
# git/pip-related is done as the `gamesrv` user.
#
# Safe / idempotent / reversible:
#   - Detects the repo's DEFAULT branch (fixes Bot Manager main-vs-master bug).
#   - Records rollback SHA before touching anything.
#   - Stashes local edits (and warns if run_manager.sh changed under us).
#   - Pull is fast-forward only. Divergence aborts — never force-reset.
#   - Reinstalls requirements into the venv and smoke-tests imports.
#   - Restarts manager, polls /healthz. On failure, rolls back to saved SHA
#     and reinstalls that SHA's requirements.
set -uo pipefail

APP_DIR="${GAMESRV_APP_DIR:-/opt/gamesrv}"
SERVICE_USER="${SERVICE_USER:-gamesrv}"
UNIT="gamesrv-manager.service"
PORT="${GAMESRV_PORT:-8765}"
HEALTH_URL="http://127.0.0.1:${PORT}/healthz"

log() { echo "[$(date -Iseconds)] $*"; }
die() { log "FATAL: $*"; exit 1; }

cd "$APP_DIR" || die "app dir missing: $APP_DIR"

# --- preflight ---
command -v git >/dev/null || die "git not installed"
[[ -d "$APP_DIR/.git" ]] || die "$APP_DIR is not a git checkout"
[[ -x "$APP_DIR/.venv/bin/python" ]] || die "venv missing — run bootstrap.sh first"

# List any running game servers (informational — do NOT block; operator's call).
running="$(systemctl list-units --state=running 'gamesrv@*' --no-legend | awk '{print $1}' || true)"
if [[ -n "$running" ]]; then
  log "note: game servers currently running (manager restart won't stop them, but be aware):"
  echo "$running" | sed 's/^/  - /'
fi

# --- record rollback point ---
SAVED_SHA="$(sudo -u "$SERVICE_USER" git -C "$APP_DIR" rev-parse HEAD)"
log "current SHA: $SAVED_SHA"

# --- detect default branch (fixes main-vs-master bug) ---
DEFAULT_BRANCH="$(sudo -u "$SERVICE_USER" git -C "$APP_DIR" remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p')"
[[ -n "$DEFAULT_BRANCH" ]] || die "could not detect default branch from origin"
log "default branch: $DEFAULT_BRANCH"

# --- stash local edits so pull doesn't fail on dirty tree ---
STASH=""
if ! sudo -u "$SERVICE_USER" git -C "$APP_DIR" diff --quiet || \
   ! sudo -u "$SERVICE_USER" git -C "$APP_DIR" diff --cached --quiet; then
  log "stashing local edits..."
  sudo -u "$SERVICE_USER" git -C "$APP_DIR" stash push -u -m "pre-update-$(date +%s)" || die "stash failed"
  STASH="1"
fi

# --- fetch + fast-forward only ---
sudo -u "$SERVICE_USER" git -C "$APP_DIR" fetch origin --prune || die "git fetch failed"
sudo -u "$SERVICE_USER" git -C "$APP_DIR" checkout "$DEFAULT_BRANCH" || die "checkout $DEFAULT_BRANCH failed"

if ! sudo -u "$SERVICE_USER" git -C "$APP_DIR" pull --ff-only origin "$DEFAULT_BRANCH"; then
  log "ff-only pull failed (history diverged). Aborting — refusing to force-reset."
  [[ -n "$STASH" ]] && sudo -u "$SERVICE_USER" git -C "$APP_DIR" stash pop || true
  exit 2
fi

NEW_SHA="$(sudo -u "$SERVICE_USER" git -C "$APP_DIR" rev-parse HEAD)"
log "new SHA: $NEW_SHA"

if [[ "$SAVED_SHA" == "$NEW_SHA" ]]; then
  log "already up to date; nothing to do"
  [[ -n "$STASH" ]] && sudo -u "$SERVICE_USER" git -C "$APP_DIR" stash pop || true
  exit 0
fi

# --- warn if run_manager.sh changed (Bot Manager gotcha) ---
if sudo -u "$SERVICE_USER" git -C "$APP_DIR" diff --name-only "$SAVED_SHA" "$NEW_SHA" | grep -q '^run_manager.sh$'; then
  log "note: run_manager.sh changed — make sure it still uses the venv interpreter"
fi

# --- reinstall requirements ---
log "installing requirements..."
sudo -u "$SERVICE_USER" "$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt" --upgrade || die "pip install failed"
sudo -u "$SERVICE_USER" "$APP_DIR/.venv/bin/python" -c "import fastapi, uvicorn, yaml, pydantic" \
  || die "post-install smoke test failed"

chmod +x "$APP_DIR/run_manager.sh" "$APP_DIR/update.sh" "$APP_DIR/bootstrap.sh" 2>/dev/null || true

# --- restart + health check ---
log "restarting $UNIT..."
systemctl restart "$UNIT" || { log "systemctl restart failed"; ROLLBACK=1; }

for i in $(seq 1 20); do
  sleep 1
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    log "health OK after ${i}s — update successful (SHA $NEW_SHA)"
    [[ -n "$STASH" ]] && log "reminder: local stash saved as 'pre-update-*' — inspect with 'git stash list'"
    exit 0
  fi
done

# --- rollback path ---
log "health check failed — rolling back to $SAVED_SHA"
sudo -u "$SERVICE_USER" git -C "$APP_DIR" reset --hard "$SAVED_SHA" || log "rollback git reset failed"
sudo -u "$SERVICE_USER" "$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt" || log "rollback pip install failed"
systemctl restart "$UNIT" || log "rollback restart failed"
sleep 3
if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
  log "rollback OK — manager is back on $SAVED_SHA"
  exit 3
fi
die "rollback also failed — manager is DOWN; check 'journalctl -u $UNIT -n 100'"
