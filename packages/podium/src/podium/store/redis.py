from __future__ import annotations

import json
from typing import Any

import redis.asyncio as redis


class RedisStore:
    def __init__(self, client: redis.Redis | None = None, *, redis_url: str = "") -> None:
        self.client = client or redis.from_url(redis_url, decode_responses=True)
        self.redis_url = redis_url
        self._owns_client = client is None

    @staticmethod
    def session_key(token_hash: str) -> str:
        return f"session:{token_hash}"

    @staticmethod
    def conductor_owner_key(conductor_id: str) -> str:
        return f"conductor:{conductor_id}:owner"

    @staticmethod
    def enrollment_key(token_hash: str) -> str:
        return f"enrollment:{token_hash}"

    @staticmethod
    def fetch_key(request_id: str) -> str:
        return f"fetch:{request_id}"

    @staticmethod
    def command_channel(conductor_id: str) -> str:
        return f"cmd:conductor:{conductor_id}"

    async def save_session(self, token_hash: str, *, user_id: str, ttl_seconds: int) -> None:
        payload = json.dumps({"user_id": user_id, "revoked": False}, sort_keys=True)
        await self.client.set(self.session_key(token_hash), payload, ex=ttl_seconds)

    async def get_session(self, token_hash: str) -> dict[str, Any] | None:
        raw = await self.client.get(self.session_key(token_hash))
        if raw is None:
            return None
        return dict(json.loads(str(raw)))

    async def revoke_session(self, token_hash: str) -> None:
        row = await self.get_session(token_hash)
        if row is None:
            return
        ttl = await self.client.ttl(self.session_key(token_hash))
        row["revoked"] = True
        await self.client.set(self.session_key(token_hash), json.dumps(row, sort_keys=True), ex=max(ttl, 1))

    async def set_conductor_owner(self, conductor_id: str, podium_instance_id: str, *, ttl_seconds: int) -> None:
        await self.client.set(self.conductor_owner_key(conductor_id), podium_instance_id, ex=ttl_seconds)

    async def get_conductor_owner(self, conductor_id: str) -> str | None:
        owner = await self.client.get(self.conductor_owner_key(conductor_id))
        return str(owner) if owner is not None else None

    async def clear_conductor_owner(self, conductor_id: str) -> None:
        await self.client.delete(self.conductor_owner_key(conductor_id))

    async def save_enrollment_token(self, token_hash: str, *, runtime_group_id: str, ttl_seconds: int) -> None:
        payload = json.dumps({"runtime_group_id": runtime_group_id}, sort_keys=True)
        await self.client.set(self.enrollment_key(token_hash), payload, ex=ttl_seconds)

    async def consume_enrollment_token(self, token_hash: str) -> dict[str, Any] | None:
        key = self.enrollment_key(token_hash)
        async with self.client.pipeline(transaction=True) as pipe:
            await pipe.get(key)
            await pipe.delete(key)
            raw, _deleted = await pipe.execute()
        if raw is None:
            return None
        return dict(json.loads(str(raw)))

    async def has_enrollment_token_for_group(self, runtime_group_id: str) -> bool:
        async for key in self.client.scan_iter(match="enrollment:*"):
            raw = await self.client.get(key)
            if raw is None:
                continue
            row = json.loads(str(raw))
            if str(row.get("runtime_group_id") or "") == runtime_group_id:
                return True
        return False

    async def save_log_fetch_result(self, request_id: str, result: dict[str, Any], *, ttl_seconds: int) -> None:
        await self.client.set(self.fetch_key(request_id), json.dumps(result, sort_keys=True), ex=ttl_seconds)

    async def get_log_fetch_result(self, request_id: str) -> dict[str, Any] | None:
        raw = await self.client.get(self.fetch_key(request_id))
        if raw is None:
            return None
        return dict(json.loads(str(raw)))

    async def publish_runtime_command(self, conductor_id: str, command: dict[str, Any]) -> None:
        await self.client.publish(self.command_channel(conductor_id), json.dumps(command, sort_keys=True))

    async def subscribe_runtime_commands(self, conductor_id: str) -> Any:
        pubsub = self.client.pubsub()
        await pubsub.subscribe(self.command_channel(conductor_id))
        return pubsub

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()
