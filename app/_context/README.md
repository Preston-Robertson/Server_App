# app/_context/README.md
# Index of per-module context summaries.
# Read this before opening any large source file.
# Each summary is ~250 words: Purpose, Public API, Called by, Calls/depends on,
# Key invariants, Common failure modes, Where to change what.

| File | Module | One-line description |
|---|---|---|
| `main.md` | `app/main.py` | FastAPI entrypoint: all HTTP routes, startup hooks, dashboard |
| `control.md` | `app/control.py` | systemctl / journalctl / tmux wrappers for server lifecycle |
| `wake_proxy.md` | `app/wake_proxy.py` | UDP+TCP proxy that wakes sleeping servers on first player packet |
| `watchdog.md` | `app/watchdog.py` | Idle-shutdown watchdog: polls player counts, stops empty servers |
| `firewall.md` | `app/firewall.py` | UFW reconciler: manages per-server port rules tagged gamesrv-auto |
| `registry.md` | `app/registry.py` | Parses/validates server definition YAMLs via Pydantic models |
| `config.md` | `app/config.py` | Frozen Settings dataclass loaded from env vars on startup |
| `auth.md` | `app/auth.py` | ****** validation for all /api endpoints |
| `uploads.md` | `app/uploads.py` | File upload/download + backup archive creation and restore |
| `git_source.md` | `app/git_source.py` | Pulls server config files from a git remote into install_dir |
| `git_backup.md` | `app/git_backup.py` | Pushes local backup .tgz files to a private GitHub repo |
| `updater.md` | `app/updater.py` | Self-update trigger: delegates to gamesrv-updater.service oneshot |
| `jobs.md` | `app/jobs.py` | In-memory background job registry for long-running install/update ops |
| `perf.md` | `app/perf.py` | Background RAM sampler: 15 s interval, 24 h ring buffer |
| `env_file.md` | `app/env_file.py` | Line-based read/write of /etc/gamesrv.env for admin UI |
| `steam_profiles.md` | `app/steam_profiles.py` | steamID64 → display name address book (JSON file, optional lookup) |
