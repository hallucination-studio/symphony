from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..podium_shared import _datetime_from_json, utc_now_iso


class JsonStoreRuntimeMixin:
    async def upsert_runtime_group(self, group: dict[str, Any]) -> None:
        rows = self._load_map("runtime_groups.json")
        rows[str(group["id"])] = dict(group)
        self._write("runtime_groups.json", rows)

    async def get_runtime_group(self, group_id: str) -> dict[str, Any] | None:
        row = self._load_map("runtime_groups.json").get(group_id)
        return dict(row) if isinstance(row, dict) else None

    async def list_runtime_groups(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self._load_map("runtime_groups.json").values() if isinstance(row, dict)]

    async def save_enrollment_token(
        self,
        token_hash: str,
        *,
        runtime_group_id: str,
        conductor_id: str,
        expires_at: str,
    ) -> None:
        rows = self._load_map("enrollment_tokens.json")
        rows[token_hash] = {
            "runtime_group_id": runtime_group_id,
            "conductor_id": conductor_id,
            "used": False,
            "expires_at": expires_at,
        }
        self._write("enrollment_tokens.json", rows)

    async def consume_enrollment_token(self, token_hash: str) -> tuple[dict[str, Any] | None, str | None]:
        rows = self._load_map("enrollment_tokens.json")
        row = rows.get(token_hash)
        if not isinstance(row, dict):
            return None, "invalid_enrollment_token"
        if bool(row.get("used")):
            return None, "enrollment_token_used"
        expires_at = _datetime_from_json(str(row.get("expires_at") or ""))
        if expires_at is not None and expires_at < datetime.now(timezone.utc):
            return None, "enrollment_token_expired"
        row["used"] = True
        rows[token_hash] = row
        self._write("enrollment_tokens.json", rows)
        return dict(row), None

    async def has_pending_enrollment(self, runtime_group_id: str) -> bool:
        now = datetime.now(timezone.utc)
        for row in self._load_map("enrollment_tokens.json").values():
            if not isinstance(row, dict) or bool(row.get("used")):
                continue
            expires_at = _datetime_from_json(str(row.get("expires_at") or ""))
            if str(row.get("runtime_group_id") or "") == runtime_group_id and (expires_at is None or expires_at >= now):
                return True
        return False

    async def upsert_conductor(self, conductor: dict[str, Any]) -> None:
        rows = self._load_map("conductors.json")
        rows[str(conductor["id"])] = dict(conductor)
        self._write("conductors.json", rows)

    async def get_runtime(self, runtime_id: str) -> dict[str, Any] | None:
        row = self._load_map("conductors.json").get(runtime_id)
        return _runtime_from_conductor(row) if isinstance(row, dict) else None

    async def get_runtime_by_token_hash(self, token_hash: str, *, proxy: bool = False) -> dict[str, Any] | None:
        field = "proxy_token_hash" if proxy else "runtime_token_hash"
        for row in self._load_map("conductors.json").values():
            if isinstance(row, dict) and str(row.get(field) or "") == token_hash:
                return _runtime_from_conductor(row)
        return None

    async def list_conductors_for_user(self, user_id: str) -> list[dict[str, Any]]:
        rows = [
            dict(row)
            for row in self._load_map("conductors.json").values()
            if isinstance(row, dict) and str(row.get("user_id") or "") == user_id
        ]
        return sorted(rows, key=lambda row: str(row.get("created_at") or ""))

    async def list_all_conductors(self) -> list[dict[str, Any]]:
        return [
            dict(row)
            for row in self._load_map("conductors.json").values()
            if isinstance(row, dict)
        ]


def _runtime_from_conductor(row: dict[str, Any]) -> dict[str, Any]:
    user_id = str(row.get("user_id") or "")
    return {
        "id": str(row["id"]),
        "runtime_group_id": str(row.get("runtime_group_id") or f"group_{user_id}"),
        "user_id": user_id,
        "runtime_token_hash": str(row.get("runtime_token_hash") or ""),
        "proxy_token_hash": str(row.get("proxy_token_hash") or ""),
        "disabled": bool(row.get("disabled")),
        "revoked": bool(row.get("revoked")),
        "created_at": str(row.get("created_at") or ""),
        "hostname": str(row.get("hostname") or ""),
        "label": str(row.get("label") or ""),
        "version": str(row.get("version") or ""),
        "name": str(row.get("name") or ""),
        "public_id": str(row.get("public_id") or ""),
        "enrollment_state": str(row.get("enrollment_state") or "pending"),
        "service_identity": str(row.get("service_identity") or ""),
        "data_root": str(row.get("data_root") or ""),
    }
