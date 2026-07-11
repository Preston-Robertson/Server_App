# Architectural Decisions (ADR-lite)
<!-- Each decision is BINDING. Do not revert without adding a superseding entry. -->
<!-- Agents: READ THIS FILE before changing any behavior. -->

---

## 2026-07-11 — Adopt 4-layer agent memory model
- **Decision:** Repo uses `AGENTS.md` entrypoint + `facts/` + `state/` + `runbooks/` + `sessions/`.
- **Rationale:** Large source files (`main.py` ~87 KB, `wake_proxy.py` ~47 KB, `README.md` ~43 KB) were starving agent context windows. See PR that introduced this file.
- **Do NOT:** revert to a README-only documentation model.

---

## 2026-07-11 — app/main.py to be decomposed into app/routes/*.py
- **Decision:** FastAPI routes will be split into per-domain `APIRouter` modules under `app/routes/`. `main.py` will become a thin app factory (~200 lines).
- **Rationale:** 2100-line `main.py` exceeds practical agent context budget and causes merge conflicts.
- **Do NOT:** add new endpoints to `main.py` after the refactor lands. New endpoints go in `app/routes/<domain>.py`.
- **Status:** planned (Layer B PR); handoff spec at `docs/AGENT_REFACTOR_HANDOFF.md`.

---

## 2026-07-11 — README.md is user-facing only
- **Decision:** `README.md` (~43 KB) is the end-user manual. Internal/agent documentation lives in `AGENTS.md`, `docs/`, `runbooks/`, and `app/_context/`.
- **Do NOT:** append agent instructions or architectural notes to `README.md`.

---

## 2026-07-11 — Restart=no in gamesrv@.service is intentional
- **Decision:** The game server template unit uses `Restart=no`.
- **Rationale:** `Restart=on-failure` masked every game-side crash by silently re-executing `start.sh`. With `Restart=no`, a crashed game stays in "failed" state — visible on the dashboard as ✕ failed — so operators see the actual exit reason. Per-server auto-restart can be added via a drop-in override.
- **Do NOT:** change to `Restart=on-failure` in the template unit without operator opt-in.

---

## 2026-07-11 — PrivateTmp=false in gamesrv@.service is intentional
- **Decision:** `PrivateTmp` is explicitly NOT set in the game server template unit.
- **Rationale:** Steam Runtime (used by Palworld, Satisfactory, ARK, Enshrouded) writes crash dumps and IPC pipes to `/tmp/`. A private `/tmp` namespace breaks `SteamAPI_Init()` silently — the game binds its port but Steam networking never comes up, causing "Connection timed out" for clients.
- **Do NOT:** add `PrivateTmp=true` to `gamesrv@.service`.

---

## 2026-07-11 — NoNewPrivileges=false in gamesrv-manager.service is intentional
- **Decision:** The manager service allows privilege escalation via `sudo`.
- **Rationale:** The firewall reconciler (`app/firewall.py`) must call `sudo /usr/sbin/ufw`. With `NoNewPrivileges=true`, sudo refuses entirely. The sudoers grant is deliberately narrow (only `/usr/sbin/ufw`).
- **Do NOT:** set `NoNewPrivileges=true` in `gamesrv-manager.service` unless the firewall path is changed to not use sudo.

---

## 2026-07-11 — wake_on_demand uses port + 10000 as internal offset
- **Decision:** When `wake_on_demand: true`, the proxy binds the public `port` and the game process binds `port + 10000` internally. Constant is `WAKE_INTERNAL_OFFSET = 10000` in `app/wake_proxy.py`.
- **Rationale:** Keeps the offset deterministic and avoids port conflicts with other game ports in common ranges.
- **Do NOT:** change `WAKE_INTERNAL_OFFSET` without regenerating all installed `start.sh` files (a reinstall of each wake-enabled server is required).
