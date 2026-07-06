# Game Server Manager

A FastAPI-based dashboard + API for hosting and managing multiple game servers
(Minecraft Java, **Minecraft Forge (modded)**, Palworld / SteamCMD games, and
custom `.sh`-launched servers) inside a single Debian 12 unprivileged LXC on Proxmox.

Built to the plan in `docs/PLAN.md` — mirrors the Bot Manager LXC pattern
(systemd, venv, UFW LAN-lock, token auth, host-mount → bind-mount NFS for
persistent data on TrueNAS).

- **Servers run under systemd** (one instance of a template unit per game).
- **Manager itself is a systemd service** running as unprivileged `gamesrv`.
- **Console + graceful stop** work by launching each server inside a `tmux`
  session that the manager talks to via `tmux send-keys`.
- **Saves live on TrueNAS** (world_dir is a bind mount into the container).
- **Self-updates from GitHub** with branch auto-detect, ff-only pull, venv
  reinstall, health-check, and automatic rollback on failure.
- **Full server-data management**: upload/download files, back up worlds,
  restore backups, and update the game software itself (SteamCMD apps auto-
  update; Minecraft jars are uploaded through the UI).

---

## Table of contents

1. [Install (first time)](#install-first-time)
2. [How to use the dashboard](#how-to-use-the-dashboard)
3. [Adding your first server — Minecraft](#adding-your-first-server--minecraft)
4. [Adding a Palworld (SteamCMD) server](#adding-a-palworld-steamcmd-server)
5. [Updating server data (jars, worlds, mods, configs)](#updating-server-data)
6. [Backing up and restoring worlds](#backing-up-and-restoring-worlds)
7. [Updating the manager itself](#updating-the-manager-itself)
8. [Troubleshooting](#troubleshooting)
9. [Repository layout](#repository-layout)

Additional docs:
- [docs/USAGE.md](docs/USAGE.md) — deep-dive on every UI tab + every API endpoint.
- [docs/ADDING_SERVERS.md](docs/ADDING_SERVERS.md) — YAML schema and how to add new game types.
- [docs/UPDATING_SERVER_DATA.md](docs/UPDATING_SERVER_DATA.md) — how to upload/replace server files safely.

---

## Install (first time)

**Prerequisites:** a Debian 12 unprivileged LXC with `nesting=1`, static LAN IP,
and a TrueNAS bind mount at `/opt/gamesrv/worlds` (see the plan §12 handoff and
the Bot Manager runbook for the `pct create` + fstab recipe).

Inside the LXC, as root:

```bash
# 1. Clone the app into /opt/gamesrv
cd /opt
git clone https://github.com/<you>/<this-repo>.git gamesrv
cd gamesrv

# 2. Run bootstrap. It creates the gamesrv user, installs deps, builds the
#    venv, installs the systemd units + polkit rule, and starts the manager.
sudo bash bootstrap.sh

# 3. LAN-lock with UFW (edit LAN_CIDR at the top of the script if needed)
sudo bash scripts/ufw-setup.sh
```

Bootstrap prints the generated bearer token. Save it. Then open the dashboard:

```
http://<LXC-IP>:8765/
```

Paste the token into the header, click **Save**. You're in.

> **Where does the token live?** `/etc/gamesrv.env`, mode `640 root:gamesrv`.
> Never commit it. Regenerate any time:
> `python3 -c 'import secrets;print(secrets.token_urlsafe(48))'`, edit the
> env file, then `sudo systemctl restart gamesrv-manager`.

---

## How to use the dashboard

The header has two pages:

- **Dashboard** — lists every registered server with its state, port, memory
  usage, uptime, and quick ▶ ■ ↻ buttons. Click a server's name to open the
  detail panel (six tabs, see below).
- **Admin** — where the bearer token lives and where the manager self-update
  is triggered. On first load with no token stored, the app lands here
  automatically.

### Admin page

| Section | What it does |
|---|---|
| **Authentication** | Paste `GAMESRV_TOKEN`, **Save**, **Test** (calls `/api/servers` to prove it works), **Forget token** to wipe it from `localStorage`. |
| **Manager Self-Update** | **Update Manager from GitHub** triggers `update.sh` (see §Updating the manager itself). The **follow** checkbox auto-refreshes `logs/update.log` every 3s so you can watch the pull → pip install → restart → health-check → (rollback on failure) sequence live. |
| **Manager Health** | Hits the unauthenticated `/healthz` endpoint — handy if the token itself is misbehaving. |

### Dashboard — server detail tabs

| Tab | What it does |
|---|---|
| **Control** | Start / Stop / Restart / Enable-on-boot / Disable-on-boot. Also **Install** (first-time provisioning / regenerate `start.sh` and `stop.sh`) and **Update Game Software** (Minecraft: verifies your uploaded jar; SteamCMD: re-runs `+app_update` to patch the game). |
| **Console** | Send a command to the running server (e.g. Minecraft `say hello`, `whitelist add Steve`, `op Steve`). Works because each server runs inside a `tmux` session the manager talks to. |
| **Logs** | Tails `journalctl -u gamesrv@<name>` — this is the game server's stdout/stderr. |
| **Files** | Browse, upload, download, and delete files inside `install_dir` (binaries, mods, config) or `world_dir` (saves — on TrueNAS). This is the primary way to **upload server data**. |
| **Backups** | Snapshot `world_dir` to a `.tgz` tarball under `worlds/_backups/<server>/`. Restore requires the server to be stopped first (safety). |
| **Definition** | The raw server YAML/JSON. Edit and save to change ports, memory cap, java args, etc. Re-run **Install** after changing anything the launcher uses. |

---

## Adding your first server — Minecraft

> **Modded (Forge) server?** Use `type: minecraft-forge` instead — the shape
> is different (Forge boots via `run.sh` + `user_jvm_args.txt`, not
> `java -jar server.jar`). See
> [docs/ADDING_SERVERS.md §6](docs/ADDING_SERVERS.md#6-modded-minecraft-forge-specifics)
> and [servers/minecraft-forge-smp.example.yml](servers/minecraft-forge-smp.example.yml).
> The steps below cover **vanilla / Paper / Purpur** only.

1. **Create the definition.** In the dashboard click **+ New Server** and paste
   (edit values as needed):

   ```json
   {
     "name": "minecraft-smp",
     "type": "minecraft-java",
     "install_dir": "/srv/gameservers/minecraft-smp",
     "world_dir": "/opt/gamesrv/worlds/minecraft-smp",
     "port": 25565,
     "memory_mb": 6144,
     "java_args": "-XX:+UseG1GC",
     "stop_cmd": "stop",
     "auto_start_on_boot": true
   }
   ```

   (Or copy `servers/minecraft-smp.example.yml` → `servers/minecraft-smp.yml`
   on disk and reload the page.)

2. **Provision** — open the server, **Control** tab, click **Install**. This
   creates the dirs, writes `start.sh` + `stop.sh`, and symlinks `world` to
   `world_dir`.

3. **Upload your `server.jar`** — go to the **Files** tab, area = `install`,
   Upload → choose the jar you downloaded from
   [papermc.io](https://papermc.io/) / [purpurmc.org](https://purpurmc.org/) /
   [minecraft.net](https://www.minecraft.net/en-us/download/server), save as
   `server.jar`.

4. **Start once** — Control → **Start**. The server will exit immediately
   because Mojang's EULA hasn't been accepted yet.

5. **Accept the EULA** — Files tab, download `eula.txt`, change `eula=false`
   to `eula=true`, upload back with **overwrite** ticked. (Or on the LXC:
   `sudo -u gamesrv sed -i 's/false/true/' /srv/gameservers/minecraft-smp/eula.txt`.)

6. **Start again**, then optionally **Enable on Boot**.

7. Verify: from another machine, `mc --address <LXC-IP>:25565` or your
   Minecraft launcher.

---

## Adding a Palworld (SteamCMD) server

1. **Create the definition** (or copy `servers/palworld.example.yml`):

   ```json
   {
     "name": "palworld",
     "type": "steamcmd",
     "install_dir": "/srv/gameservers/palworld",
     "world_dir": "/opt/gamesrv/worlds/palworld",
     "port": 8211,
     "memory_mb": 16384,
     "steam_app_id": 2394010,
     "auto_start_on_boot": true
   }
   ```

2. **Install** (Control tab). This may take a while — it runs SteamCMD, which
   downloads several GB of Palworld server files, then writes the generated
   `start.sh` and symlinks `Pal/Saved` → `world_dir`.

3. **Configure** (optional) — Files tab, area = `install`, edit
   `Pal/Saved/Config/LinuxServer/PalWorldSettings.ini` (server name, password,
   difficulty, etc.). Palworld generates a default on first launch, so start
   once first if the file isn't there yet.

4. **Open the ports** — Palworld uses `8211/UDP` (game) and `27015/UDP` (Steam
   query). `scripts/ufw-setup.sh` opens these by default.

5. **Start** and **Enable on Boot**.

6. **To patch Palworld later**: Control tab → **Update Game Software**. That
   re-runs SteamCMD with `+app_update ... validate`.

---

## Updating server data

Preston explicitly asked for a good story here. There are three flavors:

- **Game software** (the server binary/jar itself) →
  - SteamCMD games (Palworld, Valheim, ARK, …): **Control → Update Game Software**.
  - Minecraft: **Files → Upload** a new `server.jar` (with `overwrite=true`) →
    **Control → Restart**.
- **Config, mods, plugins, custom launchers** → **Files** tab, area `install`.
  Uploading to `mods/foo.jar` creates subdirs as needed. Files stream in via a
  `.part` file and are atomically renamed, so a mid-upload crash never leaves
  a corrupt file behind.
- **World / save data** →
  - **Upload** into area `world` (e.g. import an existing world folder as a
    tarball then extract, or use SFTP for large trees).
  - **Download** the whole world by taking a **Backup** (Backups tab → **Back up
    world_dir now**) and downloading the `.tgz` from the Files tab
    (`_backups/<server>/` under the worlds root — or use the direct link in
    the Backups tab). See [docs/UPDATING_SERVER_DATA.md](docs/UPDATING_SERVER_DATA.md)
    for large-file / SFTP tips.

**Safety:** every path passed to the file API is joined against the server's
`install_dir` or `world_dir` and rejected if it tries to escape via `..` or an
absolute path. Uploads always stream to a `.part` file and get atomically
renamed. Backup restores extract into a staging dir first, and refuse to
process tar entries that would escape it.

---

## Backing up and restoring worlds

- **Backup**: Backups tab → **Back up world_dir now**. Creates
  `worlds/_backups/<server>/<server>-YYYYMMDD-HHMMSS.tgz` (world_dir → the
  TrueNAS bind mount, so backups themselves land on TrueNAS and get ZFS
  snapshots for free).
- **Restore**: **Stop** the server first. Backups tab → **restore** next to
  the snapshot. The existing world is renamed aside (`.<name>.replaced-<ts>`)
  rather than deleted, so you can undo by hand if you restored the wrong one.
- **Automation**: schedule with a systemd timer that curls
  `POST /api/servers/<name>/backup` (bearer token). Example in
  `docs/USAGE.md`.

---

## Updating the manager itself

Go to the **Admin** page → **Update Manager from GitHub** (tick **follow** to
watch the log tail live). Or from the LXC shell: `sudo bash /opt/gamesrv/update.sh`.

What that does (per plan §6):

1. Detects the repo's **default branch dynamically** (fixes the Bot Manager
   `main` vs `master` bug).
2. Records the current commit SHA as a rollback point.
3. Stashes any local edits so `git pull` can't fail on a dirty tree.
4. Fetches and does a **fast-forward-only** pull. If history has diverged,
   **aborts** — never force-resets over local state.
5. Reinstalls `requirements.txt` into the venv and smoke-tests imports.
6. Restarts `gamesrv-manager.service` and polls `/healthz`.
7. **On any failure**: `git reset --hard <saved SHA>`, reinstall those
   requirements, restart. The manager is never left down.

Auth for a private repo: set `GAMESRV_GITHUB_TOKEN` in `/etc/gamesrv.env`
(fine-grained PAT, Contents: Read-only, scoped to this repo only) and add it
to the git remote URL, e.g.:

```bash
sudo -u gamesrv git -C /opt/gamesrv remote set-url origin \
  https://x-access-token:${TOKEN}@github.com/<you>/<repo>.git
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401 Missing/invalid bearer token` in the UI | Paste `GAMESRV_TOKEN` from `/etc/gamesrv.env` and click Save. |
| `systemctl start gamesrv@<name>` says "not authorized" as `gamesrv` | Polkit rule not installed. Re-run `sudo bash bootstrap.sh`. |
| `ModuleNotFoundError: fastapi` on manager start | `run_manager.sh` is running the wrong Python. The launcher must call `.venv/bin/python`. Bootstrap fixes this; if you edited `run_manager.sh`, revert to the version in the repo. |
| Minecraft won't start, log says `You need to agree to the EULA` | See step 5 of the Minecraft add-server section. |
| Palworld install fails with "Missing lib32gcc" | `sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install lib32gcc-s1 steamcmd`. |
| Console tab says "tmux session not available" | The server isn't running, or `start.sh` was hand-edited to not use tmux. Re-run **Install** on the Control tab. |
| Restore fails with `refusing to delete server root` | You passed an empty path to the delete endpoint. Delete a specific file/dir instead. |
| Manager update fails with "history diverged" | Someone committed to the LXC's local checkout. `sudo -u gamesrv git -C /opt/gamesrv log --oneline @{u}..HEAD` to see the offending commits, then decide: keep, push, or `git reset --hard origin/<branch>` manually. |
| Manager port `8765` unreachable from your PC | Check `sudo ufw status`; `LAN_CIDR` may be wrong for your subnet. |

More detail in [docs/USAGE.md](docs/USAGE.md).

---

## Repository layout

```
Server_App/
├── app/                       FastAPI application
│   ├── main.py                routes
│   ├── config.py              env-backed settings
│   ├── auth.py                bearer token
│   ├── registry.py            server YAML CRUD
│   ├── control.py             systemctl / journalctl / tmux
│   ├── uploads.py             file upload / download / backup
│   ├── updater.py             self-update trigger
│   ├── types/                 minecraft-java, steamcmd, custom handlers
│   ├── templates/index.html   dashboard
│   └── static/                app.css + app.js
├── servers/                   *.example.yml (copy to *.yml to activate)
├── systemd/                   manager + template unit
├── scripts/                   polkit rule, ufw setup, .bat→.sh converter
├── docs/                      USAGE, ADDING_SERVERS, UPDATING_SERVER_DATA
├── bootstrap.sh               first-time / self-healing setup
├── update.sh                  self-update from GitHub (with rollback)
├── run_manager.sh             venv launcher (systemd ExecStart)
├── requirements.txt           pinned deps
└── .env.example               template for /etc/gamesrv.env
```
