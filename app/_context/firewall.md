# app/_context/firewall.md
# Context summary for app/firewall.py (291 lines).

## Purpose
UFW rule reconciler: manages per-server firewall rules tagged `gamesrv-auto:<server>:*` in the UFW comment field. Adds/removes rules based on each server's `firewall:` block without touching hand-added rules from `scripts/ufw-setup.sh`.

## Public API
- `reconcile_server(sd)` → `dict` (`{server, ok, skipped, rules_added, detail}`) — never raises
- `reconcile_all()` → `list[dict]` — called on manager startup
- `snapshot()` → `dict` (`{ufw_available, lan_cidr, managed_rules}`) — read-only summary
- `port_allowed(port, proto)` → `Optional[bool]` — True/False/None diagnostic

## Called by
`app/main.py` (`_startup()` calls `reconcile_all()`; `/api/firewall` endpoint calls `snapshot()` and `reconcile_server()`).

## Calls / depends on
`app.registry` (`list_defs()`), `subprocess` (`sudo -n /usr/sbin/ufw`), `os` (`GAMESRV_LAN_CIDR` env), `re`, `threading`.

## Key invariants / gotchas
- **Requires sudoers drop-in**: needs `gamesrv ALL=(ALL) NOPASSWD: /usr/sbin/ufw` in `/etc/sudoers.d/gamesrv-ufw`. Installed by `bootstrap.sh`.
- **Fails soft**: if UFW isn't installed or sudo is denied, logs to stderr and returns `{ok: True, skipped: True}`. Manager startup is never aborted.
- **Comment tagging**: all managed rules have comments starting with `gamesrv-auto:<server>:`. Delete-by-comment walks `ufw status numbered` and deletes highest-numbered rule first (to avoid index renumbering issues).
- **`_RECONCILE_LOCK`**: serializes reconcile calls so burst saves don't race numbered-rule indices.
- **`LAN_CIDR`**: defaults to `10.0.0.0/24`, overridable via `GAMESRV_LAN_CIDR` env var.
- **Satisfactory special case**: `_extra_ports_for()` adds `TCP:<port>` (Server API) + `TCP:8888` (reliable messaging) for app ID 1690800.
- **Firewall modes**: `"lan"` (LAN CIDR only), `"public"` (anywhere), `"allowlist"` (LAN + per-IP list). Default: `"lan"`.

## Common failure modes
- Reconcile silently skipped: UFW not installed (e.g. dev environment). Check `ufw_available` in snapshot.
- `port_allowed()` returns None: UFW inactive or not installed — not the blocking cause.
- Rule deletion loop caps at 64 iterations to prevent an infinite loop on a parse regression.
- Rules duplicated: reconcile always deletes all managed rules for a server before re-adding. Transient between delete and add.

## Where to change what
- Add a new game's extra ports: extend `_extra_ports_for()` with the new Steam app ID and port list.
- Change default LAN subnet: `LAN_CIDR` module variable or `GAMESRV_LAN_CIDR` env var.
- Change firewall modes: `_add_rule()` branches in `reconcile_server()`.
