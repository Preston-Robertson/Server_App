"""Wake-on-demand proxy (UDP + TCP).

For every server def with ``wake_on_demand: true``, we bind the operator-
facing ``sd.port`` and relay traffic to the game process, which is forced
to bind ``sd.port + WAKE_INTERNAL_OFFSET`` internally (see
``app/types/steamcmd.py::_effective_game_port`` for Steam games and the
``patch_server_properties`` helper on TypeHandler for Minecraft).

Two protocol paths, chosen by server type:

  * **UDP** — for the Steam-based games (Palworld, Satisfactory, ARK,
    Valheim, Enshrouded/Wine). The main loop selects on all UDP listen
    sockets. When the game is stopped, incoming datagrams are buffered
    and the wake worker is kicked; once the game answers A2S on the
    internal port, buffered packets are replayed. While the game is
    running, we act as a plain per-client UDP NAT.

  * **TCP** — for Minecraft (``minecraft-java`` and ``minecraft-forge``).
    Each accepted connection is handled in its own daemon thread. If the
    game is asleep, we peek at the Minecraft handshake:

      - ``next_state == 1`` (SLP status ping) → we answer locally with a
        "server is asleep" MOTD so the client's server-list refresh
        doesn't spam wake-ups.
      - ``next_state == 2`` (login intent) → we start the game, wait for
        it to answer SLP on the internal port, then splice the client's
        already-buffered handshake + subsequent traffic into a fresh
        backend socket. From the player's POV: one connection attempt,
        no manual retry.

Because the proxy always owns the public port, the game process never
races us for it — no handoff, no dropped datagrams.

TCP scope note: Minecraft's login flow completes in <30 s once the JVM
answers SLP; the client's own read timeout is generous (~60 s). If the
wake exceeds ``wake_timeout_sec`` we send a login-disconnect packet with
a friendly message and close.
"""
from __future__ import annotations

import json
import select
import socket
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

from . import control, registry
from .watchdog import probe_a2s, probe_mc_slp


# Kept in sync with app/types/steamcmd.py::_WAKE_INTERNAL_OFFSET.
WAKE_INTERNAL_OFFSET = 10000

# select() timeout — how often the main loop wakes up to service
# maintenance (status polls, idle pruning) when there's no traffic.
_POLL_INTERVAL_SEC = 0.2
# How often we ask systemctl whether the game is running. Cheap but not
# free; 5s is plenty of resolution for wake decisions.
_STATUS_REFRESH_SEC = 5.0
# Drop the per-client outbound socket if it's had no traffic for this long.
_CLIENT_IDLE_TIMEOUT_SEC = 300.0
# Cap on how many pre-wake packets we buffer per server. A busy client
# retrying every ~1s during a 90s wake produces ~90 packets — 500 is
# plenty. Anything past this drops the oldest.
_MAX_BUFFERED_PACKETS = 500
# How often the wake worker retries the readiness probe.
_WAKE_PROBE_INTERVAL_SEC = 2.0


@dataclass
class _ClientMap:
    outbound: socket.socket
    last_activity: float


@dataclass
class _ServerProxy:
    name: str
    public_port: int
    internal_port: int
    protocol: str                                  # "udp" or "tcp"
    wake_timeout_sec: int
    listen_sock: socket.socket                     # SOCK_DGRAM or SOCK_STREAM
    is_running: bool = False
    waking_since: Optional[float] = None
    buffered: list = field(default_factory=list)   # UDP-only: (client_addr, data)
    clients: dict = field(default_factory=dict)    # UDP-only: (addr,port) -> _ClientMap
    last_status_check: float = 0.0
    last_wake_error: str = ""
    tcp_conn_count: int = 0                        # TCP-only: connections currently spliced
    # Case-insensitive Minecraft usernames allowed to trigger wake. Empty
    # list = no filtering (any login attempt wakes the server). Only used
    # for TCP wake (Minecraft); ignored for the UDP paths.
    wake_whitelist: list = field(default_factory=list)


# ---------- Minecraft protocol helpers --------------------------------------

def _varint_encode(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _varint_decode(buf: bytes, offset: int = 0) -> tuple[int, int]:
    """Return (value, new_offset). Raises IndexError if buffer is short."""
    n = 0
    shift = 0
    for _ in range(5):
        b = buf[offset]
        offset += 1
        n |= (b & 0x7F) << shift
        if not (b & 0x80):
            return n, offset
        shift += 7
    raise ValueError("varint too long")


def _mc_status_json(server_name: str, running: bool) -> str:
    """Build the JSON payload for a Minecraft SLP status response."""
    if running:
        motd = f"§aServer online§r: {server_name}"
    else:
        motd = f"§eServer is asleep§r — join to wake ({server_name})"
    return json.dumps({
        "version": {"name": "Waking", "protocol": 47},
        "players": {"max": 20, "online": 0, "sample": []},
        "description": {"text": motd},
    })


def _mc_write_packet(sock: socket.socket, packet_id: int, body: bytes) -> None:
    pkt = _varint_encode(packet_id) + body
    sock.sendall(_varint_encode(len(pkt)) + pkt)


def _mc_send_login_disconnect(sock: socket.socket, message: str) -> None:
    """Login-state Disconnect packet (0x00, JSON text). Player sees the text."""
    payload = json.dumps({"text": message}).encode("utf-8")
    body = _varint_encode(len(payload)) + payload
    try:
        _mc_write_packet(sock, 0x00, body)
    except OSError:
        pass


def _tcp_splice(a: socket.socket, b: socket.socket) -> None:
    """Bidirectional TCP relay. Blocks until either side closes."""
    def _pump(src: socket.socket, dst: socket.socket) -> None:
        try:
            while True:
                data = src.recv(65536)
                if not data:
                    break
                dst.sendall(data)
        except OSError:
            pass
        finally:
            for s in (src, dst):
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
    t1 = threading.Thread(target=_pump, args=(a, b), name="gs-splice-a", daemon=True)
    t2 = threading.Thread(target=_pump, args=(b, a), name="gs-splice-b", daemon=True)
    t1.start(); t2.start()
    t1.join(); t2.join()


class WakeProxy:
    """Manages a set of UDP relays, one per wake-enabled server."""

    def __init__(self) -> None:
        self._proxies: dict[str, _ServerProxy] = {}
        # name -> (public_port, protocol, error_string) for defs whose wake
        # proxy we couldn't bind. Surfaced via snapshot() so the dashboard
        # can flag the problem instead of failing silently (which manifests
        # to players as raw "Connection refused" on login).
        self._bind_errors: dict[str, tuple[int, str, str]] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # -- public API -----------------------------------------------------

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="gs-wake", daemon=True)
        self._thread.start()

    def stop_thread(self) -> None:
        self._stop.set()

    def snapshot(self) -> dict[str, dict]:
        """Diagnostics for the /api/servers response."""
        now = time.monotonic()
        with self._lock:
            out = {}
            for name, p in self._proxies.items():
                waking_for = int(now - p.waking_since) if p.waking_since else 0
                out[name] = {
                    "public_port": p.public_port,
                    "internal_port": p.internal_port,
                    "protocol": p.protocol,
                    "bound": True,
                    "bind_error": "",
                    "is_running": p.is_running,
                    "waking": p.waking_since is not None,
                    "waking_sec": waking_for,
                    "buffered_packets": len(p.buffered),
                    "active_clients": len(p.clients) if p.protocol == "udp" else p.tcp_conn_count,
                    "wake_timeout_sec": p.wake_timeout_sec,
                    "last_wake_error": p.last_wake_error,
                }
            for name, (pub, proto, err) in self._bind_errors.items():
                if name in out:
                    continue
                out[name] = {
                    "public_port": pub,
                    "internal_port": pub + WAKE_INTERNAL_OFFSET,
                    "protocol": proto,
                    "bound": False,
                    "bind_error": err,
                    "is_running": False,
                    "waking": False,
                    "waking_sec": 0,
                    "buffered_packets": 0,
                    "active_clients": 0,
                    "wake_timeout_sec": 0,
                    "last_wake_error": "",
                }
            return out

    # -- main loop ------------------------------------------------------

    def _loop(self) -> None:
        # Small delay so the manager finishes booting before we start
        # touching sockets / systemctl.
        self._stop.wait(8)
        last_sync = 0.0
        while not self._stop.is_set():
            try:
                now = time.monotonic()
                if now - last_sync > 5.0:
                    self._sync_proxies()
                    last_sync = now
                self._service_sockets(now)
            except Exception:
                # Never let a bad def or a syscall glitch kill the loop.
                time.sleep(1)

    def _sync_proxies(self) -> None:
        """Add/remove per-server sockets to match current YAML defs."""
        # name -> (pub, internal, wake_timeout, protocol, wake_whitelist)
        wanted: dict[str, tuple[int, int, int, str, list]] = {}
        try:
            for sd in registry.list_defs():
                if not getattr(sd, "wake_on_demand", False):
                    continue
                if sd.port + WAKE_INTERNAL_OFFSET > 65535:
                    # Can't fit an internal port — skip silently. The GUI
                    # already warns operators to keep public port <= 55535.
                    continue
                proto = "tcp" if sd.type in ("minecraft-java", "minecraft-forge") else "udp"
                whitelist = list(getattr(sd, "wake_whitelist", None) or [])
                wanted[sd.name] = (
                    sd.port,
                    sd.port + WAKE_INTERNAL_OFFSET,
                    max(10, int(sd.wake_timeout_sec or 90)),
                    proto,
                    whitelist,
                )
        except Exception:
            return

        with self._lock:
            # Tear down stale proxies (wake_on_demand turned off / protocol
            # changed).
            for name in list(self._proxies.keys()):
                if name not in wanted or self._proxies[name].protocol != wanted[name][3]:
                    self._close_proxy_locked(name)
            # Purge stale bind-error entries for defs that no longer want
            # wake-on-demand.
            for name in list(self._bind_errors.keys()):
                if name not in wanted:
                    self._bind_errors.pop(name, None)

            # Bind new proxies. Bind can fail if the game currently holds
            # the port (operator toggled wake_on_demand on but hasn't
            # reinstalled + restarted yet); we retry on the next sync.
            for name, (pub, internal, wto, proto, whitelist) in wanted.items():
                if name in self._proxies:
                    # Update mutable settings without rebinding.
                    self._proxies[name].wake_timeout_sec = wto
                    self._proxies[name].wake_whitelist = whitelist
                    self._bind_errors.pop(name, None)
                    continue
                try:
                    if proto == "udp":
                        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                        s.setblocking(False)
                        s.bind(("0.0.0.0", pub))
                    else:   # tcp
                        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                        s.setblocking(False)
                        s.bind(("0.0.0.0", pub))
                        s.listen(64)
                except OSError as e:
                    # Almost always EADDRINUSE — the game still binds the
                    # public port. Operator needs to reinstall so the game
                    # moves to the internal port. Surface it: log once per
                    # transition and expose via snapshot so the dashboard
                    # can flag it. Otherwise players hit raw "Connection
                    # refused" with nothing in the logs.
                    err = f"bind :{pub}/{proto} failed: {e}"
                    prev = self._bind_errors.get(name)
                    if prev is None or prev[2] != err:
                        print(
                            f"[wake_proxy] {name}: {err} "
                            f"(will retry every 5s; likely the game process "
                            f"still owns :{pub} — reinstall to move it to "
                            f":{internal})",
                            file=sys.stderr, flush=True,
                        )
                    self._bind_errors[name] = (pub, proto, err)
                    continue
                # Success — clear any stale error and log the bind.
                if name in self._bind_errors:
                    self._bind_errors.pop(name, None)
                    print(
                        f"[wake_proxy] {name}: now bound to :{pub}/{proto} "
                        f"(backend :{internal})",
                        file=sys.stderr, flush=True,
                    )
                self._proxies[name] = _ServerProxy(
                    name=name,
                    public_port=pub,
                    internal_port=internal,
                    protocol=proto,
                    wake_timeout_sec=wto,
                    listen_sock=s,
                    wake_whitelist=whitelist,
                )

    def _close_proxy_locked(self, name: str) -> None:
        p = self._proxies.pop(name, None)
        if not p:
            return
        try:
            p.listen_sock.close()
        except OSError:
            pass
        for cm in p.clients.values():
            try:
                cm.outbound.close()
            except OSError:
                pass

    # -- socket servicing -----------------------------------------------

    def _service_sockets(self, now: float) -> None:
        # Snapshot proxies + build fd map outside select() to keep the
        # critical section short.
        with self._lock:
            proxies = list(self._proxies.values())
        fd_map: dict[int, tuple] = {}
        rfds: list[int] = []
        for p in proxies:
            rfds.append(p.listen_sock.fileno())
            fd_map[p.listen_sock.fileno()] = ("listen", p, None)
            for addr, cm in p.clients.items():
                rfds.append(cm.outbound.fileno())
                fd_map[cm.outbound.fileno()] = ("outbound", p, (addr, cm))
        if not rfds:
            self._stop.wait(_POLL_INTERVAL_SEC)
            return
        try:
            ready, _, _ = select.select(rfds, [], [], _POLL_INTERVAL_SEC)
        except (OSError, ValueError):
            return
        for fd in ready:
            entry = fd_map.get(fd)
            if not entry:
                continue
            kind = entry[0]
            if kind == "listen":
                p = entry[1]
                if p.protocol == "udp":
                    self._handle_client_packet(p, now)
                else:
                    self._handle_tcp_accept(p, now)
            else:
                p = entry[1]
                addr, cm = entry[2]
                self._handle_game_response(p, addr, cm, now)

        # Maintenance passes (cheap; run every tick).
        for p in proxies:
            self._maybe_refresh_status(p, now)
            self._prune_idle_clients(p, now)

    def _handle_client_packet(self, p: _ServerProxy, now: float) -> None:
        try:
            data, addr = p.listen_sock.recvfrom(65535)
        except (BlockingIOError, OSError):
            return

        if p.is_running:
            self._forward_to_game(p, addr, data, now)
            return

        # Game stopped — buffer this packet and (if not already) trigger a wake.
        p.buffered.append((addr, data))
        if len(p.buffered) > _MAX_BUFFERED_PACKETS:
            # Drop oldest — client's first packet is stale by now anyway.
            del p.buffered[: len(p.buffered) - _MAX_BUFFERED_PACKETS]
        if p.waking_since is None:
            p.waking_since = now
            p.last_wake_error = ""
            threading.Thread(
                target=self._wake_target, args=(p.name,),
                name=f"gs-wake-{p.name}", daemon=True,
            ).start()

    def _forward_to_game(self, p: _ServerProxy, client_addr, data: bytes, now: float) -> None:
        cm = p.clients.get(client_addr)
        if cm is None:
            try:
                out = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                out.setblocking(False)
                out.connect(("127.0.0.1", p.internal_port))
            except OSError:
                return
            cm = _ClientMap(outbound=out, last_activity=now)
            with self._lock:
                p.clients[client_addr] = cm
        try:
            cm.outbound.send(data)
            cm.last_activity = now
        except OSError:
            # ECONNREFUSED / EAGAIN — game may be mid-shutdown. Drop and
            # let the client retry.
            pass

    def _handle_game_response(self, p: _ServerProxy, client_addr, cm: _ClientMap, now: float) -> None:
        try:
            data = cm.outbound.recv(65535)
        except (BlockingIOError, OSError):
            return
        try:
            p.listen_sock.sendto(data, client_addr)
            cm.last_activity = now
        except OSError:
            pass

    # -- TCP (Minecraft) ------------------------------------------------

    def _peek_mc_login_username(self, conn: socket.socket,
                                buffered: bytes) -> tuple[bytes, Optional[str]]:
        """Read from ``conn`` until we can parse the Login Start packet's
        name field. Returns (extended_buffered, username_or_None).

        The Login Start packet layout (all versions we care about):
            VarInt packet_length
            VarInt packet_id (0x00 in login state)
            String name  (VarInt length + UTF-8, max 16 chars)
            ...           (UUID/other fields we don't need)

        We deliberately never consume from the socket beyond what's needed
        so the caller can still splice the full byte stream to the backend
        if the whitelist check passes.
        """
        buf = bytearray(buffered)
        conn.settimeout(3.0)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            try:
                pkt_len, off = _varint_decode(bytes(buf), 0)
                if len(buf) - off >= pkt_len:
                    pkt_id, off2 = _varint_decode(bytes(buf), off)
                    if pkt_id != 0x00:
                        return bytes(buf), None
                    name_len, off3 = _varint_decode(bytes(buf), off2)
                    if 0 < name_len <= 32 and off3 + name_len <= off + pkt_len:
                        name = bytes(buf[off3:off3 + name_len]).decode(
                            "utf-8", errors="replace"
                        )
                        return bytes(buf), name
                    return bytes(buf), None
            except (IndexError, ValueError):
                pass   # incomplete varint / short buffer — read more below
            try:
                chunk = conn.recv(256)
            except (socket.timeout, OSError):
                return bytes(buf), None
            if not chunk:
                return bytes(buf), None
            buf += chunk
        return bytes(buf), None

    def _handle_tcp_accept(self, p: _ServerProxy, now: float) -> None:
        try:
            conn, addr = p.listen_sock.accept()
        except (BlockingIOError, OSError):
            return
        # Hand off to a thread — MC connections are long-lived once spliced.
        threading.Thread(
            target=self._handle_tcp_conn, args=(p, conn),
            name=f"gs-tcp-{p.name}", daemon=True,
        ).start()

    def _handle_tcp_conn(self, p: _ServerProxy, conn: socket.socket) -> None:
        """Peek at the Minecraft handshake and route to status / login."""
        try:
            conn.setblocking(True)
            conn.settimeout(5.0)

            # Read up to ~1 KB — the handshake (+ optional trailing status
            # request) rarely exceeds this. We only need enough to parse
            # the handshake packet.
            buf = bytearray()
            handshake_end: Optional[int] = None
            next_state: Optional[int] = None
            while len(buf) < 4096:
                try:
                    chunk = conn.recv(1024)
                except socket.timeout:
                    return
                if not chunk:
                    return
                buf += chunk
                try:
                    pkt_len, off = _varint_decode(bytes(buf), 0)
                    if len(buf) - off < pkt_len:
                        continue   # need more bytes for the full packet body
                    body_end = off + pkt_len
                    pkt_id, off2 = _varint_decode(bytes(buf), off)
                    if pkt_id != 0x00:
                        return    # not a handshake — silently drop
                    _proto_ver, off2 = _varint_decode(bytes(buf), off2)
                    addr_len, off2 = _varint_decode(bytes(buf), off2)
                    off2 += addr_len            # server_address string
                    off2 += 2                   # server_port ushort
                    next_state, _ = _varint_decode(bytes(buf), off2)
                    handshake_end = body_end
                    break
                except (IndexError, ValueError):
                    continue   # incomplete varint; read more

            if handshake_end is None or next_state is None:
                return
            trailing = bytes(buf[handshake_end:])
            handshake_bytes = bytes(buf[:handshake_end])

            if next_state == 1:
                self._handle_mc_status(p, conn, trailing)
            elif next_state == 2 or next_state == 3:
                # 2 = login; 3 = transfer (1.20.5+, treat like login).
                self._handle_mc_login_wake(p, conn, handshake_bytes + trailing)
            # any other next_state → drop
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _handle_mc_status(self, p: _ServerProxy, conn: socket.socket, trailing: bytes) -> None:
        """Answer the Server List Ping locally.

        We deliberately don't proxy status requests to the backend even when
        the game is running — SLP fires every second in the server list and
        we'd rather not carry that overhead. The MOTD tells the player
        whether the server is asleep or online.
        """
        payload = _mc_status_json(p.name, p.is_running).encode("utf-8")
        body = _varint_encode(len(payload)) + payload
        try:
            _mc_write_packet(conn, 0x00, body)
        except OSError:
            return

        # Read the optional ping request (packet id 0x01 + 8-byte long) and
        # echo it back as a pong (0x01 with the same 8 bytes). Some clients
        # skip this; a timeout is fine.
        conn.settimeout(2.0)
        buf = bytearray(trailing)
        try:
            while len(buf) < 32:
                chunk = conn.recv(32 - len(buf))
                if not chunk:
                    break
                buf += chunk
                try:
                    pkt_len, off = _varint_decode(bytes(buf), 0)
                    if len(buf) - off < pkt_len:
                        continue
                    pkt_id, off2 = _varint_decode(bytes(buf), off)
                    if pkt_id == 0x01 and off + pkt_len <= len(buf):
                        payload = bytes(buf[off2:off + pkt_len])
                        _mc_write_packet(conn, 0x01, payload)
                        return
                    return
                except (IndexError, ValueError):
                    continue
        except (socket.timeout, OSError):
            pass

    def _handle_mc_login_wake(self, p: _ServerProxy, conn: socket.socket,
                              buffered: bytes) -> None:
        """Wake the server (if needed) then splice this connection to it."""
        # Wake-whitelist gate: only run BEFORE we've spent CPU starting the
        # JVM. Reads the Login Start packet (client sends it immediately
        # after the handshake), extracts the username, and rejects the
        # login without waking if the name isn't allowed. Skipped when
        # the server is already running — MC's own whitelist handles auth
        # from that point.
        if not p.is_running and p.wake_whitelist:
            buffered, username = self._peek_mc_login_username(conn, buffered)
            if username is None:
                # Malformed / bot / early disconnect. Drop silently — no
                # point spending a login-disconnect packet on a scanner.
                return
            allowed = {n.strip().lower() for n in p.wake_whitelist if n and n.strip()}
            if username.strip().lower() not in allowed:
                _mc_send_login_disconnect(
                    conn,
                    f"§eServer is asleep§r.\n"
                    f"§7{username}§r is not on the wake list — ask the host to add you.",
                )
                return

        # Kick a wake if the game isn't up yet and no one else has.
        if not p.is_running:
            with self._lock:
                if p.waking_since is None:
                    p.waking_since = time.monotonic()
                    p.last_wake_error = ""
                    threading.Thread(
                        target=self._wake_target, args=(p.name,),
                        name=f"gs-wake-{p.name}", daemon=True,
                    ).start()

            # Wait for the game to become responsive or the timeout to lapse.
            deadline = time.monotonic() + p.wake_timeout_sec
            while time.monotonic() < deadline and not self._stop.is_set():
                if p.is_running:
                    break
                time.sleep(0.3)
            else:
                _mc_send_login_disconnect(
                    conn,
                    f"§eServer didn't wake in {p.wake_timeout_sec}s.§r Try again shortly.",
                )
                return
            if not p.is_running:
                _mc_send_login_disconnect(
                    conn,
                    f"§eServer didn't wake in {p.wake_timeout_sec}s.§r Try again shortly.",
                )
                return

        # Splice the connection to the backend. Even after is_running
        # flipped (which requires a successful SLP probe), the JVM's
        # accept-backlog can momentarily reject a fresh connection under
        # a burst; retry for a few seconds before giving up so the player
        # doesn't see "Backend unavailable" for a purely transient error.
        backend: Optional[socket.socket] = None
        last_err: Optional[OSError] = None
        connect_deadline = time.monotonic() + 8.0
        while time.monotonic() < connect_deadline and not self._stop.is_set():
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.settimeout(3.0)
                s.connect(("127.0.0.1", p.internal_port))
                s.settimeout(None)
                backend = s
                break
            except OSError as e:
                last_err = e
                try:
                    s.close()
                except (OSError, UnboundLocalError):
                    pass
                time.sleep(0.4)
        if backend is None:
            _mc_send_login_disconnect(conn, f"Backend unavailable: {last_err}")
            return

        # Replay the client bytes we already read (handshake + any queued
        # login-start payload) BEFORE starting the bidirectional splice.
        try:
            if buffered:
                backend.sendall(buffered)
        except OSError as e:
            _mc_send_login_disconnect(conn, f"Backend write failed: {e}")
            try: backend.close()
            except OSError: pass
            return

        with self._lock:
            p.tcp_conn_count += 1
        try:
            conn.setblocking(True)
            conn.settimeout(None)
            _tcp_splice(conn, backend)
        finally:
            try: backend.close()
            except OSError: pass
            with self._lock:
                p.tcp_conn_count = max(0, p.tcp_conn_count - 1)

    # -- background wake worker -----------------------------------------

    def _wake_target(self, name: str) -> None:
        """Run in a helper thread: kick systemctl and poll for readiness."""
        try:
            sd = registry.load_def(name)
            control.start(sd)
        except Exception as e:
            with self._lock:
                p = self._proxies.get(name)
                if p:
                    p.waking_since = None
                    p.buffered.clear()
                    p.last_wake_error = f"start failed: {e}"
            return

        # Poll: is the game answering its native protocol on the internal
        # port? A2S for Steam games, SLP for Minecraft.
        with self._lock:
            p = self._proxies.get(name)
            if not p:
                return
            internal_port = p.internal_port
            protocol = p.protocol
            deadline = time.monotonic() + p.wake_timeout_sec

        while time.monotonic() < deadline and not self._stop.is_set():
            time.sleep(_WAKE_PROBE_INTERVAL_SEC)
            if protocol == "tcp":
                result = probe_mc_slp("127.0.0.1", internal_port, timeout=1.5)
            else:
                result = probe_a2s("127.0.0.1", internal_port, timeout=1.5)
            if result is not None:
                # Game is up — flip is_running + flush buffered packets.
                self._promote_running(name)
                return

        # Timed out — abort the wake. Client sees a dropped session and
        # will typically try to reconnect on its own.
        with self._lock:
            p = self._proxies.get(name)
            if p:
                p.waking_since = None
                p.buffered.clear()
                p.last_wake_error = f"timeout after {p.wake_timeout_sec}s"

    def _promote_running(self, name: str) -> None:
        """Called when the wake worker confirms the game is answering."""
        now = time.monotonic()
        with self._lock:
            p = self._proxies.get(name)
            if not p:
                return
            p.is_running = True
            p.waking_since = None
            buffered = p.buffered
            p.buffered = []
        # Replay outside the lock; _forward_to_game acquires it briefly.
        for addr, data in buffered:
            self._forward_to_game(p, addr, data, now)

    # -- housekeeping ---------------------------------------------------

    def _maybe_refresh_status(self, p: _ServerProxy, now: float) -> None:
        if now - p.last_status_check < _STATUS_REFRESH_SEC:
            return
        p.last_status_check = now
        try:
            sd = registry.load_def(p.name)
            st = control.status(sd)
        except Exception:
            return

        active = (st.active == "active")

        # Demote first: if systemd says inactive, drop any state we had
        # and close client sockets so we don't route stale traffic.
        if not active:
            if p.is_running:
                p.is_running = False
                with self._lock:
                    for cm in p.clients.values():
                        try:
                            cm.outbound.close()
                        except OSError:
                            pass
                    p.clients.clear()
            return

        # Already known-running, nothing to reconcile.
        if p.is_running:
            return

        # A wake is in flight — let _wake_target's own probe promote when
        # it's confirmed the game answers. Double-probing here would just
        # add load and race the worker.
        if p.waking_since is not None:
            return

        # systemd-active but we haven't promoted yet: the game was started
        # outside our knowledge (operator hit Start, auto-start on boot,
        # or a manual `systemctl start`). Probe the native protocol before
        # flipping is_running — a modded Forge server can be systemd-active
        # for 60-120s of mod loading before it actually binds the port.
        # If we promoted on ActiveState alone, the next login-wake would
        # race into a backend.connect() and get ECONNREFUSED, which the
        # player sees as "Backend unavailable: [Errno 111] Connection
        # refused" (see the login-disconnect path in _handle_mc_login_wake).
        if p.protocol == "tcp":
            result = probe_mc_slp("127.0.0.1", p.internal_port, timeout=1.5)
        else:
            result = probe_a2s("127.0.0.1", p.internal_port, timeout=1.5)
        if result is not None:
            p.is_running = True

    def _prune_idle_clients(self, p: _ServerProxy, now: float) -> None:
        stale = [addr for addr, cm in p.clients.items()
                 if now - cm.last_activity > _CLIENT_IDLE_TIMEOUT_SEC]
        if not stale:
            return
        with self._lock:
            for addr in stale:
                cm = p.clients.pop(addr, None)
                if cm:
                    try:
                        cm.outbound.close()
                    except OSError:
                        pass


wake_proxy = WakeProxy()
