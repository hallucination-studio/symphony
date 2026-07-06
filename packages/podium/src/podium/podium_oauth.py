from __future__ import annotations

import asyncio
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import FastAPI, WebSocket

from .store.postgres import PgStore
from .store.redis import RedisStore

from .podium_shared import (
    bearer_token,
    dispatch_public,
    hash_secret,
    sanitize_codex_profile,
    utc_now_iso,
    _datetime_from_json,
)

class PodiumOAuthMixin:
    async def create_oauth_state(self, workspace_id: str) -> str:
        token = secrets.token_urlsafe(32)
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=10)
        if self.redis_store is not None:
            await self.redis_store.save_oauth_state(token, workspace_id=workspace_id, ttl_seconds=600)
            return token
        if self.pg_store is not None:
            await self.pg_store.save_oauth_state(
                token,
                workspace_id=workspace_id,
                expires_at=expires_at.isoformat().replace("+00:00", "Z"),
            )
            return token
        self.durable.oauth_states[token] = {
            "workspace_id": workspace_id,
            "created_at": utc_now_iso(),
            "expires_at": expires_at,
        }
        self.persist()
        return token

    async def consume_oauth_state(self, state: str) -> str | None:
        if self.redis_store is not None:
            return await self.redis_store.consume_oauth_state(state)
        if self.pg_store is not None:
            return await self.pg_store.consume_oauth_state(state)
        row = self.durable.oauth_states.pop(state, None)
        self.persist()
        if not isinstance(row, dict):
            return None
        expires_at = row.get("expires_at")
        if isinstance(expires_at, str):
            expires_at = _datetime_from_json(expires_at)
        if isinstance(expires_at, datetime) and expires_at < datetime.now(timezone.utc):
            return None
        return str(row.get("workspace_id") or "") or None

