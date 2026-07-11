# Runbook: Git Backup Failing

## Symptoms
- Dashboard shows git backup job failed.
- Job tail shows a git error or HTTP error message.
- No new commit appears in the backup repository.

## Log locations
- **Job tail**: Dashboard → server → Backup tab → job progress tail.
- **Manager journal**: `journalctl -u gamesrv-manager.service --since '30 min ago' | grep git_backup`

## Diagnostic commands
```bash
# Check GAMESRV_GITHUB_TOKEN is set
grep GAMESRV_GITHUB_TOKEN /etc/gamesrv.env

# Test token works (replace TOKEN)
curl -H "Authorization: token TOKEN" https://api.github.com/user

# Check backup root exists and has .tgz files
ls -la /opt/gamesrv/worlds/_backups/<name>/

# Verify git is installed
git --version

# Check server's git_backup config
grep -A5 'git_backup' /opt/gamesrv/servers/<name>.yml
```

## Common causes

### 1. No GitHub token configured
- **Symptom**: Job tail: "no GitHub token available — set GAMESRV_GITHUB_TOKEN in /etc/gamesrv.env"
- **Fix**: Generate a fine-grained GitHub PAT with `Contents: Read and write` scope for the target repo (or `repo` scope for auto-create). Add to `/etc/gamesrv.env` as `GAMESRV_GITHUB_TOKEN=ghp_...`. Restart manager.

### 2. PAT expired or revoked
- **Symptom**: HTTP 401 from GitHub API in job tail.
- **Fix**: Generate a new PAT, update `/etc/gamesrv.env`, restart manager.

### 3. No backup files to push
- **Cause**: `uploads.make_backup()` hasn't run yet or failed. The git backup module commits the existing `.tgz` files — if there are none, nothing is pushed.
- **Fix**: Run a backup first (Dashboard → Control → Backup). Verify `ls /opt/gamesrv/worlds/_backups/<name>/`.

### 4. Auto-create failed (no `repo_url` set)
- **Cause**: First-time push with blank `repo_url` and `provider: github`, but auto-create failed (insufficient PAT scope, rate limit, or network issue).
- **Symptom**: HTTP 422 or HTTP 403 from GitHub Create Repository API in job tail.
- **Fix**: Create the repo manually at `https://github.com/new` (private), paste the URL into `git_backup.repo_url` in the server YAML, save.

### 5. Diverged history (force-push needed)
- **Cause**: Backup repo was manually edited or reset.
- **Symptom**: `git push` fails with "Updates were rejected because the remote contains work that you do not have locally".
- **Fix**: Clone the repo, merge or reset manually, or delete and re-create it with a fresh `provisioned_at`.

## Related files/modules
- `app/git_backup.py` — `push()`
- `app/_context/git_backup.md` — full module summary
- `app/uploads.py` — `make_backup()` (creates the .tgz files)
- `facts/paths.yaml` — `backup_root`
