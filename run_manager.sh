#!/usr/bin/env bash
# run_manager.sh — venv launcher used by gamesrv-manager.service
# This mirrors the Bot Manager B7 fix: ALWAYS use the venv interpreter,
# never bare python3, to avoid ModuleNotFoundError under systemd.
set -euo pipefail

APP_DIR="${GAMESRV_APP_DIR:-/opt/gamesrv}"
cd "$APP_DIR"

if [[ ! -x "$APP_DIR/.venv/bin/python" ]]; then
  echo "FATAL: venv missing at $APP_DIR/.venv — run ./bootstrap.sh first" >&2
  exit 1
fi

exec "$APP_DIR/.venv/bin/python" -m uvicorn app.main:app \
  --host "${GAMESRV_HOST:-0.0.0.0}" \
  --port "${GAMESRV_PORT:-8765}" \
  --no-access-log
