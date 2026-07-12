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
        # Satisfactory 1.0+ port layout, with the recipe's
        # ``-ServerQueryPort={port}`` flag pinning the API to the game port:
        #   UDP <port>   — game traffic (primary; handled by _proto_for)
        #   TCP <port>   — HTTPS Server API (pinned by -ServerQueryPort;
        #                  otherwise Unreal defaults to <port + 1>)
        #   TCP 8888     — Reliable messaging (FIXED, save streaming)
        #
        # Only ONE TCP port needs to be forwarded on the operator's router
        # in addition to 8888 — matches the operator's mental model of
        # "the port I typed into the server def".
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


def _delete_managed_for(server_name: str) -> list[str]:
    """Remove every rule tagged ``gamesrv-auto:<server_name>:*``.

    UFW's numbered indices renumber after every delete, so we re-list
    between deletions rather than trusting the initial numbers. Returns a
    list of error strings (empty on success) so reconcile can surface a ufw
    that's refusing writes.
    """
    prefix = f"{_COMMENT_PREFIX}:{server_name}:"
    errors: list[str] = []
    # Cap iterations so a parse regression can't produce an infinite loop.
    for _ in range(64):
        managed = [
            (n, c) for n, c in _current_managed_rules()
            if c.startswith(prefix)
        ]
        if not managed:
            return errors
        # Delete highest number first so the indices we haven't touched
        # yet remain valid.
        managed.sort(reverse=True)
        num, _c = managed[0]
        r = _run_ufw(["--force", "delete", str(num)])
        if r.returncode != 0:
            err = (r.stderr or r.stdout).strip()
            _log(f"delete rule {num} for {server_name!r} failed: {err[:200]}")
            errors.append(f"delete rule {num}: {err[:200]}")
            return errors
    return errors


def _add_rule(server_name: str, port: int, proto: str, source: Optional[str],
              tag: str) -> tuple[bool, str]:
    """Add one allow rule. ``source=None`` means Anywhere.

    Returns ``(ok, error)`` — ``error`` is the ufw stderr/stdout on failure
    (empty on success) so reconcile can tell the operator EXACTLY why a rule
    didn't land. The classic case is ufw being unable to write iptables inside
    an unprivileged LXC ("ERROR: Could not load logging rules" / iptables
    permission), which silently left the port on its old rule.
    """
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
        err = (r.stderr or r.stdout).strip()
        _log(f"add {source or 'Anywhere'} → {port}/{proto} for "
             f"{server_name!r} failed: {err[:200]}")
        return False, f"{source or 'Anywhere'}→{port}/{proto}: {err[:200]}"
    return True, ""


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
        del_errors = _delete_managed_for(sd.name)

        # Every port the game uses — primary first, then per-game extras
        # (Satisfactory needs TCP:port + TCP:8888 in addition to UDP:port).
        # All extras use the same mode/source rules as the primary.
        all_ports = [(port, proto, "primary")] + [(p, pr, t) for (p, pr, t) in extras]

        added = 0
        failed = 0
        errors: list[str] = list(del_errors)
        for (p, pr, t) in all_ports:
            if mode == "public":
                targets = [(None, f"public:{t}")]
            elif mode == "allowlist":
                # LAN always included so the operator can't lock themselves out.
                targets = [(LAN_CIDR, f"lan:{t}")] + [(ip, f"allow:{t}:{ip}") for ip in allow_ips]
            else:  # "lan" — default
                targets = [(LAN_CIDR, f"lan:{t}")]
            for (src, tag) in targets:
                ok_add, err = _add_rule(sd.name, p, pr, src, tag)
                if ok_add:
                    added += 1
                else:
                    failed += 1
                    if err:
                        errors.append(err)

    port_summary = f"{port}/{proto}"
    if extras:
        port_summary += "+" + ",".join(f"{p}/{pr}" for (p, pr, _) in extras)
    ok = (failed == 0 and not del_errors)
    detail = f"mode={mode} ports={port_summary} rules={added}"
    if failed or del_errors:
        # Surface the actual ufw error so "I set public but it stayed LAN" is
        # explained by ufw's own message instead of a silent success.
        detail += f" | {failed} rule(s) FAILED: " + "; ".join(errors)[:400]
    result.update(
        ok=ok,
        rules_added=added,
        rules_failed=failed,
        errors=errors,
        detail=detail,
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


def port_allowed(port: int, proto: str) -> Optional[bool]:
    """Best-effort: does the LXC's OWN ufw permit ``<port>/<proto>`` inbound?

    This is what the network diagnostic must check BEFORE ever pointing the
    operator at the Proxmox host: an "unreachable" game whose port the
    container's own firewall is dropping is a MANAGER-side problem we can
    fix (reconcile), not a host one.

    Returns:
      * ``True``  — ufw is active AND an ALLOW rule matches the port
                    (either ``<port>/<proto>`` or a bare ``<port>``).
      * ``False`` — ufw is active/enabled but NO allow rule matches — the
                    container firewall itself is the block.
      * ``None``  — can't tell: ufw not installed, status unreadable, or
                    ufw inactive (so it isn't filtering anything at all).
    """
    if not _ufw_available():
        return None
    try:
        r = _run_ufw(["status"])
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    text = r.stdout or ""
    # ufw inactive => it filters nothing => it cannot be the block.
    if re.search(r"^Status:\s+inactive", text, re.IGNORECASE | re.MULTILINE):
        return None
    port_s = str(int(port))
    for line in text.splitlines():
        up = line.upper()
        if "ALLOW" not in up or "DENY" in up or "REJECT" in up:
            continue
        # The "To" column (everything left of ALLOW) holds the port spec,
        # e.g. "8211/udp", "8211", "8211/tcp (v6)", "25565".
        left = up.split("ALLOW", 1)[0]
        m = re.search(r"(?<![\d.])" + re.escape(port_s) + r"(?:/(TCP|UDP))?(?![\d.])", left)
        if m:
            rule_proto = m.group(1)
            if rule_proto is None or rule_proto.lower() == proto.lower():
                return True
    return False


def port_public_allowed(port: int, proto: str) -> Optional[bool]:
    """Does ufw allow ``<port>/<proto>`` inbound from ANYWHERE (public), as
    opposed to only a restricted source (the LAN CIDR)?

    This is the check that matters for "my friends can't join over the internet
    even though I forwarded the port": a game whose LXC ufw rule is
    ``ALLOW ... from 10.0.0.0/24`` (firewall mode ``lan`` — the DEFAULT) accepts
    LAN players but silently DROPS every public client, regardless of the
    router's port forward. ``port_allowed`` can't see this — it matches the port
    without inspecting the source column — so it returns True for a LAN-only
    rule. This one inspects the source.

    Returns:
      * ``True``  — an ALLOW rule for the port exists with source ``Anywhere``
                    (public-reachable as far as this container's firewall goes).
      * ``False`` — ufw is active but no ``Anywhere`` rule matches the port:
                    either it's LAN-restricted or not allowed at all, so public
                    clients are dropped BY THIS CONTAINER's ufw.
      * ``None``  — can't tell: ufw not installed, unreadable, or inactive.
    """
    if not _ufw_available():
        return None
    try:
        r = _run_ufw(["status"])
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    text = r.stdout or ""
    if re.search(r"^Status:\s+inactive", text, re.IGNORECASE | re.MULTILINE):
        return None
    port_s = str(int(port))
    for line in text.splitlines():
        up = line.upper()
        if "ALLOW" not in up or "DENY" in up or "REJECT" in up:
            continue
        left, right = up.split("ALLOW", 1)
        m = re.search(r"(?<![\d.])" + re.escape(port_s) + r"(?:/(TCP|UDP))?(?![\d.])", left)
        if not m:
            continue
        rule_proto = m.group(1)
        if rule_proto is not None and rule_proto.lower() != proto.lower():
            continue
        # Source column (right of ALLOW). Public rules read "Anywhere" (v4) /
        # "Anywhere (V6)"; LAN rules read the CIDR, e.g. 10.0.0.0/24.
        if "ANYWHERE" in right:
            return True
    return False
