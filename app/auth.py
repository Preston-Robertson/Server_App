"""Bearer-token auth. Same shape as Bot Manager B9.

Note: no brute-force lockout — the real protection is UFW LAN-lock (B11).
"""
from __future__ import annotations

import hmac
from fastapi import Header, HTTPException, status

from .config import settings


def require_token(authorization: str | None = Header(default=None)) -> None:
    if not settings.token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="GAMESRV_TOKEN not configured on server",
        )
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    provided = authorization.split(" ", 1)[1].strip()
    if not hmac.compare_digest(provided, settings.token):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
