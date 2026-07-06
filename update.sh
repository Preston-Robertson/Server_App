#!/usr/bin/env bash
# update.sh — self-update from GitHub, per plan §6.
#
# INTENDED INVOCATION: as root, via the dedicated oneshot unit
#   sudo systemctl start --no-block gamesrv-updater.service
# (the web UI's Admin → "Update Manager from GitHub" button does exactly that).
# The oneshot lives in its OWN cgroup, so restarting gamesrv-manager at the end
# does not kill this process. It runs as root, so no sudo dance is required.
#
# Also runnable directly for debugging:  sudo bash /opt/gamesrv/update.sh
#
# Safe / idempotent / reversible:
#   - Detects the repo's DEFAULT branch (fixes Bot Manager main-vs-master bug).
#   - Records rollback SHA before touching anything.
#   - Stashes local edits (warns if run_manager.sh changed under us).
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
LOG_FILE="${APP_DIR}/logs/update.log"

# --- mirror everything to update.log AS WELL AS this process's own stdout
# (which, under the oneshot, is the systemd journal). This is what the
# dashboard's "Refresh log" button reads.
mkdir -p "$(dirname "$LOG_FILE")"
exec > >(tee -a "$LOG_FILE") 2>&1

log() { echo "[$(date -Iseconds)] $*"; }
die() { log "FATAL: $*"; exit 1; }

log "=== update.sh started (uid=$(id -u) user=$(id -un)) ==="

cd "$APP_DIR" || die "app dir missing: $APP_DIR"

# --- preflight ---
command -v git >/dev/null || die "git not installed"
[[ -d "$APP_DIR/.git" ]] || die "$APP_DIR is not a git checkout"
[[ -x "$APP_DIR/.venv/bin/python" ]] || die "venv missing — run bootstrap.sh first"

# If /opt/gamesrv is owned by root (e.g. cloned by root before bootstrap
# ran), fix ownership so future manual `git` invocations by the operator as
# gamesrv work too. Idempotent.
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/.git" 2>/dev/null || true

# newer git refuses to operate on a repo owned by a different user
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

# List running game servers (informational — the manager restart does not
# affect them since they are separate units).
running="$(systemctl list-units --state=running 'gamesrv@*' --no-legend 2>/dev/null | awk '{print $1}' || true)"
if [[ -n "$running" ]]; then
  log "note: game servers currently running (manager restart won't affect them):"
  echo "$running" | sed 's/^/  - /'
fi

# --- record rollback point ---
SAVED_SHA="$(git -C "$APP_DIR" rev-parse HEAD)" || die "git rev-parse failed"
log "current SHA: $SAVED_SHA"

# --- detect default branch (fixes main-vs-master bug) ---
DEFAULT_BRANCH="$(git -C "$APP_DIR" remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p')"
[[ -n "$DEFAULT_BRANCH" ]] || die "could not detect default branch from origin"
log "default branch: $DEFAULT_BRANCH"

# --- stash local edits so pull doesn't fail on dirty tree ---
STASH=""
if ! git -C "$APP_DIR" diff --quiet || ! git -C "$APP_DIR" diff --cached --quiet; then
  log "stashing local edits..."
  git -C "$APP_DIR" stash push -u -m "pre-update-$(date +%s)" || die "stash failed"
  STASH="1"
fi

# --- fetch + fast-forward only ---
git -C "$APP_DIR" fetch origin --prune || die "git fetch failed"
git -C "$APP_DIR" checkout "$DEFAULT_BRANCH" || die "checkout $DEFAULT_BRANCH failed"

if ! git -C "$APP_DIR" pull --ff-only origin "$DEFAULT_BRANCH"; then
  log "ff-only pull failed (history diverged). Aborting — refusing to force-reset."
  [[ -n "$STASH" ]] && git -C "$APP_DIR" stash pop || true
  exit 2
fi

NEW_SHA="$(git -C "$APP_DIR" rev-parse HEAD)"
log "new SHA: $NEW_SHA"

if [[ "$SAVED_SHA" == "$NEW_SHA" ]]; then
  log "already up to date; nothing to do (still restarting manager to reload code from disk)"
fi

# --- warn if run_manager.sh changed (Bot Manager gotcha) ---
if git -C "$APP_DIR" diff --name-only "$SAVED_SHA" "$NEW_SHA" 2>/dev/null | grep -q '^run_manager.sh$'; then
  log "note: run_manager.sh changed — verify it still uses the venv interpreter"
fi

# --- reinstall requirements ---
log "installing requirements..."
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt" --upgrade || die "pip install failed"
"$APP_DIR/.venv/bin/python" -c "import fastapi, uvicorn, yaml, pydantic" \
  || die "post-install smoke test failed"

# Requirements/venv were touched as root; put them back under gamesrv.
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/.venv" 2>/dev/null || true
chmod +x "$APP_DIR/run_manager.sh" "$APP_DIR/update.sh" "$APP_DIR/bootstrap.sh" 2>/dev/null || true

# --- restart + health check ---
log "restarting $UNIT..."
if ! systemctl restart "$UNIT"; then
  log "systemctl restart failed"
fi

for i in $(seq 1 30); do
  sleep 1
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    log "health OK after ${i}s — update successful (SHA $NEW_SHA)"
    [[ -n "$STASH" ]] && log "reminder: local stash saved as 'pre-update-*' — inspect with 'git stash list'"
    exit 0
  fi
done

# --- rollback path ---
log "health check failed after 30s — rolling back to $SAVED_SHA"
git -C "$APP_DIR" reset --hard "$SAVED_SHA" || log "rollback git reset failed"
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt" || log "rollback pip install failed"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/.venv" 2>/dev/null || true
systemctl restart "$UNIT" || log "rollback restart failed"

for i in $(seq 1 20); do
  sleep 1
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    log "rollback OK — manager is back on $SAVED_SHA"
    exit 3
  fi
done

die "rollback also failed — manager is DOWN; check 'journalctl -u $UNIT -n 100'"
