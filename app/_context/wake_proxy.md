# app/_context/wake_proxy.md
# Context summary for app/wake_proxy.py (1119 lines). Read this BEFORE opening the file.

## Purpose
Wake-on-demand TCP/UDP proxy: for each server def with `wake_on_demand: true`, owns the public-facing port and wakes the game process on first incoming player packet. When the game is stopped, buffers packets and starts it; when running, acts as a transparent NAT relay.

## Public API
- `wake_proxy = WakeProxy()` — singleton at module level
- `wake_proxy.start()` → None (called from `main.py` startup hook; spawns main proxy loop thread)
- `wake_proxy.stop()` → None
- `wake_proxy.status()` → `list[dict]` (per-proxy state snapshot for `/api/wake` endpoint)
- `WAKE_INTERNAL_OFFSET = 10000` — public constant; game binds `port + 10000` when wake is enabled

## Called by
`app/main.py` (`_startup()` calls `wake_proxy.start()`; wake status endpoint calls `wake_proxy.status()`).

## Calls / depends on
`app.control` (status checks, `control.start()`), `app.registry` (list/load defs), `app.watchdog` (`probe_a2s`, `probe_mc_slp`), `socket`, `select`, `threading`.

## Key invariants / gotchas
- **Protocol split**: UDP for Steam-based games (Palworld, ARK, Satisfactory, Enshrouded); TCP for Minecraft (java/forge). Determined by `sd.type`.
- **UDP promotion**: trusts `systemctl active` (not A2S probe) because some games (Satisfactory) never reply to A2S — insisting on a probe would keep all UDP traffic buffered forever.
- **TCP promotion**: requires a successful SLP probe on the internal port before splicing the client socket — avoids ECONNREFUSED during JVM startup.
- **Satisfactory dual-port**: game traffic is UDP but the Server API is TCP on the same port. `WakeProxy` opens a secondary TCP listener for this.
- **Minecraft whitelist**: if `wake_whitelist` is non-empty, the proxy peeks at the Login Start packet's username field; non-listed users get a disconnect instead of a wake.
- **Packet buffer cap**: `_MAX_BUFFERED_PACKETS = 500` per server. Oldest packet dropped when full.
- **`_CLIENT_IDLE_TIMEOUT_SEC = 300`**: outbound UDP sockets closed after 5 min of no traffic.
- The proxy thread runs as a daemon; manager shutdown kills it without explicit cleanup.

## Common failure modes
- **Port bind fails on startup**: another process (or prior proxy instance) holds the port. Logged to stderr; that server's proxy is skipped.
- **Wake timeout**: game didn't become ready within `wake_timeout_sec` (default 90 s, configurable per server). TCP clients receive a Minecraft disconnect packet with a friendly message. UDP clients' buffered packets are dropped.
- **UDP client stuck on internal port ECONNREFUSED**: game crashed after promotion. Logged to stderr per-packet.
- **Satisfactory A2S hangs**: expected behavior — watchdog handles this gracefully via its Satisfactory-specific HTTPS API path.

## Where to change what
- Add a new game protocol path: add a `_handle_*` method + update `_proto_for_sd()`.
- Change internal port offset: `WAKE_INTERNAL_OFFSET` (also update `app/types/steamcmd.py::_WAKE_INTERNAL_OFFSET` — must stay in sync).
- Change wake timeout behavior: `_wake_target()` method.
- Change Minecraft whitelist logic: `_peek_mc_login_username()` + the whitelist gate in the TCP handler.
