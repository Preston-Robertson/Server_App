# USAGE — full manual

This is the deep reference. For the quick "how do I add my first Minecraft
server" path, start with the top-level [README.md](../README.md).

## 1. Auth

Every `/api/*` endpoint requires a bearer token:

```
Authorization: Bearer <GAMESRV_TOKEN>
```

The token comes from `/etc/gamesrv.env`. The dashboard stores whatever you
paste into localStorage under `gamesrv_token`.

There is no brute-force lockout — the actual protection is UFW LAN-lock. Do
not expose port 8765 to the internet. If you need remote access, put it
behind Tailscale/WireGuard or the reverse proxy described in the parent repo's
`docs/TODO.md` P1.

## 2. Pages and tabs

The UI has two top-level pages selected from the nav in the header:

- **Dashboard** — servers list + per-server detail (six tabs, below).
- **Admin** — bearer token management, manager self-update (with a live
  log follower), and a one-click `/healthz` probe. Load the app with no
  token stored and you land here automatically.

### Dashboard tabs

### Control
Buttons map 1:1 to `systemctl` verbs against `gamesrv@<name>.service`.
**Install** and **Update Game Software** run the per-type handler (see §5).

### Console
POST to `/api/servers/<name>/console` with `{"command": "..."}`. The manager
runs `tmux send-keys -t gs-<name> <cmd> Enter`. Newlines in the command are
rejected — send one command per call.

Examples:
- Minecraft: `say Server restart in 5 minutes`, `whitelist add PrestonR`, `op PrestonR`, `stop`.
- Palworld: use the in-game admin console (RCON) instead — Palworld's stdout
  isn't interactive.

### Logs
Tails `journalctl -u gamesrv@<name>` (up to 2000 lines). This is the game
server's own stdout/stderr, not the manager's log.

Manager's own log:
```bash
sudo journalctl -u gamesrv-manager -f
```

### Files
Two "areas":
- `install` → the server's `install_dir` (binaries, mods, config, launchers).
- `world`   → the server's `world_dir` (saves — on the TrueNAS bind mount).

All operations validate paths so you cannot escape the area root. Uploads
stream to `<name>.part` and get atomically renamed on completion.

### Backups
- **Back up world_dir now** → `POST /api/servers/<name>/backup` → creates
  `worlds/_backups/<name>/<name>-YYYYMMDD-HHMMSS.tgz`.
- **restore** → `POST /api/servers/<name>/restore` with `{"backup_name": "..."}`.
  Refused with 409 if the server is `active` — stop it first.

### Definition
The server's YAML rendered as JSON. Edit and **Save Definition** to write it
back to `servers/<name>.yml`. Fields that affect the launcher (memory_mb,
java_args, port, start_cmd) don't take effect until you click **Install**
again on the Control tab to regenerate `start.sh`.

## 3. API reference

All examples assume `TOKEN=$(sudo grep GAMESRV_TOKEN /etc/gamesrv.env | cut -d= -f2)`
and manager URL `http://10.0.0.203:8765`.

```bash
# list servers + status
curl -H "Authorization: Bearer $TOKEN" http://10.0.0.203:8765/api/servers

# start / stop / restart / enable / disable
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"action":"start"}' http://10.0.0.203:8765/api/servers/minecraft-smp/action

# console command
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"command":"say hello"}' http://10.0.0.203:8765/api/servers/minecraft-smp/console

# upload a file
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -F "file=@./server.jar" -F "area=install" -F "path=server.jar" -F "overwrite=true" \
     http://10.0.0.203:8765/api/servers/minecraft-smp/files

# download a file
curl -H "Authorization: Bearer $TOKEN" -o world.tgz \
     "http://10.0.0.203:8765/api/servers/minecraft-smp/files/download?area=world&path=."

# backup
curl -X POST -H "Authorization: Bearer $TOKEN" \
     http://10.0.0.203:8765/api/servers/minecraft-smp/backup

# trigger self-update (returns immediately; watch the log endpoint)
curl -X POST -H "Authorization: Bearer $TOKEN" \
     http://10.0.0.203:8765/api/manager/update
curl -H "Authorization: Bearer $TOKEN" \
     http://10.0.0.203:8765/api/manager/update/log
```

## 4. Systemd

- Manager: `gamesrv-manager.service`
- Games: `gamesrv@<name>.service` (template unit)
- Reload after editing units: `sudo systemctl daemon-reload`

Per-server memory backstop is set on the template unit (`MemoryMax=8G`). To
raise it per-instance, create a drop-in:

```bash
sudo systemctl edit gamesrv@palworld
# [Service]
# MemoryMax=20G
```

## 5. Per-type handlers

### `minecraft-java`
- Generates `start.sh` (foreground `tmux` wrapping `java -Xms -Xmx -jar server.jar nogui`)
  and `stop.sh` (sends `say ...` + `stop` to the tmux session, waits up to 60s).
- Symlinks `install_dir/world` → `world_dir`.
- Does NOT auto-download `server.jar`. Upload it via the Files tab so you
  pick the flavor (Vanilla, Paper, Purpur, …).
- **Do NOT use this type for modern Forge (1.17+).** Use `minecraft-forge`.

### `minecraft-forge`
- For modded Forge on 1.17+ (yes, 1.20.1). Launches Forge's own `run.sh`
  inside tmux (foreground) and writes `-Xms` / `-Xmx` into
  `user_jvm_args.txt` (Forge reads that file, not any `-Xmx` on argv).
- Symlinks `install_dir/world` → `world_dir`.
- Refuses to auto-accept Mojang's EULA — edit `install_dir/eula.txt` to
  `eula=true` before starting.
- Optional `mc_version` field enables a Java-version sanity check:
  1.20.x needs Java 17, 1.21.x needs Java 21. Handler warns loudly on a
  mismatch (Forge 1.20.1 will not run on Java 21).
- No auto-download of Forge itself — upload the installer’s output tree
  (`mods/`, `config/`, `libraries/`, `run.sh`, `user_jvm_args.txt`) via
  the Files tab or SFTP. **Update Game Software** just regenerates the
  launcher + `user_jvm_args.txt`; mod/Forge updates are always manual.

### `steamcmd`
- Requires `steam_app_id`. Runs
  `steamcmd +force_install_dir <install_dir> +login anonymous +app_update <id> validate +quit`.
- For known apps (Palworld app 2394010, Valheim 896660) generates a proper
  `start.sh`. For unknown apps, edit `app/types/steamcmd.py` `_APP_RECIPES`
  to add yours, or set `type: custom` and write your own `start.sh`.
- Symlinks the game's save dir onto `world_dir`.

### `custom`
- You provide `install_dir/start.sh` (must launch inside
  `tmux new-session -s gs-<name> -n game "..."`) and optional `stop.sh`.
- Handy if you converted a `.bat` with `scripts/convert_bat_to_sh.py`.

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

## 7. Security notes

- Manager runs as `gamesrv`; polkit rule `49-gamesrv.rules` grants it
  systemctl verbs only on `gamesrv@*.service`.
- `/etc/gamesrv.env` is `640 root:gamesrv`. Secrets never leave that file.
- Path traversal is blocked in `app/uploads.py` (`_safe_join`).
- Backup restore uses safe extraction (rejects tar members whose resolved
  path escapes the staging dir).
- Console send rejects newlines to prevent multi-command injection.
- No arbitrary command execution endpoints. If you need a shell, SSH in.
