# Game Server Manager

A FastAPI-based dashboard + API for hosting and managing multiple game servers
inside a single Debian 12 unprivileged LXC on Proxmox.

Supported server types out of the box:

- **`minecraft-java`** — Vanilla / Paper / Purpur (single `server.jar`).
- **`minecraft-forge`** — Modded Forge 1.17+ (yes, 1.20.1). Launches Forge's
  own `run.sh` inside `tmux`, writes `-Xms`/`-Xmx` into `user_jvm_args.txt`,
  warns if `mc_version` and the installed Java disagree.
- **`steamcmd`** — anything anonymously installable via SteamCMD
  (Palworld, Valheim, ARK, 7DTD, …). Palworld is a first-class recipe.
- **`custom`** — bring your own `start.sh`.

Every server runs under a shared systemd template unit (one instance per
game). The manager itself is a systemd service running as unprivileged
`gamesrv`. Console + graceful stop work because each game launches inside a
`tmux` session the manager talks to.

Design borrows heavily from the sibling
[luigi-web](https://github.com/Preston-Robertson/To_Do_List) app so both
apps feel like siblings when you switch tabs.

---

## Table of contents

1. [Install (first time)](#install-first-time)
2. [How to use the dashboard](#how-to-use-the-dashboard)
3. [Creating your first server](#creating-your-first-server)
   - [Minecraft — Vanilla / Paper](#minecraft--vanilla--paper)
   - [Minecraft — Forge (modded)](#minecraft--forge-modded)
   - [Palworld (SteamCMD)](#palworld-steamcmd)
4. [Uploading server data](#uploading-server-data)
5. [Pulling server data from git](#pulling-server-data-from-git)
6. [Backups and world data](#backups-and-world-data)
7. [Live logs, console, and performance](#live-logs-console-and-performance)
8. [The Admin page](#the-admin-page)
9. [Manager self-update](#manager-self-update)
10. [Troubleshooting](#troubleshooting)
11. [Repository layout](#repository-layout)
12. [API reference (short)](#api-reference-short)
13. [Security posture](#security-posture)

Additional docs in [docs/](docs/):

- [docs/USAGE.md](docs/USAGE.md) — deep-dive on every UI tab + every API endpoint.
- [docs/ADDING_SERVERS.md](docs/ADDING_SERVERS.md) — YAML schema and how to add new game types.
- [docs/UPDATING_SERVER_DATA.md](docs/UPDATING_SERVER_DATA.md) — how to upload/replace server files safely.

---

## Install (first time)

**Prerequisites:** a Debian 12 unprivileged LXC with `nesting=1`, static LAN
IP, and (recommended) a TrueNAS bind mount at `/opt/gamesrv/worlds` so saves
land on ZFS-snapshot-protected storage. See the plan §12 handoff and the Bot
Manager runbook for the `pct create` + fstab recipe.

Inside the LXC, as root:

```bash
# 1. Clone the app into /opt/gamesrv
cd /opt
git clone https://github.com/Preston-Robertson/Server_App.git gamesrv
cd gamesrv

# 2. Run bootstrap. It creates the gamesrv user, installs deps (git, rsync,
#    python-venv, tmux, ufw, openjdk-17, steamcmd), builds the venv,
#    installs the three systemd units + polkit rule, chowns the checkout to
#    gamesrv, sets git config safe.directory + core.fileMode=false, and
#    starts the manager.
sudo bash bootstrap.sh

# 3. LAN-lock with UFW (edit LAN_CIDR at the top of the script if needed)
sudo bash scripts/ufw-setup.sh
```

Bootstrap prints the generated bearer token. Save it. Then open the dashboard:

```
http://<LXC-IP>:8765/
```

Land on the **Admin** page, paste the token, click **Save**. You're in.

> **Where does the token live?** `/etc/gamesrv.env`, mode `660 root:gamesrv`.
> Never commit it. The Admin page can rotate it — see
> [The Admin page](#the-admin-page).

---

## How to use the dashboard

The header has two pages:

- **Dashboard** — cards for every registered server plus a detail panel that
  slides open when you click one.
- **Admin** — Runtime info, Authentication, Self-Update + Restart, Environment
  file editor, Health probe.

### Dashboard — server cards

Each card shows:

- Name (click to open detail) + type in the subtitle.
- **State chip**, color-coded: green `● running`, amber `◐ starting` /
  `◑ stopping`, red `✕ failed`, grey `○ stopped`.
- Port chip and, if applicable, `on boot` and `console` chips.
- **RAM usage bar** with the numeric label under it (blue → amber >75% → red >90%).
- **Uptime**.
- Inline quick-actions: ▶ Start, ■ Stop, ↻ Restart, Open →.

The card currently open in the detail panel gets an accent border. **+ New
Server** in the header opens a modal (see [Creating your first
server](#creating-your-first-server)).

### Dashboard — server detail tabs

| Tab | What it does |
|---|---|
| **Control** | Start / Stop / Restart / Enable-on-boot / Disable. **Install** (regen `start.sh`/`stop.sh`). **Update Game Software** (SteamCMD: re-runs `+app_update`; Minecraft: verifies uploaded jar). Also renders the **Performance** widget — see [Live logs, console, and performance](#live-logs-console-and-performance). |
| **Console** | Recent server output above a command input. Sends via `tmux send-keys` to the game's session; auto-refreshes so you see the reply. |
| **Logs** | `journalctl -u gamesrv@<name>` tail with a **follow** checkbox for live streaming. |
| **Files** | Browse / upload / download / delete inside `install_dir` (binaries, mods, config) or `world_dir` (saves — on TrueNAS). Big dropzone with three pickers (files / folder / archive) and server-side archive extraction — see [Uploading server data](#uploading-server-data). |
| **Git** | Optional `git_source` block per server. Point at a repo (GitHub, or a future self-hosted Gitea/Forgejo/GitLab), pick a ref, hit **Pull & deploy** — see [Pulling server data from git](#pulling-server-data-from-git). |
| **Backups** | Snapshot `world_dir` to a `.tgz` tarball under `worlds/_backups/<server>/`. Restore requires the server stopped. |
| **Definition** | The raw YAML/JSON. Save writes to `servers/<name>.yml`. Re-run **Install** after changing launcher-affecting fields. |

---

## Creating your first server

Click **+ New Server**. The modal has:

- **Type dropdown** at top — picking one shows/hides the relevant fieldsets
  and pre-fills sensible defaults for port and memory (Palworld → 8211 / 16 GB,
  Forge → 25565 / 10 GB, Vanilla → 25565 / 4 GB).
- **Name** — validates against `[a-z][a-z0-9-]{1,31}` client-side.
- **Auto-derived paths** — as you type the name, `install_dir` becomes
  `/srv/gameservers/<name>` and `world_dir` becomes `/opt/gamesrv/worlds/<name>`
  unless you override.
- **Git source (optional)** — paste a repo URL and a PAT (for private repos)
  and the initial clone happens right after the def is saved.
- **Initial files (optional)** — three pickers (Files / Folder / Archive)
  that queue uploads to happen right after the def is saved.

After **Create Server**: (1) def is written to `servers/<name>.yml`, (2)
initial git clone runs if a URL was set, (3) queued files upload, (4)
detail panel opens.

### Minecraft — Vanilla / Paper

1. **+ New Server** → type `minecraft-java`, name `minecraft-smp`, memory
   `6144`, java_args `-XX:+UseG1GC`.
2. **Create Server** → detail panel opens.
3. **Control** → **Install** → generates `start.sh` + `stop.sh`, symlinks
   `world` → `world_dir`.
4. **Files** → area `install` → drop your `server.jar` (from
   [papermc.io](https://papermc.io/) / [purpurmc.org](https://purpurmc.org/) /
   [minecraft.net](https://www.minecraft.net/en-us/download/server)).
5. **Control** → **Start**. First start exits — it wrote `eula.txt`.
6. **Files** → download `eula.txt` → change `eula=false` to `eula=true` →
   upload back with overwrite.
7. **Start** again → **Enable on Boot**.

### Minecraft — Forge (modded)

Use `minecraft-forge` (not `minecraft-java` — modern Forge boots via `run.sh`,
not `java -jar server.jar`). See
[docs/ADDING_SERVERS.md §6](docs/ADDING_SERVERS.md) for the full walkthrough.
Sample YAML: [servers/minecraft-forge-smp.example.yml](servers/minecraft-forge-smp.example.yml).

1. **+ New Server** → type `minecraft-forge`, name `minecraft-forge-smp`,
   memory `10240`. In **Minecraft (Forge)** fieldset: `mc_version: 1.20.1`.
2. **Create Server**. The Forge handler will:
   - Write `user_jvm_args.txt` with `-Xms10240M -Xmx10240M`.
   - Generate `start.sh` (`./run.sh nogui` inside tmux) and `stop.sh`
     (sends `stop`, waits up to 120 s).
   - Symlink `install_dir/world` → `world_dir`.
   - Warn loudly if the installed `java -version` isn't 17 for 1.20.x.
3. Upload the Forge server tree (`mods/`, `config/`, `libraries/`, `run.sh`,
   `user_jvm_args.txt`, `server.properties`) via the **Files** tab
   (drop the folder or upload a `.tgz` archive) OR use the **Git tab** if you
   keep your server pack in a repo.
4. **Files** → edit `eula.txt` → `eula=true`.
5. **Control** → **Start** → **Enable on Boot**.

### Palworld (SteamCMD)

Sample YAML: [servers/palworld.example.yml](servers/palworld.example.yml).

1. **+ New Server** → type `steamcmd`, name `palworld`, memory `16384`,
   port `8211`, Steam App ID `2394010` (pre-filled).
2. **Create Server** → **Control** → **Install** (takes a while — several
   GB download).
3. **Files** → optional: edit
   `Pal/Saved/Config/LinuxServer/PalWorldSettings.ini` for server name /
   password / difficulty.
4. `scripts/ufw-setup.sh` opens **8211/UDP** and **27015/UDP** by default.
5. **Start** → **Enable on Boot**.
6. To patch Palworld later: **Control** → **Update Game Software** re-runs
   `steamcmd +app_update 2394010 validate`.

---

## Uploading server data

The **Files** tab has a dropzone that accepts three flavors of input:

| Method | What happens |
|---|---|
| **Drag a single file** or **+ Files** picker | Uploads to the area root (or `Save under: <subdir>`). |
| **Drag many files** or Ctrl+click in the picker | Uploads sequentially with per-file progress rows (green ok / red error). |
| **Drag a whole folder** or **+ Folder** picker | Recursively walks the directory (`webkitGetAsEntry`) and preserves subpaths. Drop `mods/` and every jar lands at `mods/<name>.jar`. |
| **Drag or pick a `.zip` / `.tar.gz` / `.tgz` / `.tar.bz2`** | With **extract archives on the server** ticked (default on), the archive is streamed to the LXC and unpacked in one HTTP round trip. **Much faster** than pushing thousands of mod jars individually. Untick to keep the archive as a single file instead. |

Options:

- **Area** — `install_dir` (binaries/config/mods) or `world_dir` (saves).
- **Save under** — subdirectory prefix (e.g. `mods` or
  `Pal/Saved/Config/LinuxServer`).
- **overwrite existing** — off by default.

Same three pickers appear inside the **New Server** modal under **Initial
files (optional)** so you can pre-populate a server at creation time.

**Safety guarantees:**

- Every path joined through `_safe_join()` — `..` and absolute paths are
  refused.
- Uploads stream to `<name>.part` and are atomically renamed on completion —
  a dropped connection never leaves a corrupt file.
- Archive extraction stages into a scratch dir first, refuses any entry that
  resolves outside staging, and refuses symlink/device members.
- `overwrite=true` on the extract endpoint requires a `dest_subdir` — you
  can't accidentally wipe an install dir.

Full details in [docs/UPDATING_SERVER_DATA.md](docs/UPDATING_SERVER_DATA.md).

---

## Pulling server data from git

Optional. Each server may declare a `git_source` block:

```yaml
git_source:
  url: https://github.com/you/your-server           # or git@host:you/repo, or Gitea URL later
  ref: main                                          # branch/tag/commit; blank = default branch
  subdir: ""                                         # if server files aren't at repo root
  world_subdir: world                                # copied into world_dir instead of install_dir
  token_env: MC_FORGE_GIT_PAT                        # env var name in /etc/gamesrv.env
  exclude: [logs, "*.log"]                           # extra exclude patterns
  deployed_sha: 7fd1a60b01f91b3...                   # written by sync; read by the UI
  deployed_ref: main
  deployed_at: 2026-07-06T21:23:59-0400
```

**Cache location:** the git tree lives in a sibling
`<install_dir>.gitsrc/` — the runtime install dir never has `.git` in it.

**Sync flow** (Git tab → **Pull & deploy**):

1. `git clone --no-checkout` first time, `git fetch --all --prune --tags` after.
2. `git checkout -f --detach origin/<ref>` (or the raw ref if a tag/SHA).
3. `rsync -a --delete-excluded` into `install_dir` respecting the default
   excludes (`.git`, `.github`, `logs`, `*.log`, `world`,
   `world_nether`, `world_the_end`) plus your `exclude:` list.
   `--delete-excluded` only removes files that match an exclude pattern —
   hand-uploaded files that aren't in the repo are preserved.
4. If `world_subdir` is set, that path is separately rsynced into `world_dir`.
5. `deployed_sha`/`ref`/`at` are written back into the server YAML.

**Auth for private repos:**

- Preferred: paste a fine-grained PAT (Contents: **Read only**) into the
  **PAT for this sync** field on the Git tab (or the New-Server modal).
  Used once, scrubbed from `.git/config` immediately after fetch,
  **never persisted**.
- Automated: put the PAT in `/etc/gamesrv.env` under any name (e.g.
  `MC_FORGE_GIT_PAT=github_pat_xxx`) and set `token_env` to that name.

**Update-available hint:** Git tab → **Check remote** does a `git ls-remote`
(no clone), compares to `deployed_sha`, and shows an amber chip if the
remote has moved past you.

**Ready for local git servers** (Gitea/Forgejo/GitLab): change the `url:`
to `https://gitea.lan:3000/you/your-server` and hit **Save Git Source** →
**Pull & deploy**. No code changes.

---

## Backups and world data

- **Backups tab** → **Back up world_dir now** creates
  `worlds/_backups/<server>/<server>-YYYYMMDD-HHMMSS.tgz`. Since
  `world_dir` sits on the TrueNAS bind mount, ZFS snapshots protect the
  backups for free.
- **Restore** requires the server **stopped** (409 otherwise). Existing
  world is renamed aside (`.<name>.replaced-<ts>`) rather than deleted, so
  you can undo by hand if you restored the wrong one.
- **Scheduling**: create a systemd timer that curls the API. Example in
  [docs/USAGE.md §6](docs/USAGE.md).

---

## Live logs, console, and performance

- **Logs tab** — tails `journalctl -u gamesrv@<name>` with an optional
  **follow** checkbox (2 s auto-refresh). Auto-scrolls only when you're
  already at the bottom, so scrolling up to inspect earlier lines doesn't
  yank you back down.
- **Console tab** — recent server output shown above the input; auto-refresh
  is **on by default**. Type a command → Enter (or **Send**) → the tmux
  session receives it and the pane refreshes within ~400 ms so you see the
  reply inline. Newlines rejected — one command per send.
- **Control tab → Performance widget** — four tiles: State, Uptime, current
  RAM (`used / cap %`), current CPU%. Two SVG sparklines showing the last
  30 samples (~2.5 minutes at 5 s poll). CPU% is computed on the client
  from the delta of `cpu_usec` between polls — first sample after opening
  shows `(collecting…)`. Sparkline colour shifts amber >75%, red >90%.

**Sparkline data is in-memory only** — refresh the page and history restarts.

---

## The Admin page

Five widgets, in order:

### Runtime

Read-only info: **Repo dir**, **Python** interpreter path + version, current
**git branch**, **git HEAD short SHA**, **last commit** message + timestamp,
**Manager unit** name, **Updater unit** name, **Env file** path.

### Authentication

Paste the bearer token from `/etc/gamesrv.env`, **Save**, **Test** (calls
`/api/servers` to prove it works), **Forget token** to wipe from
`localStorage`. On first load with no token stored, the app lands on Admin
automatically.

### Manager Self-Update

- **Update from GitHub** — triggers the oneshot updater (see next section).
- **Restart** — bounces the manager **without** pulling code. `os._exit(0)`
  runs; systemd (`Restart=always`) brings the manager back in a couple
  seconds. Handy after editing env values below. Game servers are
  unaffected — they run under their own units.
- **follow (auto-refresh)** — polls `/opt/gamesrv/logs/update.log` every
  3 s so you can watch the pull → pip install → restart → health-check →
  rollback-on-failure sequence live.

### Environment file

Reads/writes `/etc/gamesrv.env` (mode `660 root:gamesrv`, editable by the
manager after bootstrap). Two sections:

- **Managed keys** — schema with labels and help text. Grouped by section
  (Runtime, Auth, GitHub). Secret fields are `password` inputs with a
  👁 reveal toggle; **blank on save = keep current** so a stray Save
  doesn't wipe your token.
- **Extras** — any key already in the file that matches
  `MC_*`, `PALWORLD_*`, `VALHEIM_*`, `ARK_*`, `GAMESRV_*`, or `SERVER_*` is
  shown as editable (per-server RCON passwords, git PATs, etc.). Keys that
  don't match any pattern are shown read-only so you can see them but must
  SSH-edit them.

Rejected/unknown keys never get written. Save is atomic (sibling tempfile +
`os.replace`) when the parent dir is writable, falls back to an in-place
rewrite when only the file itself is writable. Comments and blank lines are
preserved. **Env is only read at startup** — hit the Restart button above
for changes to take effect.

### Manager Health

One-click probe of the unauthenticated `/healthz` endpoint — handy when the
token itself is misbehaving.

---

## Manager self-update

Admin → **Update from GitHub** (tick **follow** to watch the log tail live).
Or from the LXC shell: `sudo systemctl start gamesrv-updater.service`.

The button calls `POST /api/manager/update`, which does
`systemctl start --no-block gamesrv-updater.service` — a dedicated systemd
oneshot unit that runs [update.sh](update.sh) **as root, in its own cgroup**.
That matters because the manager restarts itself at the end of the update;
if `update.sh` shared a cgroup with the manager, systemd would kill it
mid-run.

What `update.sh` does (per plan §6):

1. Detects the repo's **default branch dynamically** (fixes the Bot Manager
   `main` vs `master` bug).
2. Records the current commit SHA as a rollback point.
3. Stashes local tracked-file edits (not `-u` — that would try to remove
   the `worlds/` mount).
4. Fetches and does a **fast-forward-only** pull. History divergence
   aborts; never force-resets.
5. Reinstalls `requirements.txt` into the venv, smoke-tests imports.
6. Restarts `gamesrv-manager.service`, polls `/healthz`.
7. **On any failure**: `git reset --hard <saved SHA>`, reinstall those
   requirements, restart. The manager is never left down.

**Auth for a private repo**: set `GAMESRV_GITHUB_TOKEN` on the Admin env
editor (or in `/etc/gamesrv.env`) and update the git remote URL:

```bash
sudo -u gamesrv git -C /opt/gamesrv remote set-url origin \
  https://x-access-token:${TOKEN}@github.com/<you>/<repo>.git
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401 Missing/invalid bearer token` in the UI | Admin → Authentication → paste `GAMESRV_TOKEN` from `/etc/gamesrv.env` → Save. |
| `systemctl start gamesrv@<name>` says "not authorized" as `gamesrv` | Polkit rule not installed. Re-run `sudo bash bootstrap.sh`. |
| **Update Manager button "runs" but nothing changes** | `systemctl status gamesrv-updater.service` and `journalctl -u gamesrv-updater.service -n 100`. Common causes: (a) unit not installed → re-run bootstrap; (b) polkit rule missing → same fix; (c) `/opt/gamesrv/.git` owned by root → bootstrap now chowns it; (d) private repo without a PAT → set `GAMESRV_GITHUB_TOKEN`. |
| **Restart button does nothing / manager doesn't come back** | The systemd unit still has `Restart=on-failure`. Re-run `sudo bash bootstrap.sh` — the unit gets `Restart=always` after that. |
| **Env editor Save says "file not writable"** | `/etc/gamesrv.env` still has old `640` mode. Re-run bootstrap; it nudges to `660 root:gamesrv`. |
| `git pull` says "your local changes would be overwritten" | `sudo -u gamesrv git -C /opt/gamesrv config core.fileMode false` then `git checkout -- <files>` on the shell scripts. Bootstrap sets this globally now. |
| `git stash` fails with "worlds/: Device or resource busy" | You're on an older `update.sh` that uses `stash -u`. Pull past commit `5c33552`. |
| `ModuleNotFoundError: fastapi` on manager start | `run_manager.sh` running the wrong Python. It must call `.venv/bin/python`. Bootstrap fixes this. |
| Minecraft won't start, log says `You need to agree to the EULA` | See Vanilla / Paper step 6. |
| Palworld install fails with "Missing lib32gcc" | `sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install lib32gcc-s1 steamcmd`. |
| Console tab says "tmux session not available" | The server isn't running, or `start.sh` was hand-edited to not wrap in tmux. Re-run **Install** on the Control tab. |
| Git sync says "could not read Username" | Private repo, no PAT. Paste one into the **PAT for this sync** field on the Git tab, or set `token_env`. |
| Manager update fails with "history diverged" | Someone committed to the LXC's local checkout. `sudo -u gamesrv git -C /opt/gamesrv log --oneline @{u}..HEAD` to see the offending commits, then decide. |

More detail in [docs/USAGE.md](docs/USAGE.md).

---

## Repository layout

```
Server_App/
├── app/                          FastAPI application
│   ├── main.py                   routes
│   ├── config.py                 env-backed settings
│   ├── auth.py                   bearer token
│   ├── registry.py               server YAML CRUD (+ GitSourceCfg)
│   ├── control.py                systemctl / journalctl / tmux
│   ├── uploads.py                file upload / download / archive extract / backup
│   ├── git_source.py             clone / fetch / rsync into install_dir
│   ├── env_file.py               schema-driven /etc/gamesrv.env editor
│   ├── updater.py                runtime info + restart + update log tail
│   ├── types/                    minecraft-java, minecraft-forge, steamcmd, custom
│   ├── templates/index.html      dashboard + admin
│   └── static/                   app.css + app.js (single-file client)
├── servers/                      *.example.yml (copy to *.yml to activate)
├── systemd/
│   ├── gamesrv-manager.service   FastAPI manager (Restart=always)
│   ├── gamesrv@.service          template unit for each game server
│   └── gamesrv-updater.service   root oneshot that runs update.sh
├── scripts/
│   ├── 49-gamesrv.rules          polkit — allow gamesrv narrow systemctl verbs
│   ├── ufw-setup.sh              LAN-lock
│   └── convert_bat_to_sh.py      .bat → .sh helper for Windows-only launchers
├── docs/                         USAGE, ADDING_SERVERS, UPDATING_SERVER_DATA
├── bootstrap.sh                  first-time / self-healing setup (idempotent)
├── update.sh                     self-update from GitHub (with rollback)
├── run_manager.sh                venv launcher (systemd ExecStart)
├── requirements.txt              pinned deps
├── .env.example                  template for /etc/gamesrv.env
├── .gitattributes                force LF on all Linux-run files
└── .gitignore
```

---

## API reference (short)

All `/api/*` endpoints require `Authorization: Bearer <GAMESRV_TOKEN>`.
`/healthz` is unauthenticated.

**Servers**

- `GET /api/servers` — list servers + status
- `POST /api/servers` — create/update a def (body: full ServerDef JSON)
- `GET /api/servers/{name}` — full detail (def + status + backups)
- `DELETE /api/servers/{name}` — remove def (does not delete files)
- `POST /api/servers/{name}/action` — start/stop/restart/enable/disable
- `POST /api/servers/{name}/install` — run type-handler install
- `POST /api/servers/{name}/update` — run type-handler update
- `POST /api/servers/{name}/console` — send a command
- `GET /api/servers/{name}/logs?lines=N` — journalctl tail

**Files**

- `GET /api/servers/{name}/files?area=install|world&path=...` — list dir
- `POST /api/servers/{name}/files` — upload a single file (multipart)
- `GET /api/servers/{name}/files/download?area=&path=` — download
- `DELETE /api/servers/{name}/files?area=&path=` — delete
- `POST /api/servers/{name}/files/extract` — upload+extract an archive

**Backups**

- `POST /api/servers/{name}/backup` — snapshot world_dir
- `GET /api/servers/{name}/backups` — list snapshots
- `POST /api/servers/{name}/restore` — restore (server must be stopped)

**Git source**

- `POST /api/servers/{name}/git/sync` — clone/pull and deploy (body: `{dry_run, token}`)
- `POST /api/servers/{name}/git/status` — probe remote HEAD (body: `{token}`)
- `GET /api/servers/{name}/git/status` — same, no token
- `POST /api/servers/{name}/git/clear-cache` — nuke the `.gitsrc` dir

**Manager**

- `GET /healthz` — unauthenticated
- `GET /api/manager/info` — runtime info (git, python, units, env path)
- `POST /api/manager/update` — trigger self-update oneshot
- `POST /api/manager/restart` — bounce the manager (no code pull)
- `GET /api/manager/update/log?lines=N` — update.log tail
- `GET /api/manager/env` — env editor payload
- `POST /api/manager/env` — save env changes (body: `{updates: {KEY: VAL}}`)

Full reference in [docs/USAGE.md](docs/USAGE.md).

---

## Security posture

- Manager binds LAN-only by default; **UFW** deny-in with LAN allow-list
  ([scripts/ufw-setup.sh](scripts/ufw-setup.sh)).
- Bearer token (`GAMESRV_TOKEN`) on every `/api/*` route. No brute-force
  lockout — UFW is the real perimeter. Do not expose the port to the
  internet without a reverse proxy + rate limiting.
- Manager runs as unprivileged `gamesrv`. The polkit rule
  ([scripts/49-gamesrv.rules](scripts/49-gamesrv.rules)) grants it only:
  - `start/stop/restart/reload/enable/disable` on `gamesrv@*.service`
  - `start` on `gamesrv-updater.service`
- `/etc/gamesrv.env` is `660 root:gamesrv` (manager can read + write via the
  Admin editor; other users can't).
- Path traversal blocked in `_safe_join()` for every file op.
- Archive extraction: staging dir first, reject entries that escape
  staging, reject symlink / device / hardlink members.
- Backup restore: same staged + safe extraction; refuses to run when the
  server is `active`.
- Console send rejects newlines to prevent multi-command injection.
- Git self-update: ff-only pulls, rollback on failure, oneshot in its own
  cgroup so it survives the manager restart.
- Git-source PATs: read from env var or per-request only, injected into the
  URL for one fetch, scrubbed from `.git/config` immediately after,
  never persisted to disk.
- No arbitrary shell endpoints. If you need one, SSH in.
