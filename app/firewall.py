"""UFW reconciler for per-server firewall rules.

Only manages rules tagged ``gamesrv-auto:<server>:*`` in the UFW comment.
Hand-added rules — including the initial LAN-lock set from
scripts/ufw-setup.sh — are left alone. Duplicate rules are harmless
because UFW's decision is the union of all allow rules.

Requires ``sudo -n /usr/sbin/ufw ...`` to work without a password. The
sudoers drop-in that grants this lives at /etc/sudoers.d/gamesrv-ufw and
is installed by bootstrap.sh.

Fails soft: if UFW isn't installed, or sudo denies, or a specific ufw
command errors, we log and continue. The def save always succeeds; a
firewall reconcile failure never blocks the manager.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import threading
from typing import Optional

from . import registry


# Same default the LAN-lock ufw-setup.sh uses. Overridable via env so
# operators on unusual LAN subnets don't need to edit code.
LAN_CIDR = os.environ.get("GAMESRV_LAN_CIDR", "10.0.0.0/24")

# Marker embedded in the UFW comment so we can find + delete our own
# rules without touching anything else. Kept short so it fits UFW's
# comment length limit (~50 chars including the port/proto label).
_COMMENT_PREFIX = "gamesrv-auto"

# Reconciles are cheap but not free (2-6 ufw invocations per server).
# Serialize them so a burst of saves doesn't race the numbered-rule
# indices that `ufw delete N` depends on.
_RECONCILE_LOCK = threading.Lock()


def _log(msg: str) -> None:
    print(f"[firewall] {msg}", file=sys.stderr, flush=True)


def _ufw_available() -> bool:
    return shutil.which("ufw") is not None


def _run_ufw(args: list[str], timeout: int = 10) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["sudo", "-n", "/usr/sbin/ufw", *args],
        capture_output=True, text=True, timeout=timeout,
    )


def _proto_for(sd) -> str:
    """Best-effort protocol for the server's primary port."""
    if sd.type in ("minecraft-java", "minecraft-forge"):
        return "tcp"
    return "udp"


def _extra_ports_for(sd) -> list[tuple[int, str, str]]:
    """Return additional (port, proto, tag) rules a game needs beyond its
    primary port. Satisfactory is the current case: game UDP + Server API
    TCP on the same port, plus a fixed TCP:8888 for reliable messaging
    (world/save streaming when players join).

    Kept as a table so adding another dual-protocol Steam game later is
    a one-line addition.
    """
    if sd.type == "steamcmd" and getattr(sd, "steam_app_id", None) == 1690800:
        # Satisfactory 1.0+:
        #   UDP <port>  — game traffic (primary; handled by _proto_for)
        #   TCP <port>  — HTTPS Server API (Server Manager uses this)
        #   TCP 8888    — Reliable messaging (save streaming during joins)
        return [
            (int(sd.port), "tcp", "satisfactory-api"),
            (8888, "tcp", "satisfactory-reliable"),
        ]
    return []


# `ufw status numbered` line examples we need to parse:
#   [ 3] 25565/tcp                  ALLOW IN    Anywhere       # gamesrv-auto:foo:public
#   [ 4] 25565/tcp (v6)             ALLOW IN    Anywhere (v6)  # gamesrv-auto:foo:public
#   [10] 25565/tcp                  ALLOW IN    10.0.0.0/24    # gamesrv-auto:foo:lan
_RULE_LINE = re.compile(r"^\[\s*(\d+)\]\s+.*?#\s*(\S.*)$")


def _current_managed_rules() -> list[tuple[int, str]]:
    """Return [(rule_num, comment), ...] for rules tagged by us."""
    r = _run_ufw(["status", "numbered"])
    if r.returncode != 0:
        return []
    out: list[tuple[int, str]] = []
    for line in r.stdout.splitlines():
        m = _RULE_LINE.match(line)
        if not m:
            continue
        num, comment = int(m.group(1)), m.group(2).strip()
        if comment.startswith(_COMMENT_PREFIX + ":"):
            out.append((num, comment))
    return out


def _delete_managed_for(server_name: str) -> None:
    """Remove every rule tagged ``gamesrv-auto:<server_name>:*``.

    UFW's numbered indices renumber after every delete, so we re-list
    between deletions rather than trusting the initial numbers.
    """
    prefix = f"{_COMMENT_PREFIX}:{server_name}:"
    # Cap iterations so a parse regression can't produce an infinite loop.
    for _ in range(64):
        managed = [
            (n, c) for n, c in _current_managed_rules()
            if c.startswith(prefix)
        ]
        if not managed:
            return
        # Delete highest number first so the indices we haven't touched
        # yet remain valid.
        managed.sort(reverse=True)
        num, _c = managed[0]
        r = _run_ufw(["--force", "delete", str(num)])
        if r.returncode != 0:
            _log(f"delete rule {num} for {server_name!r} failed: "
                 f"{(r.stderr or r.stdout).strip()[:120]}")
            return


def _add_rule(server_name: str, port: int, proto: str, source: Optional[str],
              tag: str) -> bool:
    """Add one allow rule. ``source=None`` means Anywhere."""
    comment = f"{_COMMENT_PREFIX}:{server_name}:{tag}"
    if source is None:
        args = ["allow", f"{port}/{proto}", "comment", comment]
    else:
        args = [
            "allow", "from", source, "to", "any",
            "port", str(port), "proto", proto,
            "comment", comment,
        ]
    r = _run_ufw(args)
    if r.returncode != 0:
        _log(f"add {source or 'Anywhere'} → {port}/{proto} for "
             f"{server_name!r} failed: {(r.stderr or r.stdout).strip()[:120]}")
        return False
    return True


def reconcile_server(sd) -> dict:
    """Reconcile UFW rules for one ServerDef.

    Returns a small status dict — never raises — so callers can surface
    the result without a try/except at every call site.
    """
    result = {
        "server": sd.name, "ok": False, "skipped": False, "rules_added": 0,
        "detail": "",
    }
    if not _ufw_available():
        result.update(ok=True, skipped=True, detail="ufw not installed")
        return result

    fw = getattr(sd, "firewall", None)
    mode = (fw.mode if fw else "lan").lower()
    allow_ips = list(fw.allow_ips) if (fw and fw.allow_ips) else []
    port = int(sd.port)
    proto = _proto_for(sd)
    extras = _extra_ports_for(sd)

    with _RECONCILE_LOCK:
        _delete_managed_for(sd.name)

        # Every port the game uses — primary first, then per-game extras
        # (Satisfactory needs TCP:port + TCP:8888 in addition to UDP:port).
        # All extras use the same mode/source rules as the primary.
        all_ports = [(port, proto, "primary")] + [(p, pr, t) for (p, pr, t) in extras]

        added = 0
        for (p, pr, t) in all_ports:
            if mode == "public":
                if _add_rule(sd.name, p, pr, None, f"public:{t}"):
                    added += 1
            elif mode == "allowlist":
                # LAN always included so the operator can't lock themselves out.
                if _add_rule(sd.name, p, pr, LAN_CIDR, f"lan:{t}"):
                    added += 1
                for ip in allow_ips:
                    if _add_rule(sd.name, p, pr, ip, f"allow:{t}:{ip}"):
                        added += 1
            else:  # "lan" — default
                if _add_rule(sd.name, p, pr, LAN_CIDR, f"lan:{t}"):
                    added += 1

    port_summary = f"{port}/{proto}"
    if extras:
        port_summary += "+" + ",".join(f"{p}/{pr}" for (p, pr, _) in extras)
    result.update(
        ok=True,
        rules_added=added,
        detail=f"mode={mode} ports={port_summary} rules={added}",
    )
    return result


def reconcile_all() -> list[dict]:
    """Reconcile every server's firewall. Called on manager startup."""
    if not _ufw_available():
        _log("ufw not installed; skipping startup reconcile")
        return []
    out = []
    for sd in registry.list_defs():
        try:
            out.append(reconcile_server(sd))
        except Exception as e:
            _log(f"reconcile {sd.name!r} raised: {type(e).__name__}: {e}")
            out.append({
                "server": sd.name, "ok": False, "skipped": False,
                "rules_added": 0, "detail": f"exception: {e}",
            })
    return out


def snapshot() -> dict:
    """Cheap read-only summary of managed rules for the /api/firewall endpoint."""
    result: dict = {
        "ufw_available": _ufw_available(),
        "lan_cidr": LAN_CIDR,
        "managed_rules": [],
    }
    if not _ufw_available():
        return result
    for num, comment in _current_managed_rules():
        result["managed_rules"].append({"rule": num, "comment": comment})
    return result
