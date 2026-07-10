from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..podium_shared import _datetime_from_json


class JsonStoreAuthMixin:
    # Async app state API.
    async def next_user_id(self) -> str:
        return self._next_id("user_", "users.json")

    async def create_user(self, user_id: str, *, email: str, password_hash: str, created_at: str) -> dict[str, Any]:
        rows = self._load_map("users.json")
        user = {"id": user_id, "email": email, "password_hash": password_hash, "created_at": created_at}
        rows[user_id] = user
        self._write("users.json", rows)
        return dict(user)

    async def get_user(self, user_id: str) -> dict[str, Any] | None:
        row = self._load_map("users.json").get(user_id)
        return dict(row) if isinstance(row, dict) else None

    async def get_user_by_email(self, email: str) -> dict[str, Any] | None:
        for row in self._load_map("users.json").values():
            if isinstance(row, dict) and str(row.get("email") or "") == email:
                return dict(row)
        return None

    async def save_session(self, token_hash: str, *, user_id: str, expires_at: str) -> None:
        rows = self._load_map("sessions.json")
        current = rows.get(token_hash) if isinstance(rows.get(token_hash), dict) else {}
        rows[token_hash] = {"user_id": user_id, "expires_at": expires_at, "revoked": bool(current.get("revoked"))}
        self._write("sessions.json", rows)

    async def get_session(self, token_hash: str) -> dict[str, Any] | None:
        row = self._load_map("sessions.json").get(token_hash)
        if not isinstance(row, dict):
            return None
        expires_at = _datetime_from_json(str(row.get("expires_at") or ""))
        if expires_at is not None and expires_at < datetime.now(timezone.utc):
            return None
        return dict(row)

    async def revoke_session(self, token_hash: str) -> None:
        rows = self._load_map("sessions.json")
        row = rows.get(token_hash)
        if isinstance(row, dict):
            row["revoked"] = True
            rows[token_hash] = row
            self._write("sessions.json", rows)
