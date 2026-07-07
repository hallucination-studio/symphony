from __future__ import annotations

import base64
import hashlib
import inspect
import os
import secrets
import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
from argon2 import PasswordHasher
from cryptography.fernet import Fernet, InvalidToken
from fastapi import Response

from .config import PodiumConfig
from .podium_shared import (
    _datetime_from_json,
    hash_secret,
    utc_now_iso,
)

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


@dataclass
class InMemoryPodiumBusinessState:
    """Fallback business store for tests and single-process local runs."""

    users: dict[str, dict[str, Any]] = field(default_factory=dict)
    user_ids_by_email: dict[str, str] = field(default_factory=dict)
    sessions: dict[str, dict[str, Any]] = field(default_factory=dict)
    runtime_groups: dict[str, dict[str, Any]] = field(default_factory=dict)
    enrollment_tokens: dict[str, dict[str, Any]] = field(default_factory=dict)
    runtimes: dict[str, dict[str, Any]] = field(default_factory=dict)
    dispatches: dict[str, dict[str, Any]] = field(default_factory=dict)
    presence: dict[str, str] = field(default_factory=dict)
    proxy_audit_events: list[dict[str, Any]] = field(default_factory=list)
    linear_installations: dict[str, dict[str, Any]] = field(default_factory=dict)
    conductors: dict[str, dict[str, Any]] = field(default_factory=dict)
    project_bindings: dict[str, dict[str, Any]] = field(default_factory=dict)
    metrics_snapshots: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    instance_log_tails: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    log_fetch_results: dict[str, dict[str, Any]] = field(default_factory=dict)
    ws_queues: dict[str, asyncio.Queue[dict[str, Any]]] = field(default_factory=dict)
    onboarding_state: dict[str, dict[str, Any]] = field(default_factory=dict)
    smoke_results: dict[str, dict[str, Any]] = field(default_factory=dict)
    oauth_states: dict[str, dict[str, Any]] = field(default_factory=dict)
    runtime_configs: dict[str, dict[str, Any]] = field(default_factory=dict)
    pipeline_views: dict[str, dict[str, Any]] = field(default_factory=dict)


class PodiumStateBaseMixin:
    def __post_init__(self) -> None:
        self.durable = InMemoryPodiumBusinessState()

    @property
    def users(self) -> Any:
        return self.durable.users

    @property
    def user_ids_by_email(self) -> Any:
        return self.durable.user_ids_by_email

    @property
    def sessions(self) -> Any:
        return self.durable.sessions

    @property
    def runtime_groups(self) -> Any:
        return self.durable.runtime_groups

    @property
    def enrollment_tokens(self) -> Any:
        return self.durable.enrollment_tokens

    @property
    def runtimes(self) -> Any:
        return self.durable.runtimes

    @property
    def dispatches(self) -> Any:
        return self.durable.dispatches

    @property
    def presence(self) -> Any:
        return self.durable.presence

    @property
    def proxy_audit(self) -> Any:
        return self.durable.proxy_audit_events

    @property
    def linear_installations(self) -> Any:
        return self.durable.linear_installations

    @property
    def conductors(self) -> Any:
        return self.durable.conductors

    @property
    def project_bindings(self) -> Any:
        return self.durable.project_bindings

    @property
    def metrics_snapshots(self) -> Any:
        return self.durable.metrics_snapshots

    @property
    def instance_log_tails(self) -> Any:
        return self.durable.instance_log_tails

    @property
    def log_fetch_results(self) -> Any:
        return self.durable.log_fetch_results

    @property
    def ws_queues(self) -> Any:
        return self.durable.ws_queues

    @property
    def runtime_configs(self) -> Any:
        return self.durable.runtime_configs

    @property
    def pipeline_views(self) -> Any:
        return self.durable.pipeline_views

    def persist_users(self) -> None:
        self.persist()

    def persist_linear_installations(self) -> None:
        self.persist()

    def persist(self) -> None:
        persist = getattr(self.durable, "persist", None)
        if callable(persist):
            persist()

    def _onboarding_row(self, workspace_id: str) -> dict[str, Any]:
        return self.durable.onboarding_state.setdefault(
            workspace_id,
            {"completed_steps": [], "metadata": {}},
        )

    async def load_onboarding_state(self, workspace_id: str) -> None:
        if self.pg_store is None:
            return
        row = await self.pg_store.get_onboarding_state(workspace_id)
        if row is not None:
            self.durable.onboarding_state[workspace_id] = {
                "completed_steps": list(row.get("completed_steps") or []),
                "metadata": dict(row.get("metadata") or {}),
            }

    async def persist_onboarding_state(self, workspace_id: str) -> None:
        if self.pg_store is None:
            self.persist()
            return
        row = self._onboarding_row(workspace_id)
        await self.pg_store.save_onboarding_state(
            workspace_id,
            list(row.get("completed_steps") or []),
            dict(row.get("metadata") or {}),
        )

    def _mark_onboarding(self, workspace_id: str, step: str) -> None:
        if step not in ONBOARDING_STEPS:
            return
        row = self._onboarding_row(workspace_id)
        completed = row.setdefault("completed_steps", [])
        if step not in completed:
            completed.append(step)
            self.persist()

    def onboarding_progress(self, workspace_id: str) -> dict[str, Any]:
        row = self._onboarding_row(workspace_id)
        completed = list(row.get("completed_steps") or [])
        group_id = f"group_{workspace_id}"
        has_runtime = any(
            str(runtime.get("runtime_group_id") or "") == group_id
            or str(runtime.get("user_id") or "") == workspace_id
            for runtime in self.runtimes.values()
        )
        online_runtime = any(
            (str(runtime.get("runtime_group_id") or "") == group_id or str(runtime.get("user_id") or "") == workspace_id)
            and str(runtime.get("id") or "") in self.presence
            for runtime in self.runtimes.values()
        )
        if (has_runtime or online_runtime) and "runtime_enrollment" not in completed:
            completed.append("runtime_enrollment")
        ordered = [step for step in ONBOARDING_STEPS if step in completed]
        current_step = "complete"
        for step in ONBOARDING_STEPS:
            if step not in ordered:
                current_step = step
                break
        row["completed_steps"] = ordered
        return {
            "current_step": current_step,
            "completed_steps": ordered,
            "next_action": None if current_step == "complete" else current_step,
        }

    def save_onboarding_scope(self, workspace_id: str, teams: Any, projects: Any) -> dict[str, Any]:
        row = self._onboarding_row(workspace_id)
        row.setdefault("metadata", {})["scope"] = {"teams": teams, "projects": projects}
        self._mark_onboarding(workspace_id, "scope_selection")
        self.persist()
        return self.onboarding_progress(workspace_id)

    def save_onboarding_repository(self, workspace_id: str, mode: str, value: str) -> dict[str, Any]:
        row = self._onboarding_row(workspace_id)
        row.setdefault("metadata", {})["repository"] = {"mode": mode, "value": value}
        self._mark_onboarding(workspace_id, "repository_mapping")
        self.persist()
        return self.onboarding_progress(workspace_id)

    def mark_linear_connected(self, workspace_id: str) -> dict[str, Any]:
        self._mark_onboarding(workspace_id, "linear_connect")
        return self.onboarding_progress(workspace_id)

    def mark_runtime_enrolled(self, workspace_id: str) -> dict[str, Any]:
        self._mark_onboarding(workspace_id, "runtime_enrollment")
        return self.onboarding_progress(workspace_id)

    def set_smoke_result(self, workspace_id: str, result: dict[str, Any]) -> dict[str, Any]:
        self.durable.smoke_results[workspace_id] = result
        self._mark_onboarding(workspace_id, "smoke_check")
        self.persist()
        return self.onboarding_progress(workspace_id)

    def get_smoke_result(self, workspace_id: str) -> dict[str, Any] | None:
        return self.durable.smoke_results.get(workspace_id)

    async def save_enrollment_token(self, token_hash: str, *, runtime_group_id: str, expires_at: datetime) -> None:
        ttl_seconds = max(1, int((expires_at - datetime.now(timezone.utc)).total_seconds()))
        if self.redis_store is not None:
            await self.redis_store.save_enrollment_token(token_hash, runtime_group_id=runtime_group_id, ttl_seconds=ttl_seconds)
            return
        self.enrollment_tokens[token_hash] = {
            "runtime_group_id": runtime_group_id,
            "used": False,
            "expires_at": expires_at,
        }
        self.persist()

    async def consume_enrollment_token(self, token: str) -> tuple[dict[str, Any] | None, str | None]:
        token_hash = hash_secret(token)
        if self.redis_store is not None:
            row = await self.redis_store.consume_enrollment_token(token_hash)
            return (row, None) if row is not None else (None, "invalid_enrollment_token")
        row = self.enrollment_tokens.get(token_hash)
        if row is None:
            return None, "invalid_enrollment_token"
        if row["used"]:
            return None, "enrollment_token_used"
        if row["expires_at"] < datetime.now(timezone.utc):
            return None, "enrollment_token_expired"
        row["used"] = True
        self.persist()
        return row, None

    async def has_pending_enrollment(self, runtime_group_id: str) -> bool:
        if self.redis_store is not None:
            return bool(await self.redis_store.has_enrollment_token_for_group(runtime_group_id))
        return any(
            not row["used"] and row["runtime_group_id"] == runtime_group_id and row["expires_at"] >= datetime.now(timezone.utc)
            for row in self.enrollment_tokens.values()
        )

    async def set_presence(self, runtime_id: str) -> None:
        timestamp = utc_now_iso()
        self.presence[runtime_id] = timestamp
        if self.redis_store is not None:
            await self.redis_store.set_conductor_owner(runtime_id, "podium", ttl_seconds=90)

    async def clear_presence(self, runtime_id: str) -> None:
        self.presence.pop(runtime_id, None)
        if self.redis_store is not None:
            await self.redis_store.clear_conductor_owner(runtime_id)

    async def save_log_fetch_result(self, request_id: str, result: dict[str, Any]) -> None:
        if not request_id:
            return
        if self.redis_store is not None:
            await self.redis_store.save_log_fetch_result(request_id, result, ttl_seconds=300)
        else:
            self.log_fetch_results[request_id] = result
            self.persist()

    async def get_log_fetch_result(self, request_id: str) -> dict[str, Any] | None:
        if self.redis_store is not None:
            return await self.redis_store.get_log_fetch_result(request_id)
        return self.log_fetch_results.get(request_id)

    async def record_proxy_audit(self, event: dict[str, Any]) -> None:
        self.proxy_audit.append(dict(event))
        if self.pg_store is not None:
            await self.pg_store.insert_proxy_audit_event(event)

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
            "expires_at": installation.get("expires_at"),
        }

    def _installation_from_disk(self, installation: dict[str, Any]) -> dict[str, Any]:
        encrypted = str(installation.get("access_token_encrypted") or installation.get("access_token") or "")
        return {
            "workspace_id": str(installation.get("workspace_id") or ""),
            "access_token": self.decrypt_secret(encrypted) if encrypted else "",
            "scope": installation.get("scope"),
            "expires_at": installation.get("expires_at"),
        }

    async def get_linear_installation(self, workspace_id: str) -> dict[str, Any] | None:
        if self.pg_store is not None:
            installation = await self.pg_store.get_linear_installation(workspace_id)
            return self._installation_from_disk(dict(installation)) if installation is not None else None
        return self.linear_installations.get(workspace_id)

    async def save_linear_installation(self, workspace_id: str, installation: dict[str, Any]) -> None:
        if self.pg_store is not None:
            await self.pg_store.save_linear_installation(
                workspace_id,
                self._installation_to_disk(installation),
            )
            return
        self.linear_installations[workspace_id] = installation
        self.persist_linear_installations()

    async def linear_status(self, workspace_id: str) -> dict[str, Any]:
        installation = await self.get_linear_installation(workspace_id)
        if not installation:
            return {"workspace_id": workspace_id, "state": "not_connected"}
        return {
            "workspace_id": workspace_id,
            "state": "connected",
            "scope": installation.get("scope"),
            "expires_at": installation.get("expires_at"),
        }

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
        if self.pg_store is not None:
            return str(await self.pg_store.next_user_id())
        return f"user_{len(self.users) + 1}"

    async def create_user(
        self,
        user_id: str,
        *,
        email: str,
        password_hash: str,
        created_at: str,
    ) -> dict[str, Any]:
        if self.pg_store is not None:
            user = await self.pg_store.create_user(
                user_id,
                email=email,
                password_hash=password_hash,
                created_at=created_at,
            )
            return _clean_user(user)
        user = {
            "id": user_id,
            "email": email,
            "password_hash": password_hash,
            "created_at": created_at,
        }
        self.users[user_id] = user
        self.user_ids_by_email[email] = user_id
        self.persist_users()
        return user

    async def user_by_id(self, user_id: str) -> dict[str, Any] | None:
        if self.pg_store is not None:
            user = await self.pg_store.get_user(user_id)
            return _clean_user(user) if user is not None else None
        return self.users.get(user_id or "")

    async def user_by_email(self, email: str) -> dict[str, Any] | None:
        if self.pg_store is not None:
            user = await self.pg_store.get_user_by_email(email)
            return _clean_user(user) if user is not None else None
        user_id = self.user_ids_by_email.get(email)
        return self.users.get(user_id or "")

    async def set_user_linear_app(self, user_id: str, linear_app: dict[str, Any] | None) -> None:
        if self.pg_store is not None:
            await self.pg_store.set_user_linear_app(user_id, linear_app)
            return
        user = self.users.get(user_id)
        if user is None:
            return
        if linear_app is None:
            user.pop("linear_app", None)
        else:
            user["linear_app"] = linear_app
        self.persist_users()

    def ensure_debug_user(self) -> dict[str, Any]:
        user_id = "debug"
        user = self.users.get(user_id)
        if user is None:
            user = {
                "id": user_id,
                "email": "debug@podium.local",
                "password_hash": "",
                "created_at": utc_now_iso(),
            }
            self.users[user_id] = user
            self.user_ids_by_email["debug@podium.local"] = user_id
            self.persist_users()
        return user

    async def create_session(self, user_id: str) -> str:
        token = secrets.token_urlsafe(32)
        ttl = getattr(self, "session_ttl", timedelta(days=30))
        token_hash = hash_secret(token)
        ttl_seconds = max(1, int(ttl.total_seconds()))
        if self.redis_store is not None:
            await self.redis_store.save_session(token_hash, user_id=user_id, ttl_seconds=ttl_seconds)
        else:
            self.sessions[token_hash] = {
                "user_id": user_id,
                "expires_at": datetime.now(timezone.utc) + ttl,
                "revoked": False,
            }
            self.persist()
        return token

    async def revoke_session(self, token: str) -> None:
        token_hash = hash_secret(token)
        if self.redis_store is not None:
            await self.redis_store.revoke_session(token_hash)
            return
        row = self.sessions.get(token_hash)
        if row is not None:
            row["revoked"] = True
            self.persist()

    async def user_for_session(self, token: str) -> dict[str, Any] | None:
        token_hash = hash_secret(token)
        if self.redis_store is not None:
            row = await self.redis_store.get_session(token_hash)
            if row is None or row.get("revoked"):
                return None
            return await self.user_by_id(str(row["user_id"]))
        row = self.sessions.get(token_hash)
        if row is None or row.get("revoked") or row["expires_at"] < datetime.now(timezone.utc):
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
