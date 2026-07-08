from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone


class PodiumOAuthMixin:
    async def create_oauth_state(self, workspace_id: str) -> str:
        token = secrets.token_urlsafe(32)
        expires_at = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
        await self.store.save_oauth_state(token, workspace_id=workspace_id, expires_at=expires_at)
        return token

    async def consume_oauth_state(self, state: str) -> str | None:
        return await self.store.consume_oauth_state(state)
