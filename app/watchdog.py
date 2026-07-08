"""Idle-shutdown watchdog (scale-to-zero for running servers).

Every WATCHDOG_INTERVAL seconds, poll each *running* server for its
current player count via the game's native query protocol:

  * Steam-based games (steamcmd type) — A2S_INFO on 27015/UDP (or the
    game port for single-port games like Satisfactory).
  * Minecraft (java or forge)         — Server List Ping (SLP) on the
    server's TCP port.

If a server has ``idle_shutdown_min`` set and has held zero players for
that many minutes, we call ``control.stop(sd)``.

State is in-memory only. If the manager restarts, all "empty since"
timers reset — a fresh idle window begins.

Design notes:
  * The watchdog thread is a daemon; the process exits normally on
    shutdown without needing an explicit stop.
  * Probes must be *cheap and forgiving*. A single failed probe is
    ignored — only sustained zero-player readings trigger a stop.
  * We probe 127.0.0.1 (all our servers bind 0.0.0.0). This avoids the
    LAN IP question and works regardless of firewall rules.
  * Servers without a probe strategy (custom type, generic steamcmd
    with no A2S response) are ignored — they simply can't be scaled
    down automatically.
"""
from __future__ import annotations

import json
import socket
import struct
import threading
import time
from dataclasses import dataclass
from typing import Optional

from . import control, registry


WATCHDOG_INTERVAL_SEC = 60
PROBE_TIMEOUT_SEC = 3.0

# Steam apps that use the game port (not 27015) for their query response.
# Satisfactory (Update 8+) is the only one we know about today.
_SINGLE_PORT_STEAM_APPS = {1690800}   # Satisfactory


# ---------- A2S_INFO probe (Steam) --------------------------------------

_A2S_HEADER = b"\xff\xff\xff\xff"
_A2S_QUERY = _A2S_HEADER + b"TSource Engine Query\x00"


@dataclass
class ProbeResult:
    players: int
    max_players: int
    name: str = ""


def probe_a2s(host: str, port: int, timeout: float = PROBE_TIMEOUT_SEC) -> Optional[ProbeResult]:
    """A2S_INFO query. Handles the modern challenge-response flow."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(timeout)
            s.sendto(_A2S_QUERY, (host, port))
            data, _ = s.recvfrom(4096)
            # Some servers respond with a challenge (S2C_CHALLENGE = 0x41).
            # Resend the query with the 4-byte challenge appended.
            if len(data) >= 9 and data[4:5] == b"A":
                challenge = data[5:9]
                s.sendto(_A2S_QUERY + challenge, (host, port))
                data, _ = s.recvfrom(4096)
    except (OSError, socket.timeout):
        return None

    # Info response: header (0xffffffff) + type 'I' (0x49) + protocol byte
    # + name\0 + map\0 + folder\0 + game\0 + app_id(short) + players(byte)
    # + max_players(byte) + ...
    if len(data) < 6 or data[:4] != _A2S_HEADER or data[4:5] != b"I":
        return None
    payload = data[6:]  # skip header + type + protocol
    try:
        name, payload = _read_cstr(payload)
        _map, payload = _read_cstr(payload)
        _folder, payload = _read_cstr(payload)
        _game, payload = _read_cstr(payload)
        # After the four strings: uint16 app_id, uint8 players, uint8 max.
        if len(payload) < 4:
            return None
        players = payload[2]
        max_players = payload[3]
        return ProbeResult(players=players, max_players=max_players, name=name)
    except (IndexError, ValueError):
        return None


def _read_cstr(buf: bytes) -> tuple[str, bytes]:
    end = buf.index(b"\x00")
    return buf[:end].decode("utf-8", "replace"), buf[end + 1:]


# ---------- Minecraft SLP probe -----------------------------------------

def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _read_varint(sock: socket.socket) -> int:
    n = 0
    shift = 0
    for _ in range(5):
        b = sock.recv(1)
        if not b:
            raise OSError("connection closed while reading varint")
        v = b[0]
        n |= (v & 0x7F) << shift
        if not (v & 0x80):
            return n
        shift += 7
    raise ValueError("varint too long")


def probe_mc_slp(host: str, port: int, timeout: float = PROBE_TIMEOUT_SEC) -> Optional[ProbeResult]:
    """Minecraft Server List Ping (post-1.7). Returns None on any failure."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            s.connect((host, port))
            host_b = host.encode("utf-8")
            handshake_payload = (
                b"\x00"                        # packet id 0x00 = handshake
                + _varint(47)                  # protocol version (1.8ish; server ignores value for SLP)
                + _varint(len(host_b)) + host_b
                + struct.pack(">H", port)
                + b"\x01"                      # next_state = 1 (status)
            )
            s.sendall(_varint(len(handshake_payload)) + handshake_payload)
            s.sendall(_varint(1) + b"\x00")    # empty status-request packet

            _packet_len = _read_varint(s)      # unused; we bound by JSON len
            _packet_id = _read_varint(s)
            json_len = _read_varint(s)

            buf = b""
            while len(buf) < json_len:
                chunk = s.recv(min(4096, json_len - len(buf)))
                if not chunk:
                    return None
                buf += chunk
            j = json.loads(buf.decode("utf-8"))
            players_obj = j.get("players", {}) or {}
            return ProbeResult(
                players=int(players_obj.get("online", 0) or 0),
                max_players=int(players_obj.get("max", 0) or 0),
                name=str(j.get("description", "") or ""),
            )
    except (OSError, socket.timeout, ValueError, KeyError, json.JSONDecodeError):
        return None


# ---------- probe strategy per server type -----------------------------

def _probe_for(sd) -> Optional[ProbeResult]:
    """Dispatch to the correct probe. Returns None if the server type has
    no supported probe strategy (custom type, unknown steamcmd game)."""
    host = "127.0.0.1"
    if sd.type == "steamcmd":
        if not sd.steam_app_id:
            return None
        query_port = sd.port if sd.steam_app_id in _SINGLE_PORT_STEAM_APPS else 27015
        return probe_a2s(host, query_port)
    if sd.type in ("minecraft-java", "minecraft-forge"):
        return probe_mc_slp(host, sd.port)
    return None


# ---------- watchdog thread --------------------------------------------

@dataclass
class _State:
    last_players: Optional[int] = None
    last_max: Optional[int] = None
    last_probe_ok: bool = False
    empty_since_ms: Optional[int] = None
    consecutive_probe_fails: int = 0


class Watchdog:
    def __init__(self) -> None:
        self._states: dict[str, _State] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # -- introspection -------------------------------------------------
    def snapshot(self) -> dict[str, dict]:
        now_ms = int(time.time() * 1000)
        with self._lock:
            out = {}
            for name, s in self._states.items():
                empty_ms = (now_ms - s.empty_since_ms) if s.empty_since_ms else 0
                out[name] = {
                    "players": s.last_players,
                    "max_players": s.last_max,
                    "probe_ok": s.last_probe_ok,
                    "empty_sec": empty_ms // 1000,
                }
            return out

    # -- lifecycle -----------------------------------------------------
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="gs-watchdog", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    # -- internals -----------------------------------------------------
    def _loop(self) -> None:
        # Small initial delay so the manager finishes booting before we
        # start hammering game ports (some games take a beat to bind).
        self._stop.wait(10)
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception:
                # Never let a bad definition or a bad probe kill the watchdog.
                pass
            self._stop.wait(WATCHDOG_INTERVAL_SEC)

    def _tick(self) -> None:
        now_ms = int(time.time() * 1000)
        for sd in registry.list_defs():
            # Skip if no idle policy — but also purge any stale state so
            # snapshots stay clean.
            if not sd.idle_shutdown_min or sd.idle_shutdown_min <= 0:
                with self._lock:
                    self._states.pop(sd.name, None)
                continue

            try:
                st = control.status(sd)
            except Exception:
                continue
            if st.active != "active":
                # Server not running — clear its state so the timer starts
                # fresh once it comes back up.
                with self._lock:
                    self._states.pop(sd.name, None)
                continue

            state = self._states.setdefault(sd.name, _State())
            result = _probe_for(sd)
            if result is None:
                state.consecutive_probe_fails += 1
                state.last_probe_ok = False
                # Don't shut anything down purely on probe failure — could
                # be transient (server still binding, packet loss, whatever).
                continue

            state.consecutive_probe_fails = 0
            state.last_probe_ok = True
            state.last_players = result.players
            state.last_max = result.max_players

            if result.players > 0:
                state.empty_since_ms = None
                continue

            if state.empty_since_ms is None:
                state.empty_since_ms = now_ms
                continue

            elapsed_min = (now_ms - state.empty_since_ms) / 1000 / 60
            if elapsed_min >= sd.idle_shutdown_min:
                try:
                    control.stop(sd)
                except Exception:
                    pass
                # Clear state; systemctl stop is graceful and idempotent,
                # and next tick will notice active != "active" and skip.
                with self._lock:
                    self._states.pop(sd.name, None)


watchdog = Watchdog()
