from __future__ import annotations

import asyncio
import inspect
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from .linear_constants import LINEAR_REQUIRED_SCOPES, normalize_scopes
from .linear_oauth import exchange_public_code, refresh_public_token
from .oauth_state import OAuthCodeExchange
from .store.linear import InstallationRecord, LinearCredentials, LinearRepository

LOGGER = logging.getLogger(__name__)

TokenOperation = Callable[..., dict[str, object] | Awaitable[dict[str, object]]]
IdentityVerifier = Callable[[str], dict[str, object] | Awaitable[dict[str, object]]]


class LinearTokenFailure(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class LinearTokenLifecycle:
    def __init__(
        self,
        repository: LinearRepository,
        *,
        verify: IdentityVerifier,
        exchange: TokenOperation | None = None,
        refresh: TokenOperation | None = None,
        now: Callable[[], int] = lambda: int(time.time()),
    ) -> None:
        self.repository = repository
        self.verify = verify
        self.exchange_token = exchange or _exchange
        self.refresh_token = refresh or refresh_public_token
        self.now = now
        self._refresh_locks: dict[str, asyncio.Lock] = {}

    async def startup(self, installation_id: str) -> str:
        installation = self._installation(installation_id)
        try:
            self._validate_installation(installation)
        except LinearTokenFailure as error:
            self._reject(installation_id, error.code)
            raise
        credentials = self.repository.load_credentials(installation_id)
        if credentials is None:
            raise LinearTokenFailure("linear_credentials_missing")
        if credentials.expires_at <= self.now():
            return await self.refresh(installation_id)
        try:
            await self._verify(credentials.access_token, installation)
        except LinearTokenFailure as error:
            if error.code == "linear_identity_verification_failed":
                self._report_transient_failure(installation_id, error.code)
            else:
                self._reject(installation_id, error.code)
            raise
        return credentials.access_token

    async def exchange(self, installation_id: str, code: OAuthCodeExchange) -> str:
        installation = self._installation(installation_id)
        try:
            self._validate_installation(installation)
            payload = await _invoke(self.exchange_token, code)
            credentials = self._credentials(payload)
            await self._verify(credentials.access_token, installation)
        except LinearTokenFailure as error:
            self._reject(installation_id, error.code)
            raise
        except Exception:
            error = LinearTokenFailure("linear_token_exchange_failed")
            self._reject(installation_id, error.code)
            raise error from None
        self.repository.replace_credentials(
            installation_id,
            credentials.access_token,
            credentials.refresh_token,
            expires_at=credentials.expires_at,
        )
        return credentials.access_token

    async def refresh(self, installation_id: str) -> str:
        before = self.repository.load_credentials(installation_id)
        if before is None:
            raise LinearTokenFailure("linear_credentials_missing")
        lock = self._refresh_locks.setdefault(installation_id, asyncio.Lock())
        async with lock:
            current = self.repository.load_credentials(installation_id)
            if current is None:
                raise LinearTokenFailure("linear_credentials_missing")
            if current != before:
                return current.access_token
            installation = self._installation(installation_id)
            try:
                self._validate_installation(installation)
                payload = await _invoke(self.refresh_token, current.refresh_token)
                rotated = self._credentials(payload)
                await self._verify(rotated.access_token, installation)
            except LinearTokenFailure as error:
                if error.code in {
                    "linear_token_refresh_failed",
                    "linear_identity_verification_failed",
                }:
                    self._report_transient_failure(installation_id, error.code)
                else:
                    self._reject(installation_id, error.code)
                raise
            except ValueError as error:
                code = str(error)
                if code not in {"linear_invalid_grant", "linear_token_refresh_failed"}:
                    code = "linear_token_refresh_failed"
                if code == "linear_invalid_grant":
                    self._reject(installation_id, code)
                else:
                    self._report_transient_failure(
                        installation_id, "linear_token_refresh_failed"
                    )
                raise LinearTokenFailure(code) from None
            except Exception:
                self._report_transient_failure(
                    installation_id, "linear_token_refresh_failed"
                )
                raise LinearTokenFailure("linear_token_refresh_failed") from None
            self.repository.replace_credentials(
                installation_id,
                rotated.access_token,
                rotated.refresh_token,
                expires_at=rotated.expires_at,
            )
            return rotated.access_token

    def _installation(self, installation_id: str) -> InstallationRecord:
        installation = self.repository.installation(installation_id)
        if installation is None:
            raise LinearTokenFailure("linear_installation_not_found")
        return installation

    def _validate_installation(self, installation: InstallationRecord) -> None:
        if set(installation.granted_scopes) != LINEAR_REQUIRED_SCOPES:
            raise LinearTokenFailure("linear_scope_invalid")

    def _credentials(self, payload: object) -> LinearCredentials:
        if not isinstance(payload, dict):
            raise LinearTokenFailure("linear_token_metadata_invalid")
        access = payload.get("access_token")
        refresh = payload.get("refresh_token")
        if (
            not isinstance(access, str)
            or not access
            or not isinstance(refresh, str)
            or not refresh
            or str(payload.get("token_type") or "").lower() != "bearer"
        ):
            raise LinearTokenFailure("linear_token_metadata_invalid")
        if payload.get("actor") != "app":
            raise LinearTokenFailure("linear_actor_invalid")
        if normalize_scopes(payload.get("scope")) != LINEAR_REQUIRED_SCOPES:
            raise LinearTokenFailure("linear_scope_invalid")
        expires_in = payload.get("expires_in")
        if isinstance(expires_in, bool) or not isinstance(expires_in, int) or expires_in < 1:
            raise LinearTokenFailure("linear_token_metadata_invalid")
        return LinearCredentials(access, refresh, self.now() + expires_in)

    async def _verify(
        self, access_token: str, installation: InstallationRecord
    ) -> None:
        try:
            identity = await _invoke(self.verify, access_token)
        except LinearTokenFailure:
            raise
        except Exception:
            raise LinearTokenFailure("linear_identity_verification_failed") from None
        viewer = identity.get("viewer") if isinstance(identity, dict) else None
        organization = identity.get("organization") if isinstance(identity, dict) else None
        if (
            not isinstance(viewer, dict)
            or viewer.get("app") is not True
            or viewer.get("id") != installation.app_user_id
            or not isinstance(organization, dict)
            or organization.get("id") != installation.organization_id
        ):
            raise LinearTokenFailure("linear_identity_drift")

    def _reject(self, installation_id: str, error_code: str) -> None:
        self.repository.reject_credentials(installation_id, error_code)
        LOGGER.error(
            "event=linear_credentials_rejected installation_id=%s error_type=token_validation "
            "error_code=%s sanitized_reason=%s action_required=true retryable=false "
            "next_action=reset_and_reconnect",
            installation_id,
            error_code,
            error_code,
        )

    def _report_transient_failure(self, installation_id: str, error_code: str) -> None:
        LOGGER.warning(
            "event=%s installation_id=%s error_type=linear_transient_failure "
            "error_code=%s sanitized_reason=%s action_required=false "
            "retryable=true next_action=retry_operation",
            error_code,
            installation_id,
            error_code,
            error_code,
        )


async def _invoke(operation: Callable[..., Any], *args: Any) -> Any:
    result = operation(*args)
    return await result if inspect.isawaitable(result) else result


async def _exchange(code: OAuthCodeExchange) -> dict[str, object]:
    return await exchange_public_code(code.code, code.verifier)
