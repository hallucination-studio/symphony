from __future__ import annotations

import base64
import hashlib
import inspect
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import Response

from .config import PodiumConfig
from .podium_shared import hash_secret, utc_now_iso

LINEAR_SCOPE_QUERY = "query { teams { nodes { id name key } } projects { nodes { id name } } }"
LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"
ONBOARDING_STEPS = [
    "linear_connect",
    "scope_selection",
    "repository_mapping",
    "runtime_enrollment",
    "smoke_check",
]


class SecretDecryptionError(RuntimeError):
    pass


class PodiumStateBaseMixin:
    def __post_init__(self) -> None:
        if getattr(self, "store", None) is None:
            raise RuntimeError("podium_store_required")

    async def load_onboarding_state(self, workspace_id: str) -> dict[str, Any]:
        row = await self.store.get_onboarding_state(workspace_id)
        return row if isinstance(row, dict) else {"completed_steps": [], "metadata": {}}

    async def persist_onboarding_state(self, workspace_id: str, row: dict[str, Any]) -> None:
        await self.store.save_onboarding_state(
            workspace_id,
            list(row.get("completed_steps") or []),
            dict(row.get("metadata") or {}),
        )

    async def _mark_onboarding(self, workspace_id: str, step: str) -> dict[str, Any]:
        row = await self.load_onboarding_state(workspace_id)
        if step in ONBOARDING_STEPS:
            completed = row.setdefault("completed_steps", [])
            if step not in completed:
                completed.append(step)
                await self.persist_onboarding_state(workspace_id, row)
        return row

    async def onboarding_progress(self, workspace_id: str) -> dict[str, Any]:
        row = await self.load_onboarding_state(workspace_id)
        completed = list(row.get("completed_steps") or [])
        group_id = f"group_{workspace_id}"
        conductors = await self.store.list_conductors_for_user(workspace_id)
        has_runtime = bool(conductors)
        online_runtime = False
        for conductor in conductors:
            if await self.is_runtime_online(str(conductor["id"])):
                online_runtime = True
                break
        if (has_runtime or online_runtime) and "runtime_enrollment" not in completed:
            completed.append("runtime_enrollment")
        if await self.store.get_runtime_group(group_id) is None:
            await self.ensure_workspace_runtime_group(workspace_id)
        ordered = [step for step in ONBOARDING_STEPS if step in completed]
        current_step = "complete"
        for step in ONBOARDING_STEPS:
            if step not in ordered:
                current_step = step
                break
        row["completed_steps"] = ordered
        await self.persist_onboarding_state(workspace_id, row)
        return {"current_step": current_step, "completed_steps": ordered, "next_action": None if current_step == "complete" else current_step}

    async def save_onboarding_scope(self, workspace_id: str, teams: Any, projects: Any) -> dict[str, Any]:
        row = await self.load_onboarding_state(workspace_id)
        row.setdefault("metadata", {})["scope"] = {"teams": teams, "projects": projects}
        completed = row.setdefault("completed_steps", [])
        if "scope_selection" not in completed:
            completed.append("scope_selection")
        await self.persist_onboarding_state(workspace_id, row)
        return await self.onboarding_progress(workspace_id)

    async def save_onboarding_repository(self, workspace_id: str, mode: str, value: str) -> dict[str, Any]:
        row = await self.load_onboarding_state(workspace_id)
        row.setdefault("metadata", {})["repository"] = {"mode": mode, "value": value}
        completed = row.setdefault("completed_steps", [])
        if "repository_mapping" not in completed:
            completed.append("repository_mapping")
        await self.persist_onboarding_state(workspace_id, row)
        return await self.onboarding_progress(workspace_id)

    async def mark_linear_connected(self, workspace_id: str) -> dict[str, Any]:
        await self._mark_onboarding(workspace_id, "linear_connect")
        return await self.onboarding_progress(workspace_id)

    async def mark_runtime_enrolled(self, workspace_id: str) -> dict[str, Any]:
        await self._mark_onboarding(workspace_id, "runtime_enrollment")
        return await self.onboarding_progress(workspace_id)

    async def set_smoke_result(self, workspace_id: str, result: dict[str, Any]) -> dict[str, Any]:
        await self.store.save_smoke_result(workspace_id, result)
        await self._mark_onboarding(workspace_id, "smoke_check")
        return await self.onboarding_progress(workspace_id)

    async def get_smoke_result(self, workspace_id: str) -> dict[str, Any] | None:
        return await self.store.get_smoke_result(workspace_id)

    async def ensure_workspace_runtime_group(self, workspace_id: str) -> str:
        group_id = f"group_{workspace_id}"
        await self.store.upsert_runtime_group(
            {
                "id": group_id,
                "linear_workspace_id": workspace_id,
                "project_slug": "",
                "linear_agent_app_user_id": "",
                "managed_run_profile": "default",
                "project_binding_id": "",
            }
        )
        return group_id

    async def save_enrollment_token(self, token_hash: str, *, runtime_group_id: str, expires_at: datetime) -> None:
        await self.store.save_enrollment_token(
            token_hash,
            runtime_group_id=runtime_group_id,
            expires_at=expires_at.isoformat().replace("+00:00", "Z"),
        )

    async def consume_enrollment_token(self, token: str) -> tuple[dict[str, Any] | None, str | None]:
        return await self.store.consume_enrollment_token(hash_secret(token))

    async def has_pending_enrollment(self, runtime_group_id: str) -> bool:
        return bool(await self.store.has_pending_enrollment(runtime_group_id))

    async def set_presence(self, runtime_id: str) -> None:
        now = datetime.now(timezone.utc)
        await self.store.set_presence(
            runtime_id,
            timestamp=now.isoformat().replace("+00:00", "Z"),
            expires_at=(now + timedelta(seconds=90)).isoformat().replace("+00:00", "Z"),
        )

    async def clear_presence(self, runtime_id: str) -> None:
        await self.store.clear_presence(runtime_id)

    async def is_runtime_online(self, runtime_id: str) -> bool:
        return await self.store.get_presence(runtime_id) is not None

    async def runtime_presence_snapshot(self, runtime_ids: list[str]) -> dict[str, str]:
        snapshot: dict[str, str] = {}
        for runtime_id in runtime_ids:
            row = await self.store.get_presence(runtime_id)
            if row is not None:
                snapshot[runtime_id] = str(row.get("last_seen_at") or utc_now_iso())
        return snapshot

    async def save_log_fetch_result(self, request_id: str, result: dict[str, Any]) -> None:
        if request_id:
            await self.store.save_log_fetch_result(request_id, result)

    async def get_log_fetch_result(self, request_id: str) -> dict[str, Any] | None:
        return await self.store.get_log_fetch_result(request_id)

    async def record_proxy_audit(self, event: dict[str, Any]) -> None:
        await self.store.insert_proxy_audit_event(event)

    def _fernet(self) -> Fernet:
        if not self.secret_key:
            raise RuntimeError("encryption_unavailable")
        key = base64.urlsafe_b64encode(hashlib.sha256(self.secret_key.encode()).digest())
        return Fernet(key)

    def encrypt_secret(self, plaintext: str) -> str:
        return self._fernet().encrypt(plaintext.encode()).decode()

    def decrypt_secret(self, ciphertext: str) -> str:
        try:
            return self._fernet().decrypt(ciphertext.encode()).decode()
        except (InvalidToken, ValueError) as exc:
            raise SecretDecryptionError("secret_decryption_failed") from exc

    def _installation_to_disk(self, installation: dict[str, Any]) -> dict[str, Any]:
        access_token = str(installation.get("access_token") or "")
        return {
            "workspace_id": str(installation.get("workspace_id") or ""),
            "access_token_encrypted": self.encrypt_secret(access_token),
            "scope": installation.get("scope"),
            "actor": installation.get("actor"),
            "expires_at": installation.get("expires_at"),
        }

    def _installation_from_disk(self, installation: dict[str, Any]) -> dict[str, Any]:
        encrypted = str(installation.get("access_token_encrypted") or installation.get("access_token") or "")
        return {
            "workspace_id": str(installation.get("workspace_id") or ""),
            "access_token": self.decrypt_secret(encrypted) if encrypted else "",
            "scope": installation.get("scope"),
            "actor": installation.get("actor"),
            "expires_at": installation.get("expires_at"),
        }

    async def get_linear_installation(self, workspace_id: str) -> dict[str, Any] | None:
        installation = await self.store.get_linear_installation(workspace_id)
        return self._installation_from_disk(dict(installation)) if installation is not None else None

    async def save_linear_installation(self, workspace_id: str, installation: dict[str, Any]) -> None:
        await self.store.save_linear_installation(workspace_id, self._installation_to_disk(installation))

    async def linear_status(self, workspace_id: str) -> dict[str, Any]:
        installation = await self.get_linear_installation(workspace_id)
        if not installation:
            return {"workspace_id": workspace_id, "state": "not_connected"}
        return {"workspace_id": workspace_id, "state": "connected", "scope": installation.get("scope"), "expires_at": installation.get("expires_at")}

    async def verify_turnstile(self, token: str, ip: str | None) -> bool:
        if not self.turnstile_enabled:
            return True
        if not token:
            return False
        result = self.turnstile_verifier(token, ip)
        if inspect.isawaitable(result):
            result = await result
        return bool(result)

    @property
    def turnstile_enabled(self) -> bool:
        if self.config.turnstile_disabled or self.debug_auth:
            return False
        return bool(self.config.turnstile_site_key.strip() and self.config.turnstile_secret_key.strip())

    def public_config(self) -> dict[str, Any]:
        site_key = self.config.turnstile_site_key.strip()
        return {"turnstile": {"enabled": self.turnstile_enabled, "site_key": site_key if self.turnstile_enabled else ""}}

    async def next_user_id(self) -> str:
        return str(await self.store.next_user_id())

    async def create_user(self, user_id: str, *, email: str, password_hash: str, created_at: str) -> dict[str, Any]:
        return _clean_user(await self.store.create_user(user_id, email=email, password_hash=password_hash, created_at=created_at))

    async def user_by_id(self, user_id: str) -> dict[str, Any] | None:
        user = await self.store.get_user(user_id)
        return _clean_user(user) if user is not None else None

    async def user_by_email(self, email: str) -> dict[str, Any] | None:
        user = await self.store.get_user_by_email(email)
        return _clean_user(user) if user is not None else None

    async def set_user_linear_app(self, user_id: str, linear_app: dict[str, Any] | None) -> None:
        await self.store.set_user_linear_app(user_id, linear_app)

    async def ensure_debug_user(self) -> dict[str, Any]:
        user = await self.user_by_id("debug")
        if user is not None:
            return user
        return await self.create_user(
            "debug",
            email="debug@podium.local",
            password_hash="",
            created_at=utc_now_iso(),
        )

    async def create_session(self, user_id: str) -> str:
        token = secrets.token_urlsafe(32)
        ttl = getattr(self, "session_ttl", timedelta(days=30))
        expires_at = (datetime.now(timezone.utc) + ttl).isoformat().replace("+00:00", "Z")
        await self.store.save_session(hash_secret(token), user_id=user_id, expires_at=expires_at)
        return token

    async def revoke_session(self, token: str) -> None:
        await self.store.revoke_session(hash_secret(token))

    async def user_for_session(self, token: str) -> dict[str, Any] | None:
        row = await self.store.get_session(hash_secret(token))
        if row is None or row.get("revoked"):
            return None
        return await self.user_by_id(str(row["user_id"]))

    def set_session_cookie(self, response: Response, token: str) -> None:
        response.set_cookie(
            self.session_cookie_name,
            token,
            httponly=True,
            secure=self.secure_cookies,
            samesite="Lax",
            max_age=30 * 24 * 3600,
        )


def _clean_user(user: dict[str, Any]) -> dict[str, Any]:
    cleaned = dict(user)
    if cleaned.get("linear_app") is None:
        cleaned.pop("linear_app", None)
    return cleaned
