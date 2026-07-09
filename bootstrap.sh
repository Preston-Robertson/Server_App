#!/usr/bin/env bash
# bootstrap.sh — first-time (and repair) setup, per plan §6f.
#
# Idempotent. Safe to re-run. Run as root on the LXC:
#   sudo bash /opt/gamesrv/bootstrap.sh
#   sudo bash /opt/gamesrv/bootstrap.sh --with-wine   # for Enshrouded / other Windows-only servers
#
# What it does:
#   1. Creates the `gamesrv` service user + group.
#   2. Creates required dirs and fixes ownership.
#   3. Installs required system packages (python venv, git, tmux, java, steamcmd).
#      With --with-wine: also installs wine-staging (~1 GB extra) for
#      Windows-only dedicated servers such as Enshrouded.
#   4. Builds the Python venv and installs requirements.
#   5. Installs the systemd manager unit + template unit, enables the manager.
#   6. Installs the polkit rule that lets `gamesrv` control `gamesrv@*` units.
#   7. Copies .env.example -> /etc/gamesrv.env (once, mode 640) if missing.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/gamesrv}"
INSTALL_ROOT="${INSTALL_ROOT:-/srv/gameservers}"
WORLDS_ROOT="${WORLDS_ROOT:-/opt/gamesrv/worlds}"
SERVICE_USER="${SERVICE_USER:-gamesrv}"
WITH_WINE=0
for arg in "$@"; do
  case "$arg" in
    --with-wine) WITH_WINE=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "must run as root (sudo)" >&2
  exit 1
fi

echo "== 1. user =="
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  # Shell must be a real shell (not nologin) so tmux can exec commands
  # inside sessions. gamesrv has no password and no SSH keys, so the
  # anti-interactive-login benefit of nologin is negligible; the tmux
  # breakage is not. See: journalctl "Attempted login by UNKNOWN".
  useradd --system --create-home --shell /bin/bash "$SERVICE_USER"
fi
# Idempotent: if the account was created earlier with nologin, fix it now.
current_shell="$(getent passwd "$SERVICE_USER" | cut -d: -f7)"
if [[ "$current_shell" != "/bin/bash" ]]; then
  usermod --shell /bin/bash "$SERVICE_USER"
fi
# Add gamesrv to systemd-journal so it can read `journalctl -u gamesrv@*` for
# the per-server Logs and Console tabs. Without this the manager can invoke
# journalctl but gets back an empty result / "not seeing messages" hint,
# which the UI surfaces as "no output". Idempotent — usermod -aG doesn't
# duplicate existing memberships. Takes effect at next service start.
if getent group systemd-journal >/dev/null 2>&1; then
  usermod -aG systemd-journal "$SERVICE_USER"
fi

echo "== 2. dirs =="
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$APP_DIR" "$APP_DIR/logs" "$APP_DIR/servers" "$WORLDS_ROOT" "$INSTALL_ROOT"
# Whole repo tree needs to be gamesrv-owned so `git fetch/pull` (from either
# the updater oneshot or a manual `sudo -u gamesrv git` invocation) can write
# to .git/. If you cloned the repo as root, this is where the ownership gets
# fixed. Safe to re-run.
if [[ -d "$APP_DIR/.git" ]]; then
  chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
  # Newer git refuses to touch a repo it thinks is "dubious ownership".
  git config --system --add safe.directory "$APP_DIR" 2>/dev/null || true
  # Some filesystems (or a bootstrap `chmod +x` on tree-recorded 100644 files)
  # cause git to see spurious executable-bit "modifications" that then block
  # `git pull --ff-only`. Disable file-mode tracking on this repo so those
  # never dirty the working tree.
  sudo -u "$SERVICE_USER" git -C "$APP_DIR" config core.fileMode false || true
else
  chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/logs" "$APP_DIR/servers"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$WORLDS_ROOT" "$INSTALL_ROOT"

echo "== 3. system packages =="
# Palworld/steamcmd needs i386 libs. Accept steam license non-interactively.
dpkg --add-architecture i386 || true
apt-get update -y
echo 'steam steam/question select I AGREE' | debconf-set-selections
echo 'steam steam/license note ""' | debconf-set-selections
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  git curl ca-certificates rsync \
  python3 python3-venv python3-pip \
  tmux ufw \
  openjdk-17-jre-headless \
  lib32gcc-s1 \
  || true
# steamcmd is in non-free/contrib — try both names.
DEBIAN_FRONTEND=noninteractive apt-get install -y steamcmd || \
  DEBIAN_FRONTEND=noninteractive apt-get install -y steamcmd-jessie || \
  echo "WARNING: steamcmd not installed automatically — install manually if you need SteamCMD servers."

if [[ "$WITH_WINE" -eq 1 ]]; then
  echo "== 3b. wine (--with-wine) =="
  # Debian 12's shipped Wine is often too old for current-year games. Use
  # WineHQ's Debian repo so we get wine-staging (which pulls in the fixes
  # Enshrouded / newer Windows-only servers need). Adds ~1 GB.
  install -d -m 0755 /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/winehq-archive.key ]]; then
    curl -fsSL https://dl.winehq.org/wine-builds/winehq.key \
      | gpg --dearmor -o /etc/apt/keyrings/winehq-archive.key
  fi
  # Bookworm = Debian 12. Adjust here if you're on trixie/sid.
  cat > /etc/apt/sources.list.d/winehq.sources <<'EOF'
Types: deb
URIs: https://dl.winehq.org/wine-builds/debian/
Suites: bookworm
Components: main
Architectures: amd64 i386
Signed-By: /etc/apt/keyrings/winehq-archive.key
EOF
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y --install-recommends winehq-staging \
    || DEBIAN_FRONTEND=noninteractive apt-get install -y wine-staging wine \
    || echo "WARNING: wine install failed — see winehq.org for manual instructions."
  # Verify.
  if command -v wine >/dev/null; then
    wine --version || true
  else
    echo "WARNING: wine binary not on PATH after install."
  fi
fi

echo "== 4. venv + requirements =="
if [[ ! -x "$APP_DIR/.venv/bin/python" ]]; then
  sudo -u "$SERVICE_USER" python3 -m venv "$APP_DIR/.venv"
fi
sudo -u "$SERVICE_USER" "$APP_DIR/.venv/bin/pip" install --upgrade pip
sudo -u "$SERVICE_USER" "$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt" --upgrade
# Smoke-test imports (Bot Manager B6 pattern).
sudo -u "$SERVICE_USER" "$APP_DIR/.venv/bin/python" -c "import fastapi, uvicorn, yaml, pydantic; print('deps OK')"

chmod +x "$APP_DIR/run_manager.sh" "$APP_DIR/update.sh" "$APP_DIR/bootstrap.sh" 2>/dev/null || true

echo "== 5. systemd units =="
install -m 0644 "$APP_DIR/systemd/gamesrv-manager.service" /etc/systemd/system/gamesrv-manager.service
install -m 0644 "$APP_DIR/systemd/gamesrv@.service"          /etc/systemd/system/gamesrv@.service
install -m 0644 "$APP_DIR/systemd/gamesrv-updater.service"   /etc/systemd/system/gamesrv-updater.service
systemctl daemon-reload

echo "== 6. polkit =="
install -m 0644 "$APP_DIR/scripts/49-gamesrv.rules" /etc/polkit-1/rules.d/49-gamesrv.rules
systemctl restart polkit || true

echo "== 6b. sudoers (ufw for gamesrv) =="
# Lets the manager reconcile per-server UFW rules from the dashboard
# without a password prompt. Scoped to /usr/sbin/ufw only — no other
# root commands are granted. Owned root:root, mode 0440 as sudoers
# requires; visudo -c validates the file before install.
_SUDOERS_TMP="$(mktemp)"
cat > "$_SUDOERS_TMP" <<EOF
# Managed by gamesrv bootstrap.sh — do not hand-edit.
# Grants the manager (running as ${SERVICE_USER}) permission to run
# only /usr/sbin/ufw without a password. Required for the per-server
# firewall UI in the dashboard.
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ufw
EOF
if visudo -cf "$_SUDOERS_TMP" >/dev/null; then
  install -m 0440 -o root -g root "$_SUDOERS_TMP" /etc/sudoers.d/gamesrv-ufw
else
  echo "!! sudoers snippet failed visudo -c; NOT installed. Firewall UI will fail." >&2
fi
rm -f "$_SUDOERS_TMP"

echo "== 7. env file =="
if [[ ! -f /etc/gamesrv.env ]]; then
  # Mode 660 root:gamesrv so the manager can WRITE it too (Admin env editor).
  install -o root -g "$SERVICE_USER" -m 0660 "$APP_DIR/.env.example" /etc/gamesrv.env
  # Generate a token so first boot works.
  TOK="$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')"
  sed -i "s|^GAMESRV_TOKEN=.*|GAMESRV_TOKEN=${TOK}|" /etc/gamesrv.env
  echo "Generated /etc/gamesrv.env with a random token:"
  echo "  GAMESRV_TOKEN=${TOK}"
  echo "Save that — you'll paste it into the web UI."
else
  # Existing env file: nudge the mode to 660 so the Admin editor can save.
  chgrp "$SERVICE_USER" /etc/gamesrv.env 2>/dev/null || true
  chmod 0660           /etc/gamesrv.env 2>/dev/null || true
  echo "/etc/gamesrv.env already exists; mode nudged to 660 root:$SERVICE_USER for editability."
fi

systemctl enable gamesrv-manager.service
systemctl restart gamesrv-manager.service
sleep 2
systemctl --no-pager --full status gamesrv-manager.service || true

echo
echo "== done =="
echo "Manager URL:  http://$(hostname -I | awk '{print $1}'):${GAMESRV_PORT:-8765}/"
echo "Token:        cat /etc/gamesrv.env | grep GAMESRV_TOKEN"
echo "Next:         run scripts/ufw-setup.sh (as root) to LAN-lock."
