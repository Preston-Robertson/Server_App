# State: Current System Status
<!-- Living document. Agents MUST update this after any session that changes behavior. -->
<!-- Last updated: 2026-07-11 (initial scaffold) -->

| Subsystem | Health | Notes |
|---|---|---|
| FastAPI manager | 🟢 assumed working — not yet verified by agent baseline | `gamesrv-manager.service` |
| Dashboard UI | 🟢 assumed working — not yet verified by agent baseline | Jinja2 template at `app/templates/index.html` |
| control (start/stop/restart) | 🟢 assumed working — not yet verified by agent baseline | `app/control.py`; wraps `systemctl` + `tmux` |
| wake_proxy (wake-on-demand) | 🟢 assumed working — not yet verified by agent baseline | `app/wake_proxy.py`; UDP + TCP paths |
| watchdog (idle-shutdown) | 🟢 assumed working — not yet verified by agent baseline | `app/watchdog.py`; A2S + SLP probes every 15 s |
| firewall (UFW reconcile) | 🟢 assumed working — not yet verified by agent baseline | `app/firewall.py`; requires sudoers drop-in |
| git_source (config pull) | 🟢 assumed working — not yet verified by agent baseline | `app/git_source.py` |
| git_backup (offsite push) | 🟢 assumed working — not yet verified by agent baseline | `app/git_backup.py` |
| updater (self-update) | 🟢 assumed working — not yet verified by agent baseline | `app/updater.py` + `gamesrv-updater.service` |
| uploads (file up/download) | 🟢 assumed working — not yet verified by agent baseline | `app/uploads.py` |
| env_file (admin editor) | 🟢 assumed working — not yet verified by agent baseline | `app/env_file.py` |
| registry (YAML parser) | 🟢 assumed working — not yet verified by agent baseline | `app/registry.py`; Pydantic validation |
| config (settings) | 🟢 assumed working — not yet verified by agent baseline | `app/config.py`; frozen dataclass |
| jobs (background tasks) | 🟢 assumed working — not yet verified by agent baseline | `app/jobs.py`; in-memory, resets on restart |
| perf (RAM sampler) | 🟢 assumed working — not yet verified by agent baseline | `app/perf.py`; 15 s interval, 24 h retention |
| auth (bearer token) | 🟢 assumed working — not yet verified by agent baseline | `app/auth.py` |
| steam_profiles (ID book) | 🟢 assumed working — not yet verified by agent baseline | `app/steam_profiles.py` |

> **Note:** This file is a living state doc; agents must update it after any session that changes behavior.
> Statuses are initialized to "assumed working" pending a first agent-run baseline verification.
