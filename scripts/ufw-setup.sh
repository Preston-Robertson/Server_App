#!/usr/bin/env bash
# UFW LAN-lock. Adjust LAN_CIDR / MANAGER_PORT / GAME_PORTS as needed.
# Idempotent — safe to re-run.
set -euo pipefail

LAN_CIDR="${LAN_CIDR:-10.0.0.0/24}"
MANAGER_PORT="${MANAGER_PORT:-8765}"
# Space-separated list. Add game ports here or via `sudo ufw allow ...` later.
GAME_PORTS="${GAME_PORTS:-25565/tcp 8211/udp 27015/udp}"   # Minecraft, Palworld, Palworld query

if ! command -v ufw >/dev/null; then
  echo "installing ufw..."
  apt-get update -y
  apt-get install -y ufw
fi

ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing

# SSH from LAN only.
ufw allow from "$LAN_CIDR" to any port 22 proto tcp

# Manager web UI from LAN only.
ufw allow from "$LAN_CIDR" to any port "$MANAGER_PORT" proto tcp

# Game ports from LAN only.
for p in $GAME_PORTS; do
  port="${p%/*}"
  proto="${p#*/}"
  ufw allow from "$LAN_CIDR" to any port "$port" proto "$proto"
done

ufw --force enable
ufw status verbose
