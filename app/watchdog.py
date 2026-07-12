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

import base64
import http.client
import json
import re
import socket
import ssl
import struct
import sys
import threading
import time
from dataclasses import dataclass
from typing import Optional

from . import control, registry


WATCHDOG_INTERVAL_SEC = 15
PROBE_TIMEOUT_SEC = 3.0

# Steam apps that use the game port (not 27015) for their query response.
# Satisfactory (Update 8+) is the only one we know about today.
_SINGLE_PORT_STEAM_APPS = {1690800}   # Satisfactory

# Steam apps that do NOT expose a working A2S_INFO responder and must be
# probed via a game-specific channel instead. Satisfactory implements the
# Steam query protocol only partially (the player count byte is unreliable
# and often reads 0) so we route it through the vendor HTTPS API instead.
_SATISFACTORY_APPS = {1690800}


# ---------- A2S_INFO probe (Steam) --------------------------------------

_A2S_HEADER = b"\xff\xff\xff\xff"
_A2S_QUERY = _A2S_HEADER + b"TSource Engine Query\x00"


@dataclass
class ProbeResult:
    # ``players`` is Optional because some game APIs let us cheaply confirm
    # the server is READY without giving us a player count (Satisfactory's
    # unauthenticated HealthCheck is the canonical case). A None here is
    # the "server is ready but I can't tell you how many are on it" signal
    # — the dashboard can still flip from "starting" to "running" and the
    # idle-shutdown countdown just doesn't run.
    players: Optional[int]
    max_players: int
    name: str = ""
    # For allowlist enforcement: each connected player's raw id string from
    # the game API (Palworld REST returns 'steam_<steamid64>'). None when the
    # probe can't enumerate players (A2S count-only / port-bound fallback).
    player_ids: Optional[list] = None


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


# ---------- Satisfactory HTTPS API probe --------------------------------

# Satisfactory ships its own management API (HTTPS + self-signed cert) on
# the game's TCP port. It exposes ``QueryServerState`` which returns real
# player counts — the A2S responder built into the game is unreliable and
# usually reports 0/0 even with players connected, so we skip it entirely
# for this game.
#
# Auth model:
#   * ``QueryServerState`` requires a bearer token with at least ``Client``
#     privilege.
#   * ``PasswordlessLogin`` with ``MinimumPrivilegeLevel: Client`` returns
#     a client token anonymously **only when the server does not require a
#     join password**. Servers with a Guest/Client password will 401 that
#     call and require ``PasswordLogin`` with the admin password.
#   * ``PasswordLogin`` with the admin password + ``Administrator`` level
#     always works (Administrator is a superset of Client).
#
# We cache the token in-process so the 60 s tick isn't three round trips.
# On 401 we drop the cache entry and re-login on the next tick.
#
# TLS: the dedicated server generates a self-signed cert on first run.
# We disable verification because we're probing 127.0.0.1 — same trust
# domain as the manager itself.
_sf_token_cache: dict[tuple[str, int], str] = {}
_sf_tls_ctx: Optional[ssl.SSLContext] = None


def _sf_ssl_context() -> ssl.SSLContext:
    global _sf_tls_ctx
    if _sf_tls_ctx is None:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        _sf_tls_ctx = ctx
    return _sf_tls_ctx


def _sf_api(host: str, port: int, body: dict, token: Optional[str],
            timeout: float) -> Optional[dict]:
    """POST to /api/v1 and return the parsed JSON body, or None on any
    HTTP/parse error. 401 also returns None so callers can retry after
    re-authenticating."""
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        conn = http.client.HTTPSConnection(
            host, port, timeout=timeout, context=_sf_ssl_context()
        )
        try:
            conn.request("POST", "/api/v1", json.dumps(body), headers)
            resp = conn.getresponse()
            raw = resp.read()
            if resp.status != 200:
                return None
            return json.loads(raw.decode("utf-8", "replace"))
        finally:
            conn.close()
    except (OSError, socket.timeout, ssl.SSLError, ValueError,
            json.JSONDecodeError, http.client.HTTPException):
        return None


def _sf_login(host: str, port: int, admin_password: str,
              timeout: float) -> Optional[str]:
    """Return an auth token or None. Prefers admin login if the operator
    put the password in the server def (needed for password-protected
    servers); otherwise falls back to anonymous Client login."""
    if admin_password:
        body = {
            "function": "PasswordLogin",
            "data": {
                "MinimumPrivilegeLevel": "Administrator",
                "Password": admin_password,
            },
        }
        j = _sf_api(host, port, body, None, timeout)
        tok = (j or {}).get("data", {}).get("authenticationToken")
        if tok:
            return tok
    # Fall through: try passwordless Client (works for open servers).
    body = {
        "function": "PasswordlessLogin",
        "data": {"MinimumPrivilegeLevel": "Client"},
    }
    j = _sf_api(host, port, body, None, timeout)
    return (j or {}).get("data", {}).get("authenticationToken")


def probe_satisfactory_https(host: str, port: int, admin_password: str = "",
                              timeout: float = PROBE_TIMEOUT_SEC) -> Optional[ProbeResult]:
    """Two-stage Satisfactory readiness + player-count probe.

    Stage 1 (readiness, no auth): ``HealthCheck``. Returns
    ``{"data":{"health":"healthy",...}}`` once the world has finished
    loading. This is what flips the dashboard's "starting" badge to
    "running" — no admin_password required, works on any Satisfactory
    server as long as its API is reachable on ``port``.

    Stage 2 (player count, needs auth): ``QueryServerState``. Only
    attempted if Stage 1 succeeded. Requires either the operator's
    ``admin_password`` in the yaml, or the server allows anonymous
    Client login. If Stage 2 fails, we still return a ProbeResult with
    ``players=None`` — the server is confirmed ready, just no player
    count. Idle-shutdown countdown skips these cases (see _tick).

    Returns None only when even Stage 1 fails — i.e. the server API is
    not reachable at all on this port. That keeps the "starting" badge
    lit until the game actually accepts HTTPS."""
    # Stage 1 — always try. No auth needed.
    j = _sf_api(
        host, port,
        {"function": "HealthCheck", "data": {"clientCustomData": ""}},
        None, timeout,
    )
    if j is None:
        return None
    health = (j.get("data", {}) or {}).get("health", "")
    if health != "healthy":
        # "slow" during world load, missing on cold start — treat as not
        # ready yet. Don't fall through to QueryServerState (it'd fail too).
        return None

    # Stage 2 — best-effort player count. Failure is OK; we still return
    # a ProbeResult indicating readiness with players=None.
    key = (host, port)
    for attempt in range(2):
        token = _sf_token_cache.get(key)
        if not token:
            token = _sf_login(host, port, admin_password, timeout)
            if not token:
                # Can't auth. Return readiness-only result.
                return ProbeResult(players=None, max_players=0)
            _sf_token_cache[key] = token

        j2 = _sf_api(
            host, port,
            {"function": "QueryServerState"},
            token, timeout,
        )
        if j2 is None:
            # 401 or transport error — drop the token and retry once.
            _sf_token_cache.pop(key, None)
            if attempt == 0:
                continue
            return ProbeResult(players=None, max_players=0)

        state = (j2.get("data", {}) or {}).get("serverGameState", {}) or {}
        try:
            return ProbeResult(
                players=int(state.get("numConnectedPlayers", 0) or 0),
                max_players=int(state.get("playerLimit", 0) or 0),
            )
        except (TypeError, ValueError):
            return ProbeResult(players=None, max_players=0)
    return ProbeResult(players=None, max_players=0)


# ---------- probe strategy per server type -----------------------------

# Must stay in sync with wake_proxy.WAKE_INTERNAL_OFFSET. Kept as a local
# copy so watchdog stays independent of the wake_proxy import graph.
_WAKE_INTERNAL_OFFSET = 10000

# Grace window before the port-bound readiness fallback (see _tick) may flip a
# server to "ready". Some Steam dedicated servers (Palworld) never answer a
# local A2S query — they register with Steam's master server — so the A2S probe
# never succeeds even though the server IS accepting connections. Rather than
# hang on "starting" forever, we treat a bound game port as ready once the unit
# has been active this long (short enough to feel responsive, long enough not
# to flip green during the first second of a real world-load).
_PORT_READY_GRACE_MS = 30_000


def _effective_game_port(sd) -> int:
    """UDP port the game process actually binds (accounts for wake-on-demand,
    which offsets the game to sd.port + WAKE_INTERNAL_OFFSET behind the proxy)."""
    port = sd.port
    if getattr(sd, "wake_on_demand", False):
        port += _WAKE_INTERNAL_OFFSET
    return port


def _udp_port_bound(port: int) -> bool:
    """True if any process has bound ``port`` on UDP (IPv4 or IPv6).

    Reads /proc/net/udp{,6} directly — no external tools, works unprivileged.
    Used as a readiness fallback for Steam games with no local A2S responder:
    a bound game port means the server is up and accepting connections.
    """
    for path in ("/proc/net/udp", "/proc/net/udp6"):
        try:
            with open(path, encoding="ascii", errors="replace") as f:
                lines = f.readlines()[1:]   # skip header row
        except OSError:
            continue
        for line in lines:
            parts = line.split()
            if len(parts) < 2:
                continue
            try:
                if int(parts[1].split(":")[1], 16) == port:
                    return True
            except (ValueError, IndexError):
                continue
    return False


_PALWORLD_APPS = {2394010}   # Palworld dedicated (native Linux)


def probe_palworld_rest(host: str, port: int, admin_password: str,
                        timeout: float = PROBE_TIMEOUT_SEC) -> Optional[ProbeResult]:
    """Query Palworld's REST API ``/v1/api/players`` for the live player list.

    Palworld has no working local A2S responder, but its REST API (enabled
    with ``RESTAPIEnabled=True``) exposes the player list behind HTTP Basic
    auth: username ``admin``, password = the server's ``AdminPassword``.
    Returns a ProbeResult carrying the player COUNT and each player's raw id
    string (``steam_<steamid64>``) for the allowlist enforcer. Returns None on
    any failure (API disabled, missing/wrong password, not up yet, timeout) so
    the caller falls back to the port-bound readiness signal.

    Queried on loopback only; the REST port is never opened in the firewall
    (Pocketpair explicitly warns it must not face the internet).
    """
    if not admin_password:
        return None
    token = base64.b64encode(f"admin:{admin_password}".encode()).decode()
    try:
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
        conn.request("GET", "/v1/api/players",
                     headers={"Authorization": f"Basic {token}",
                              "Accept": "application/json"})
        resp = conn.getresponse()
        body = resp.read()
        conn.close()
    except (OSError, http.client.HTTPException):
        return None
    if resp.status != 200:
        return None
    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except (ValueError, UnicodeDecodeError):
        return None
    players = data.get("players") if isinstance(data, dict) else None
    if not isinstance(players, list):
        return None
    ids: list = []
    for p in players:
        if isinstance(p, dict):
            ids.append(str(p.get("userId") or p.get("steamId") or p.get("userid") or ""))
    return ProbeResult(players=len(players), max_players=0, player_ids=ids)


def _palworld_kick(host: str, port: int, admin_password: str, userid: str,
                   message: str = "Not on the server allowlist.",
                   timeout: float = PROBE_TIMEOUT_SEC) -> bool:
    """POST ``/v1/api/kick`` to remove a player. ``userid`` is Palworld's own
    id string (e.g. ``steam_7656...``). Returns True on HTTP 200."""
    if not admin_password or not userid:
        return False
    token = base64.b64encode(f"admin:{admin_password}".encode()).decode()
    payload = json.dumps({"userid": userid, "message": message})
    try:
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
        conn.request("POST", "/v1/api/kick", body=payload,
                     headers={"Authorization": f"Basic {token}",
                              "Content-Type": "application/json"})
        resp = conn.getresponse()
        resp.read()
        conn.close()
    except (OSError, http.client.HTTPException):
        return False
    return resp.status == 200


def _enforce_steamid_allowlist(sd, result) -> None:
    """Kick connected players not on ``sd.access.allowed_steamids``.

    Games with a native whitelist file (ARK) are enforced at configure() time.
    Palworld has none, so we enforce LIVE here via the REST API. Deliberately
    FAIL-OPEN: we only ever kick when we can positively identify a player by a
    clean steamID64 that is NOT on a NON-EMPTY allowlist, and we kick using the
    game's OWN id string — so a format surprise or an empty list can never lock
    the owner out.
    """
    access = getattr(sd, "access", None)
    if not access or getattr(access, "mode", "") != "steamid_allowlist":
        return
    if getattr(sd, "steam_app_id", None) not in _PALWORLD_APPS:
        return  # only Palworld REST enforcement is wired up here
    ids = getattr(result, "player_ids", None)
    if not ids:
        return  # no parsed roster => never kick blind
    allowed = getattr(access, "allowed_steamids", None) or []
    allow_set = {re.sub(r"\D", "", str(s)) for s in allowed}
    allow_set.discard("")
    if not allow_set:
        return  # empty allowlist => treat as unconfigured; do NOT kick anyone
    admin_pw = ""
    pw_cfg = getattr(sd, "passwords", None)
    if pw_cfg is not None:
        admin_pw = getattr(pw_cfg, "admin_password", "") or ""
    if not admin_pw:
        return
    rest_port = _effective_game_port(sd) + 1
    for raw in ids:
        m = re.search(r"steam_(\d{17})", str(raw))
        if not m:
            continue  # unrecognised id format => fail-open, never kick
        sid = m.group(1)
        if sid in allow_set:
            continue
        ok = _palworld_kick("127.0.0.1", rest_port, admin_pw, str(raw))
        print(f"[watchdog] allowlist: kicked {sid} from {sd.name} "
              f"({'ok' if ok else 'kick FAILED'})", file=sys.stderr, flush=True)


def _probe_for(sd) -> Optional[ProbeResult]:
    """Dispatch to the correct probe. Returns None if the server type has
    no supported probe strategy (custom type, unknown steamcmd game)."""
    host = "127.0.0.1"
    # When wake-on-demand is on, the manager's wake-proxy owns the public
    # port and the game process binds ``sd.port + WAKE_INTERNAL_OFFSET``.
    # Probing the public port for Minecraft would hit the wake-proxy's own
    # SLP responder — which always answers "0/20 players, server is asleep"
    # — so the watchdog would think the server is empty forever and stop
    # it out from under the currently-connected players. Probe the game's
    # real internal port instead.
    #
    # For Steam UDP wake, the wake-proxy transparently relays 27015/UDP
    # (A2S) through to the game once it's running, so A2S on 27015 still
    # works correctly and doesn't need remapping.
    if sd.type == "steamcmd":
        if not sd.steam_app_id:
            return None
        if sd.steam_app_id in _PALWORLD_APPS:
            # Palworld has no working local A2S responder — read its REST API
            # instead (real player list + readiness). Needs RESTAPIEnabled and
            # an AdminPassword; if either is missing this returns None and
            # _tick's port-bound fallback still flips the server to "ready"
            # (just without a player count).
            admin_pw = ""
            pw_cfg = getattr(sd, "passwords", None)
            if pw_cfg is not None:
                admin_pw = getattr(pw_cfg, "admin_password", "") or ""
            return probe_palworld_rest("127.0.0.1", _effective_game_port(sd) + 1, admin_pw)
        # Satisfactory: A2S is broken (always reports 0 players). Route to
        # the HTTPS Server API instead. The API lives on TCP:port (pinned
        # by the recipe's -ServerQueryPort={port} launch flag — without
        # that flag Unreal defaults it to port+1, which was a long-running
        # source of "the SM panel says offline but the game is fine" bugs).
        # Wake-on-demand offsets the port when active.
        if sd.steam_app_id in _SATISFACTORY_APPS:
            api_port = sd.port
            if getattr(sd, "wake_on_demand", False):
                api_port = sd.port + _WAKE_INTERNAL_OFFSET
            admin_pw = ""
            pw_cfg = getattr(sd, "passwords", None)
            if pw_cfg is not None:
                admin_pw = getattr(pw_cfg, "admin_password", "") or ""
            return probe_satisfactory_https(host, api_port, admin_pw)
        query_port = sd.port if sd.steam_app_id in _SINGLE_PORT_STEAM_APPS else 27015
        # Single-port Steam games (Satisfactory) share the game socket with
        # A2S — remap to the internal port when wake is on.
        if getattr(sd, "wake_on_demand", False) and sd.steam_app_id in _SINGLE_PORT_STEAM_APPS:
            query_port = sd.port + _WAKE_INTERNAL_OFFSET
        r = probe_a2s(host, query_port)
        if r is None:
            # Some Steam dedicated servers answer A2S on the GAME port instead
            # of 27015 (or expose no local A2S at all — the _tick port-bound
            # fallback covers that case). Try the game port before giving up so
            # we still get a real player count when the game does respond there.
            game_port = _effective_game_port(sd)
            if game_port != query_port:
                r = probe_a2s(host, game_port)
        return r
    if sd.type in ("minecraft-java", "minecraft-forge"):
        port = sd.port
        if getattr(sd, "wake_on_demand", False):
            port = sd.port + _WAKE_INTERNAL_OFFSET
        return probe_mc_slp(host, port)
    return None


def probe_supported(sd) -> bool:
    """True when the manager knows how to probe this server for readiness
    (world loaded + accepting connections). Used by the dashboard to show
    a 'starting' badge while systemd says active but the game is still
    loading the world.

    Custom-type servers and generic steamcmd installs without a known
    query strategy return False — the dashboard falls back to 'running'
    the moment systemd flips the service to active."""
    if sd.type in ("minecraft-java", "minecraft-forge"):
        return True
    if sd.type == "steamcmd":
        return bool(getattr(sd, "steam_app_id", None))
    return False


# ---------- watchdog thread --------------------------------------------

@dataclass
class _State:
    last_players: Optional[int] = None
    last_max: Optional[int] = None
    last_probe_ok: bool = False
    # First wall-clock ms at which the probe succeeded since the server
    # last went active. Populated on the first successful probe and reset
    # to None whenever the systemd unit stops. Used purely for the "ready"
    # signal on the dashboard — the idle-shutdown countdown is driven by
    # empty_since_ms, not this field.
    first_ready_ms: Optional[int] = None
    # Wall-clock ms at which we first observed systemd active=active for
    # this server since it last went inactive. Populated on the first
    # tick where the unit is up, cleared when it stops. Combined with
    # first_ready_ms this lets the dashboard tell "still loading (normal)"
    # apart from "stuck (probably crashed)".
    active_since_ms: Optional[int] = None
    empty_since_ms: Optional[int] = None
    consecutive_probe_fails: int = 0
    # True the first time we've observed at least one connected player
    # on this server (players >= 1 in a probe result) since it last went
    # active. Idle-shutdown never fires until this flips to True — a
    # freshly-started server with zero players should not be auto-killed
    # right after boot just because nobody has joined yet. Without this
    # gate, a Palworld / Satisfactory / etc. server that answers A2S
    # with players=0 (because Steam-auth is broken or no clients CAN
    # connect due to a firewall/network issue upstream) gets stopped
    # every N minutes on a loop the operator can't see the source of —
    # this bug ate an entire afternoon. See git history for the smoking
    # gun.
    ever_saw_player: bool = False


# Thresholds for flagging a server as taking unusually long to become
# ready. Chosen empirically:
#   * Minecraft: typically <60 s to green.
#   * Palworld / Satisfactory: 1-5 min cold-start.
#   * ARK / Enshrouded: 5-15 min for large worlds.
# So 5 min is a decent "hmm, taking a while" mark for the smaller games
# and 20 min is "something is wrong" for even the biggest builds. The
# frontend uses these flags to change chip color + surface a hint linking
# to the Console tab; the watchdog itself takes no action.
SLOW_START_THRESHOLD_SEC = 5 * 60
STUCK_START_THRESHOLD_SEC = 20 * 60


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
                ready = s.first_ready_ms is not None
                # How long has this server been in the "active-but-not-ready"
                # (i.e. "starting") state? Only meaningful when not ready.
                starting_sec = 0
                if not ready and s.active_since_ms:
                    starting_sec = (now_ms - s.active_since_ms) // 1000
                out[name] = {
                    "players": s.last_players,
                    "max_players": s.last_max,
                    "probe_ok": s.last_probe_ok,
                    "ready": ready,
                    "empty_sec": empty_ms // 1000,
                    "starting_sec": starting_sec,
                    "slow_start": starting_sec >= SLOW_START_THRESHOLD_SEC,
                    "stuck_start": starting_sec >= STUCK_START_THRESHOLD_SEC,
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
            try:
                st = control.status(sd)
            except Exception:
                continue
            if st.active != "active":
                # Server not running — clear its state so the "starting"
                # signal and the empty-since timer both start fresh once
                # it comes back up.
                with self._lock:
                    self._states.pop(sd.name, None)
                continue

            # Servers with no supported probe strategy get no state — the
            # dashboard falls back to systemd "active" == running.
            if not probe_supported(sd):
                with self._lock:
                    self._states.pop(sd.name, None)
                continue

            state = self._states.setdefault(sd.name, _State())
            # First tick observing this server as active — remember when.
            if state.active_since_ms is None:
                state.active_since_ms = now_ms
            result = _probe_for(sd)
            if result is None:
                # A2S didn't answer on any port. Some Steam dedicated servers
                # (Palworld) never run a local A2S responder — they register
                # with Steam's master server — yet they ARE accepting client
                # connections once the game's UDP port is bound (confirmed in
                # the field: players connect while A2S stays silent). If the
                # game port is bound and the unit has been active past the
                # grace window, treat it as READY so the dashboard stops
                # showing "starting" forever. players stays unknown (None) so
                # the idle-shutdown countdown never runs off this weak signal.
                active_ms = now_ms - state.active_since_ms if state.active_since_ms else 0
                if active_ms >= _PORT_READY_GRACE_MS and _udp_port_bound(_effective_game_port(sd)):
                    state.consecutive_probe_fails = 0
                    state.last_probe_ok = True
                    state.last_players = None
                    if state.first_ready_ms is None:
                        state.first_ready_ms = now_ms
                    continue
                state.consecutive_probe_fails += 1
                state.last_probe_ok = False
                # Don't shut anything down purely on probe failure — could
                # be transient (server still binding, packet loss, whatever).
                continue

            state.consecutive_probe_fails = 0
            state.last_probe_ok = True
            state.last_players = result.players
            state.last_max = result.max_players
            # Enforce a steamID allowlist for games with no native whitelist
            # file (Palworld) by kicking connected non-allowlisted players via
            # the game API. Fail-open (see the function) — never risks the owner.
            _enforce_steamid_allowlist(sd, result)
            if state.first_ready_ms is None:
                # First successful probe since this server went active —
                # the world has finished loading and the game is accepting
                # connections. This flips the dashboard from "starting" to
                # "running".
                state.first_ready_ms = now_ms

            # Idle-shutdown countdown only runs when configured AND when
            # we actually got a player count. A readiness-only probe
            # (e.g. Satisfactory HealthCheck succeeded but auth for
            # QueryServerState failed) leaves players=None; we can't
            # tell if the server is empty so we never start the countdown.
            if not sd.idle_shutdown_min or sd.idle_shutdown_min <= 0:
                state.empty_since_ms = None
                continue
            if result.players is None:
                state.empty_since_ms = None
                continue

            if result.players > 0:
                state.empty_since_ms = None
                state.ever_saw_player = True
                continue

            # players == 0. Only start (or continue) the idle-shutdown
            # countdown if we've observed at least one connected player
            # at some point during this run. Otherwise, a freshly-booted
            # server with an idle_shutdown_min set gets auto-killed N
            # minutes after start every time — even though "0 players
            # for N minutes since boot" is the NORMAL initial state
            # while waiting for the first player to connect. This gate
            # makes idle-shutdown behave the way operators actually
            # want: "shut down after N min of NO ONE PLAYING", not
            # "shut down N min after boot no matter what".
            if not state.ever_saw_player:
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
