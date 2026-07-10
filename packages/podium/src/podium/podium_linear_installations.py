from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from .podium_shared import hash_secret, utc_now_iso


class LinearApplicationNotConfigured(RuntimeError):
    pass


class LinearApplicationVersionConflict(RuntimeError):
    pass


class PodiumLinearInstallationsMixin:
    async def stage_default_linear_application(self, user_id: str) -> dict[str, Any]:
        if not self.linear_client_id or not self.linear_client_secret:
            raise LinearApplicationNotConfigured("linear_default_application_not_configured")
        version = max(1, int(self.linear_application_version or 1))
        existing = await self._application_by_source_version(user_id, "default", version)
        expected = self._application_input(
            user_id=user_id,
            source="default",
            version=version,
            client_id=self.linear_client_id,
            client_secret=self.linear_client_secret,
        )
        if existing is not None:
            if not self._same_application(existing, expected):
                raise LinearApplicationVersionConflict("linear_application_version_conflict")
            return existing
        await self.store.save_linear_application_config(self._application_to_disk(expected))
        return expected

    async def stage_custom_linear_application(
        self,
        user_id: str,
        *,
        client_id: str,
        client_secret: str,
    ) -> dict[str, Any]:
        configs = await self.list_linear_application_configs(user_id)
        versions = [int(row.get("version") or 0) for row in configs if row.get("source") == "custom"]
        config = self._application_input(
            user_id=user_id,
            source="custom",
            version=max(versions, default=0) + 1,
            client_id=client_id,
            client_secret=client_secret,
        )
        await self.store.save_linear_application_config(self._application_to_disk(config))
        await self.store.set_linear_application_preference(user_id, str(config["id"]))
        return config

    async def select_default_linear_application(self, user_id: str) -> dict[str, Any]:
        config = await self.stage_default_linear_application(user_id)
        await self.store.set_linear_application_preference(user_id, str(config["id"]))
        return config

    async def selected_linear_application(self, user_id: str) -> dict[str, Any]:
        config_id = await self.store.get_linear_application_preference(user_id)
        if config_id:
            config = await self.get_linear_application_config(config_id)
            if config is not None and str(config.get("user_id") or "") == user_id:
                return config
        return await self.select_default_linear_application(user_id)

    async def get_linear_application_config(self, config_id: str) -> dict[str, Any] | None:
        row = await self.store.get_linear_application_config(config_id)
        return self._application_from_disk(row) if row is not None else None

    async def list_linear_application_configs(self, user_id: str) -> list[dict[str, Any]]:
        rows = await self.store.list_linear_application_configs(user_id)
        return [self._application_from_disk(row) for row in rows]

    async def create_linear_oauth_state(self, user_id: str, config: dict[str, Any]) -> dict[str, str]:
        token = secrets.token_urlsafe(32)
        verifier = secrets.token_urlsafe(64)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        expires_at = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
        await self.store.save_oauth_state(
            hash_secret(token),
            {
                "workspace_id": user_id,
                "application_config_id": str(config["id"]),
                "application_config_version": int(config["version"]),
                "code_verifier_enc": self.encrypt_secret(verifier),
                "expires_at": expires_at,
            },
        )
        return {"state": token, "code_challenge": challenge}

    async def consume_linear_oauth_state(self, token: str) -> dict[str, Any] | None:
        row = await self.store.consume_oauth_state(hash_secret(token))
        if row is None:
            return None
        return {
            **row,
            "code_verifier": self.decrypt_secret(str(row.pop("code_verifier_enc"))),
        }

    async def save_linear_installation_record(self, installation: dict[str, Any]) -> None:
        row = dict(installation)
        row["access_token_enc"] = self.encrypt_secret(str(row.pop("access_token", "")))
        row["refresh_token_enc"] = self.encrypt_secret(str(row.pop("refresh_token", "")))
        await self.store.save_workspace_installation(row)

    async def get_active_linear_installation(self, user_id: str) -> dict[str, Any] | None:
        row = await self.store.get_active_workspace_installation(user_id)
        return self._workspace_installation_from_disk(row) if row is not None else None

    async def get_candidate_linear_installation(self, user_id: str) -> dict[str, Any] | None:
        row = await self.store.get_candidate_workspace_installation(user_id)
        return self._workspace_installation_from_disk(row) if row is not None else None

    async def find_active_linear_installation(
        self,
        linear_organization_id: str,
    ) -> dict[str, Any] | None:
        row = await self.store.find_active_workspace_installation(linear_organization_id)
        return self._workspace_installation_from_disk(row) if row is not None else None

    async def list_active_linear_installations(self) -> list[dict[str, Any]]:
        rows = await self.store.list_active_workspace_installations()
        return [self._workspace_installation_from_disk(row) for row in rows]

    async def update_linear_installation_health(
        self,
        installation: dict[str, Any],
        **changes: Any,
    ) -> dict[str, Any]:
        updated = {**installation, **changes, "updated_at": utc_now_iso()}
        await self.save_linear_installation_record(updated)
        return updated

    async def activate_linear_installation(self, user_id: str, installation_id: str) -> None:
        await self.store.activate_workspace_installation(user_id, installation_id)

    def linear_application_public(self, config: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": str(config["id"]),
            "source": str(config["source"]),
            "version": int(config["version"]),
            "client_id": str(config["client_id"]),
            "callback_url": str(config["callback_url"]),
        }

    def linear_installation_public(self, row: dict[str, Any] | None) -> dict[str, Any] | None:
        if row is None:
            return None
        return {
            key: row.get(key)
            for key in (
                "id", "application_config_id", "application_config_version", "application_source",
                "state", "actor", "linear_organization_id", "organization_url_key", "organization_name",
                "app_user_id", "expires_at", "error_code",
                "sanitized_reason", "retryable", "action_required", "next_action", "created_at", "updated_at",
                "reconciliation_state", "last_reconciliation_at",
                "reconciliation_error", "reconciliation_retry_count",
            )
        } | {"scope": list(row.get("scope") or []), "project_count": len(row.get("projects") or [])}

    async def _application_by_source_version(
        self, user_id: str, source: str, version: int
    ) -> dict[str, Any] | None:
        configs = await self.list_linear_application_configs(user_id)
        return next(
            (row for row in configs if row.get("source") == source and int(row.get("version") or 0) == version),
            None,
        )

    def _application_input(self, **values: Any) -> dict[str, Any]:
        return {
            "id": f"linear_app_{secrets.token_urlsafe(12)}",
            **values,
            "callback_url": self.linear_callback_url,
            "created_at": utc_now_iso(),
        }

    def _application_to_disk(self, config: dict[str, Any]) -> dict[str, Any]:
        row = dict(config)
        row["client_secret_enc"] = self.encrypt_secret(str(row.pop("client_secret")))
        return row

    def _application_from_disk(self, raw: dict[str, Any]) -> dict[str, Any]:
        row = dict(raw)
        row["client_secret"] = self.decrypt_secret(str(row.pop("client_secret_enc")))
        return row

    def _workspace_installation_from_disk(self, raw: dict[str, Any]) -> dict[str, Any]:
        row = dict(raw)
        row["access_token"] = self.decrypt_secret(str(row.pop("access_token_enc")))
        row["refresh_token"] = self.decrypt_secret(str(row.pop("refresh_token_enc")))
        return row

    @staticmethod
    def _same_application(current: dict[str, Any], expected: dict[str, Any]) -> bool:
        keys = ("client_id", "client_secret", "callback_url")
        return all(current.get(key) == expected.get(key) for key in keys)

    @property
    def linear_callback_url(self) -> str:
        configured = str(self.linear_redirect_uri or "").strip()
        return configured or f"{str(self.podium_base_url).rstrip('/')}/api/v1/linear/oauth/callback"
