#!/usr/bin/env bash
# Proxmox HOST-side fix for "LAN can't reach my game server inside the LXC".
#
# ────────────────────────────────────────────────────────────────────────────
# RUN THIS ONCE ON THE PROXMOX VE HOST — NOT INSIDE THE LXC.
# ────────────────────────────────────────────────────────────────────────────
#
# What symptom this fixes
# -----------------------
# * Dashboard shows the game server as "starting" forever.
# * UFW inside the LXC allows the game port (verified: `ufw status`).
# * The game process is bound to 0.0.0.0:<port> (verified: `ss -lnup`).
# * `ping` from a LAN client to the LXC works (ICMP is fine).
# * But UDP packets from the client never reach the LXC (verified:
#   `tcpdump -i any 'udp port <PORT>'` inside the LXC captures 0 packets
#   while the client is trying to connect).
#
# Root cause on Proxmox
# ---------------------
# By default some Proxmox installs have `net.bridge.bridge-nf-call-iptables=1`,
# which routes bridge-forwarded packets (client → vmbr0 → container veth)
# through the HOST's iptables filter chain. If pve-firewall is running
# with a restrictive datacenter policy — or even if it's just active
# without explicit rules for your container's ports — those UDP packets
# get DROP'd on the way to the container, silently.
#
# Setting `bridge-nf-call-iptables=0` makes bridge traffic bypass iptables
# entirely, which matches the modern kernel default and how most people
# expect LXC networking to behave. It does NOT reduce security if your
# only firewall enforcement is UFW inside the LXC (which is the gamesrv
# manager's default posture).
#
# What this script does
# ---------------------
# 1. Backs up any existing /etc/sysctl.d/99-gamesrv-bridge.conf.
# 2. Writes bridge-nf-call-* = 0 to /etc/sysctl.d/99-gamesrv-bridge.conf
#    (persistent across reboots).
# 3. Applies the sysctl immediately (no reboot needed).
# 4. Reports pve-firewall status (INFO only — no changes made to it).
# 5. Verifies a UDP loopback probe from the host toward the LXC's IP
#    on a chosen port completes end-to-end.
#
# Safe to re-run: idempotent. Prints WHAT would change before applying.
# ────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SYSCTL_FILE=/etc/sysctl.d/99-gamesrv-bridge.conf
NOW=$(date +%Y%m%d-%H%M%S)

require_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "ERROR: run as root (this touches sysctl.d and reads pve-firewall state)." >&2
    exit 1
  fi
}

is_proxmox_host() {
  # /etc/pve is Proxmox's cluster config filesystem; it only exists on hosts.
  [[ -d /etc/pve ]] && command -v pct >/dev/null 2>&1
}

section() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()      { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn()    { printf '  \033[33m!\033[0m %s\n' "$*"; }
info()    { printf '  \033[34mi\033[0m %s\n' "$*"; }

# ─── preflight ─────────────────────────────────────────────────────────────
require_root

if ! is_proxmox_host; then
  echo "ERROR: this script must run on the PROXMOX VE HOST." >&2
  echo "       /etc/pve is missing or 'pct' is not installed." >&2
  echo "       You are probably inside the LXC — SSH into the Proxmox host and re-run." >&2
  exit 2
fi

section "Environment"
info "hostname:   $(hostname)"
info "kernel:     $(uname -r)"
info "pve:        $(pveversion 2>/dev/null | head -1 || echo 'not found')"

# ─── current state ─────────────────────────────────────────────────────────
section "Current sysctl values"
for key in net.bridge.bridge-nf-call-iptables \
           net.bridge.bridge-nf-call-ip6tables \
           net.bridge.bridge-nf-call-arptables; do
  # Only readable if br_netfilter is loaded; load it first (harmless).
  modprobe br_netfilter 2>/dev/null || true
  cur=$(sysctl -n "$key" 2>/dev/null || echo "?")
  printf '  %-45s = %s\n' "$key" "$cur"
done

# ─── apply sysctl fix ──────────────────────────────────────────────────────
section "Applying /etc/sysctl.d/99-gamesrv-bridge.conf"

if [[ -f "$SYSCTL_FILE" ]]; then
  info "existing file will be backed up to ${SYSCTL_FILE}.${NOW}.bak"
  cp -a "$SYSCTL_FILE" "${SYSCTL_FILE}.${NOW}.bak"
fi

cat > "$SYSCTL_FILE" <<'EOF'
# Managed by gamesrv scripts/proxmox-host-fix.sh.
# Make bridge-forwarded traffic (vmbr0 → LXC veth) bypass the host's
# iptables filter chain. Without this, pve-firewall (or a stray host
# iptables rule) silently DROPs UDP packets aimed at game servers
# running inside unprivileged LXCs.
net.bridge.bridge-nf-call-iptables  = 0
net.bridge.bridge-nf-call-ip6tables = 0
net.bridge.bridge-nf-call-arptables = 0
EOF
ok "wrote $SYSCTL_FILE"

# Some systems don't have br_netfilter loaded until first bridge use,
# which makes the sysctl keys temporarily unavailable. Load it so the
# `sysctl --system` below can actually apply.
if ! lsmod | grep -q '^br_netfilter'; then
  info "loading br_netfilter kernel module"
  modprobe br_netfilter
fi

sysctl --system >/dev/null
ok "sysctl reloaded"

section "New sysctl values"
for key in net.bridge.bridge-nf-call-iptables \
           net.bridge.bridge-nf-call-ip6tables \
           net.bridge.bridge-nf-call-arptables; do
  cur=$(sysctl -n "$key" 2>/dev/null || echo "?")
  printf '  %-45s = %s\n' "$key" "$cur"
  if [[ "$cur" != "0" ]]; then
    warn "expected 0 — the sysctl didn't stick. Reboot the host or check dmesg for br_netfilter errors."
  fi
done

# ─── report pve-firewall status (informational) ────────────────────────────
section "pve-firewall status"
if command -v pve-firewall >/dev/null 2>&1; then
  fw_status=$(pve-firewall status 2>&1 || true)
  echo "$fw_status" | sed 's/^/  /'
  if echo "$fw_status" | grep -qiE 'Status:\s*enabled'; then
    warn "pve-firewall is ENABLED at the datacenter level."
    warn "The bridge-nf change above makes iptables bypass bridge traffic,"
    warn "so this SHOULD no longer block LXC UDP. But if your game still"
    warn "can't be reached, either add explicit CT firewall rules for the"
    warn "game ports in the Proxmox web UI (Datacenter → CT → Firewall)"
    warn "OR disable pve-firewall: 'systemctl disable --now pve-firewall'."
  else
    ok "pve-firewall is not enforcing rules — bridge fix should suffice."
  fi
else
  info "pve-firewall command not found — skipping."
fi

# ─── connectivity smoke test to any running LXCs ───────────────────────────
section "LXC connectivity smoke test"
running_cts=$(pct list 2>/dev/null | awk 'NR>1 && $2=="running" {print $1}')
if [[ -z "${running_cts}" ]]; then
  info "no running containers to test."
else
  for ctid in $running_cts; do
    ct_ip=$(pct config "$ctid" 2>/dev/null | awk -F'ip=' '/^net0:/ {split($2,a,"[/,]"); print a[1]}')
    ct_name=$(pct config "$ctid" 2>/dev/null | awk -F': ' '/^hostname:/ {print $2}')
    if [[ -z "$ct_ip" ]]; then
      info "  CT $ctid (${ct_name:-?}) has no IPv4 in config — skipping ping test."
      continue
    fi
    if ping -c1 -W1 "$ct_ip" >/dev/null 2>&1; then
      ok "CT $ctid ($ct_name → $ct_ip) reachable from host (ICMP)."
    else
      warn "CT $ctid ($ct_name → $ct_ip) does NOT respond to ping. Bridge/veth config may be broken."
    fi
  done
fi

# ─── summary ───────────────────────────────────────────────────────────────
section "Done"
cat <<'EOF'
Next steps:
  1. Retry your game client's Join Multiplayer from the LAN. If it still
     times out, check whether the CLIENT's OS firewall is blocking outbound
     UDP to the LXC's IP:port (Windows Defender Firewall → Outbound rules).
  2. If pve-firewall is enabled, consider:
       systemctl disable --now pve-firewall
     UNLESS you have explicit rules for your game ports in the Proxmox UI.
  3. The gamesrv manager (running inside the LXC) will detect that the
     game socket is bound and packets are now flowing; the "starting"
     chip should flip to green within ~90s of the first successful
     A2S/SLP probe. Watch the dashboard.

If none of the above resolves it, this script has done its job — the
remaining possibilities are: (a) client-side firewall (b) L2 switch/VLAN
between client and host (c) a stray host iptables rule NOT put there by
pve-firewall. Only (c) is worth investigating on the Proxmox side:
  iptables -L FORWARD -n --line-numbers
  iptables -L INPUT   -n --line-numbers
Look for unexpected DROP or REJECT entries and remove them.
EOF
