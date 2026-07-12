# State: Current System Status
<!-- Living document. Agents MUST update this after any session that changes behavior. -->
<!-- Last updated: 2026-07-11 (post Palworld/Satisfactory debugging + diagnostics session) -->

## Honest audit (2026-07-11)
The long "Palworld is broken" saga was, in the end, mostly **reporting/diagnostic gaps that made a
working system look broken** — not architectural rot. Palworld installs, launches (native Linux
SteamCMD), binds its port, loads its world, and is **connectable on the LAN**. The single genuine
open blocker is environmental: **ufw cannot program netfilter inside this unprivileged LXC**, so the
"public" firewall mode can't be enforced from in-container (a host/router decision, not a code bug).

| Subsystem | Health | Notes |
|---|---|---|
| FastAPI manager | 🟢 working | `gamesrv-manager.service` |
| Dashboard UI | 🟢 working | network panel now has LXC-ufw / Public / Query columns |
| control (start/stop/restart) | 🟢 verified | start/stop confirmed; RAM now read from cgroup (accurate) |
| wake_proxy (wake-on-demand) | 🟢 working | UDP + TCP relay |
| watchdog (readiness/idle) | 🟢 improved | Palworld→REST player probe; port-bound readiness fallback for no-A2S games |
| firewall (UFW reconcile) | 🟡 LAN ok / PUBLIC blocked | ufw can't write netfilter in unprivileged LXC; reconcile now surfaces the real ufw error |
| git_source / git_backup | 🟢 working | unchanged |
| updater (self-update) | 🟢 working | `gamesrv-updater.service` |
| uploads (file up/download) | 🟢 working | file browser confirmed in use |
| env_file (admin editor) | 🟢 working | |
| registry (YAML parser) | 🟢 working | Pydantic; firewall.mode validates lan/public/allowlist |
| config editing (per-game) | 🟢 fixed | Palworld PalWorldSettings.ini now seeded from Default when empty |
| Palworld (steamcmd) | 🟢 connectable (LAN) | native Linux; REST API enabled for player count + steamID allowlist kick |
| Satisfactory (steamcmd) | 🟡 verify | FactoryGame.log now surfaced in Console/Diagnose; confirm HTTPS API vs noise |
| jobs / perf / auth / steam_profiles | 🟢 working | unchanged |

## Fixed this session
- Readiness false-negative (dashboard stuck "starting" on a live server) — watchdog port-bound + REST probe.
- tmux split env deltas — restored `XDG_RUNTIME_DIR` + `HOME`; native games run direct-exec-capable (toggle).
- Empty `PalWorldSettings.ini` — config writer now seeds from `DefaultPalWorldSettings.ini` + ensures keys.
- Palworld player count + steamID allowlist — via Palworld REST API (fail-open kick enforcer).
- ufw reconcile silently reporting success — now returns `ok`/`rules_failed`/`errors` with the real ufw text.
- Satisfactory log path (`.config/Epic/FactoryGame/Saved/Logs`) — now discovered by Console + Diagnose.

## Open (see NEXT_ACTIONS.md)
1. **Public firewall in unprivileged LXC** — ufw can't enforce; decide host-side rules vs container capability.
2. **CGNAT** — confirm ISP isn't carrier-NATing (public play impossible if so; not a manager issue).
3. **Satisfactory** — read the now-visible FactoryGame.log to confirm real failure vs noise.

> **Note:** Living state doc — agents must update after any behavior change.
