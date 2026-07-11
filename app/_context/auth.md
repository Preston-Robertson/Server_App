# app/_context/auth.md
# Context summary for app/auth.py (23 lines).

## Purpose
****** validation for all `/api/*` endpoints: checks the `Authorization: ****** header against `settings.token` using a constant-time comparison.

## Public API
- `require_token(authorization: str | None = Header(default=None)) -> None`
  FastAPI dependency; raises `HTTPException` on failure. Used as `Depends(require_token)`.

## Called by
`app/main.py` — injected as `dependencies=[Depends(require_token)]` on every authenticated route.

## Calls / depends on
`app.config.settings` (for `settings.token`), `fastapi`, `hmac.compare_digest`.

## Key invariants / gotchas
- **Constant-time comparison**: uses `hmac.compare_digest` to prevent timing attacks on token comparison.
- **No brute-force lockout**: intentional. Real protection is UFW LAN-lock (see `scripts/ufw-setup.sh`). The API is intended to be LAN-only.
- **HTTP 503 if token not configured**: if `settings.token` is empty (e.g. `GAMESRV_TOKEN` not set in env file), all API calls return 503 with a descriptive message.
- **HTTP 401 if missing or wrong**: missing header → 401 "Missing bearer token"; wrong token → 401 "Invalid token".
- **Case-insensitive "bearer " prefix check**: `authorization.lower().startswith("bearer ")`.

## Common failure modes
- 503 on all API calls: `GAMESRV_TOKEN` not set in `/etc/gamesrv.env` → `settings.token = ""`.
- 401 on valid token: trailing whitespace in the token value (stripped by `_env()` in config.py, so this shouldn't happen, but worth checking).

## Where to change what
- Add multi-user support or role-based auth: replace `require_token` here and update all `Depends()` references in `main.py`.
- Change from bearer token to API key header: change the `Header` parameter name.
