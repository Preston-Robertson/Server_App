# USAGE — full reference

For the quick "how do I add my first server" path, start with the top-level
[README.md](../README.md). This doc is the deep reference for every UI tab
and every API endpoint.

## 1. Auth

Every `/api/*` endpoint requires:

```
Authorization: Bearer <GAMESRV_TOKEN>
```

The token comes from `/etc/gamesrv.env` (mode `660 root:gamesrv`). The
dashboard stores whatever you paste into `localStorage.gamesrv_token`.

There is no brute-force lockout — the actual perimeter is UFW LAN-lock. Do
not expose port 8765 to the internet. If you need remote access, put it
behind Tailscale/WireGuard or the reverse proxy described in the parent
repo's `docs/TODO.md` P1.

The Admin page's **Environment file** editor can rotate the token in place:
paste a new value into `GAMESRV_TOKEN`, Save, then click **Restart** in the
Manager Self-Update card. `Restart=always` on the systemd unit brings the
manager back with the new value.

## 2. Pages and tabs

The UI has two top-level pages selected from the nav in the header:

- **Dashboard** — server cards + per-server detail (seven tabs, below).
- **Admin** — Runtime info, Authentication, Self-Update + Restart, Env
  editor, Health probe.

Load the app with no token stored → you land on Admin automatically.

### Dashboard cards

Each server is one card in a responsive grid. State chip (green running,
amber starting/stopping, red failed, grey stopped), port chip, on-boot chip
if enabled, console chip if the tmux session exists, RAM usage bar,
uptime, inline ▶ ■ ↻ + Open →. Click the name (or Open) to open the detail
panel below the grid.

### Detail-panel tabs

#### Control
Buttons map 1:1 to `systemctl` verbs against `gamesrv@<name>.service`.
**Install** and **Update Game Software** run the per-type handler (see §5).

Includes the **Performance widget**: State / Uptime / RAM / CPU with SVG
sparklines (last 30 samples ≈ 2.5 min at 5 s poll). CPU% is computed on
the client from the delta of systemd's `cpu_usec` between polls. First
sample after opening shows `(collecting…)`. Sparkline colour goes amber
above 75%, red above 90%.

#### Console
Recent server output above a command input. Follow (auto-refresh) is on by
default; **Send** or Enter posts to `/api/servers/<name>/console` which
runs `tmux send-keys -t gs-<name> <cmd> Enter`. The pane auto-refreshes
~400 ms after send so you see the reply. Newlines in a single command are
rejected — one command per send.

Examples:
- Minecraft: `say Server restart in 5 minutes`, `whitelist add PrestonR`,
  `op PrestonR`, `stop`.
- Palworld: use the in-game admin console; Palworld's stdout isn't
  interactive.

#### Logs
Tails `journalctl -u gamesrv@<name>` (up to 2000 lines). Follow checkbox
enables 2 s auto-refresh, auto-scrolling only when you're already at the
bottom.

Manager's own log (from a shell):

```bash
sudo journalctl -u gamesrv-manager -f
```

Updater log:

```bash
sudo journalctl -u gamesrv-updater -f
# or the file the UI reads:
tail -f /opt/gamesrv/logs/update.log
```

#### Files
Two "areas":

- `install` → the server's `install_dir` (binaries, mods, config, launchers).
- `world`   → the server's `world_dir` (saves — on the TrueNAS bind mount).

**Dropzone** takes three flavours of input:

- **Drop a file / files / a folder** — walked recursively with
  `webkitGetAsEntry()`, subpaths preserved.
- **+ Files** picker — multi-select.
- **+ Folder** picker — `webkitdirectory`, preserves relative paths.
- **+ Archive** picker — one `.zip` / `.tar.gz` / `.tgz` / `.tar` / `.tar.bz2`;
  server-side extraction into the area (or `Save under: <subdir>`).

Options: **Save under** (path prefix), **overwrite existing** (off by
default), **extract archives on the server** (on by default — governs whether
a dropped `.tgz` becomes a single file or is unpacked).

Per-file **progress rows** below the dropzone go green on success, red with
the error message on failure. Uploads are sequential.

Every path is joined through `_safe_join()` (rejects `..` and absolute paths).
Uploads stream to `<name>.part` then atomically rename. Archive extraction
stages in a scratch dir and refuses entries that escape it or contain
symlinks/device/hardlink members. `overwrite=true` on the extract endpoint
requires a `dest_subdir` — refuses to wipe the area root.

#### Git
Optional. Configure a `git_source` block per server (see §7).

Buttons:

- **Save Git Source** — write the fields into the server def.
- **Check remote** — `git ls-remote` for the configured ref, no clone.
  Shows an `update available → <shortsha>` chip if the remote has moved.
- **Pull & deploy** — clone/pull into `<install_dir>.gitsrc/` cache,
  checkout ref, rsync into `install_dir` (and `world_dir` if
  `world_subdir` is set). Writes `deployed_sha`/`ref`/`at` back to the
  YAML.
- **Dry run** — same as sync but skips the rsync step.
- **Clear cache** — delete the `.gitsrc/` dir. Next sync = full clone.

**PAT for this sync** field: paste a fine-grained PAT for private repos;
never persisted; cleared after each sync.

#### Backups
- **Back up world_dir now** → `POST /api/servers/<name>/backup` →
  `worlds/_backups/<name>/<name>-YYYYMMDD-HHMMSS.tgz`.
- **restore** → `POST /api/servers/<name>/restore` (`{"backup_name": "..."}`).
  Refused with 409 if the server is `active` — stop it first. Existing world
  is renamed to `.<name>.replaced-<ts>` rather than deleted.

#### Definition
Raw YAML rendered as JSON. Edit and **Save** to write `servers/<name>.yml`.
Fields that affect the launcher (`memory_mb`, `java_args`, `port`,
`start_cmd`) require **Install** on the Control tab to regenerate
`start.sh`.

## 3. API reference

All examples assume:

```bash
TOKEN=$(sudo grep '^GAMESRV_TOKEN=' /etc/gamesrv.env | cut -d= -f2-)
URL=http://10.0.0.204:8765
```

### Servers

```bash
# List + status
curl -H "Authorization: Bearer $TOKEN" $URL/api/servers

# Create / update
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"name":"palworld","type":"steamcmd","install_dir":"/srv/gameservers/palworld", ...}' \
     $URL/api/servers

# Lifecycle
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"action":"start"}' $URL/api/servers/minecraft-smp/action

# Console command
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"command":"say hello"}' $URL/api/servers/minecraft-smp/console
```

### Files

```bash
# List
curl -H "Authorization: Bearer $TOKEN" \
     "$URL/api/servers/minecraft-smp/files?area=install&path=mods"

# Upload single file
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -F "file=@./server.jar" -F "area=install" -F "path=server.jar" -F "overwrite=true" \
     $URL/api/servers/minecraft-smp/files

# Upload + extract archive
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -F "file=@./modded-pack.tgz" -F "area=install" -F "dest_subdir=" -F "overwrite=false" \
     $URL/api/servers/minecraft-smp/files/extract

# Download
curl -H "Authorization: Bearer $TOKEN" -o world.tgz \
     "$URL/api/servers/minecraft-smp/files/download?area=world&path=."
```

### Backups

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" $URL/api/servers/minecraft-smp/backup
curl        -H "Authorization: Bearer $TOKEN" $URL/api/servers/minecraft-smp/backups
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"backup_name":"minecraft-smp-20260706-140000.tgz"}' \
     $URL/api/servers/minecraft-smp/restore
```

### Git source

```bash
# Sync (with optional PAT for private repos)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"dry_run":false,"token":"github_pat_xxx"}' \
     $URL/api/servers/minecraft-forge-smp/git/sync

# Probe remote HEAD (no clone)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"token":"github_pat_xxx"}' \
     $URL/api/servers/minecraft-forge-smp/git/status
```

### Manager

```bash
# Trigger self-update (returns immediately; watch the log)
curl -X POST -H "Authorization: Bearer $TOKEN" $URL/api/manager/update
curl        -H "Authorization: Bearer $TOKEN" $URL/api/manager/update/log

# Restart (no code pull)
curl -X POST -H "Authorization: Bearer $TOKEN" $URL/api/manager/restart

# Runtime info
curl        -H "Authorization: Bearer $TOKEN" $URL/api/manager/info

# Env editor
curl        -H "Authorization: Bearer $TOKEN" $URL/api/manager/env
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"updates":{"GAMESRV_PORT":"8765"}}' \
     $URL/api/manager/env
```

## 4. Systemd units

Three units come with the app:

- `gamesrv-manager.service` — the FastAPI manager. `Type=simple`,
  `Restart=always`, runs as `gamesrv`.
- `gamesrv@.service` — template unit; each game server is one instance
  (`gamesrv@minecraft-smp`, `gamesrv@palworld`). Per-instance
  `MemoryMax=8G` backstop; override per instance with:

  ```bash
  sudo systemctl edit gamesrv@palworld
  # [Service]
  # MemoryMax=20G
  ```

- `gamesrv-updater.service` — `Type=oneshot`, runs as **root**. Triggered
  by the manager via polkit (`systemctl start --no-block …`). Runs
  `update.sh` in its own cgroup so the manager restart at the end doesn't
  kill it mid-run.

Reload after editing units: `sudo systemctl daemon-reload`.

## 5. Per-type handlers

### `minecraft-java`
- Generates `start.sh` (foreground `tmux` wrapping
  `java -Xms -Xmx -jar server.jar nogui`) and `stop.sh` (sends `say ...` +
  `stop`, waits up to 60 s).
- Symlinks `install_dir/world` → `world_dir`.
- Does NOT auto-download `server.jar`. Upload via the Files tab so you pick
  the flavour (Vanilla, Paper, Purpur, …).
- **Do NOT use this type for modern Forge (1.17+).** Use `minecraft-forge`.

### `minecraft-forge`
- For modded Forge on 1.17+ (yes, 1.20.1). Launches Forge's own `run.sh`
  inside tmux (foreground) and writes `-Xms`/`-Xmx` into
  `user_jvm_args.txt` (Forge reads that file, not any `-Xmx` on argv).
- Symlinks `install_dir/world` → `world_dir`.
- Refuses to auto-accept Mojang's EULA — edit `eula.txt` → `eula=true`.
- Optional `mc_version` field enables the Java-version sanity check:
  1.20.x needs Java 17, 1.21.x needs Java 21. Warn loudly on a mismatch
  (Forge 1.20.1 does not run on Java 21).
- No auto-download of Forge itself — upload the installer's output tree
  (or use the Git tab). **Update Game Software** just regenerates the
  launcher + `user_jvm_args.txt`; mod/Forge updates are manual.

### `steamcmd`
- Requires `steam_app_id`. Runs
  `steamcmd +force_install_dir <install_dir> +login anonymous +app_update <id> validate +quit`.
- For known apps (Palworld 2394010, Valheim 896660) generates a proper
  `start.sh`. For unknown apps, extend `_APP_RECIPES` in
  `app/types/steamcmd.py`.
- Symlinks the game's save dir onto `world_dir`.

### `custom`
- You provide `install_dir/start.sh` (must launch inside
  `tmux new-session -s gs-<name> -n game "..."`) and optional `stop.sh`.
- Handy for anything not covered above, or after converting a `.bat` with
  `scripts/convert_bat_to_sh.py`.

## 6. Scheduled backups

Example: nightly Minecraft backup at 04:00.

```ini
# /etc/systemd/system/gamesrv-backup-minecraft.service
[Unit]
Description=Nightly Minecraft world backup
[Service]
Type=oneshot
EnvironmentFile=/etc/gamesrv.env
ExecStart=/usr/bin/curl -fsS -X POST \
  -H "Authorization: Bearer ${GAMESRV_TOKEN}" \
  http://127.0.0.1:${GAMESRV_PORT}/api/servers/minecraft-smp/backup
```

```ini
# /etc/systemd/system/gamesrv-backup-minecraft.timer
[Unit]
Description=Nightly Minecraft world backup timer
[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true
[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gamesrv-backup-minecraft.timer
```

## 7. Git-source deep dive

Full schema in [ADDING_SERVERS.md](ADDING_SERVERS.md). Key facts:

- **Cache location**: `<install_dir>.gitsrc/` — sibling of install_dir.
  Design choice: the runtime dir never sees `.git`.
- **Sync semantics**:
  1. `git clone --no-checkout` first time, `git fetch --all --prune --tags` after.
  2. `git checkout -f --detach origin/<ref>` (or the raw ref).
  3. `rsync -a --delete-excluded` from cache into `install_dir`. Default
     excludes: `.git`, `.github`, `logs`, `*.log`, `world`, `world_nether`,
     `world_the_end`. `--delete-excluded` only removes files matching an
     exclude pattern — hand-uploaded files not in the repo are preserved.
  4. If `world_subdir` is set, separately rsync into `world_dir`.
  5. Record `deployed_sha`/`ref`/`at` in the YAML.
- **Auth**: `x-access-token:<PAT>@host` injected into URL for one fetch,
  scrubbed from `.git/config` immediately after. PAT is either
  per-request (Git tab field, not persisted) or from an env var
  (`token_env`).
- **Local git servers** (Gitea/Forgejo/GitLab): change the URL, hit
  **Save Git Source** → **Pull & deploy**. Nothing else to change.

## 8. Security notes

- Manager runs as `gamesrv`; polkit rule `49-gamesrv.rules` grants
  systemctl verbs only on `gamesrv@*.service` and `start` on
  `gamesrv-updater.service`.
- `/etc/gamesrv.env` is `660 root:gamesrv`. Secrets never leave that file
  (except: git-source PATs may be entered per-request; those aren't
  persisted anywhere).
- Path traversal blocked in `app/uploads.py` (`_safe_join`).
- Backup restore + archive extraction: staged then swapped, tarball members
  checked for escape/symlink/device.
- Console send rejects newlines to prevent multi-command injection.
- No arbitrary command execution endpoints. If you need a shell, SSH in.
