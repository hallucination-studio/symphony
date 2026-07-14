from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, NoReturn

import httpx

from .linear_constants import LINEAR_REQUIRED_SCOPES, LINEAR_TOKEN_URL, normalize_scopes
from .linear_graphql_client import LinearGraphQLRequestError, execute_linear_graphql
from .linear_installation_acceptance import invoke_hook
from .podium_shared import utc_now_iso


LOGGER = logging.getLogger(__name__)
REFRESH_SKEW = timedelta(minutes=5)
LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke"
DISCONNECT_BOUND_REASON = "Unbind active projects before disconnecting Linear"
DISCONNECT_WORK_REASON = "Wait for managed work to finish before disconnecting Linear"


class LinearTokenUnavailable(RuntimeError):
    def __init__(
        self,
        code: str,
        reason: str,
        *,
        next_action: str = "",
    ) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason
        self.next_action = next_action


class PodiumLinearTokenMixin:
    async def linear_access_token(
        self,
        installation: dict[str, Any],
        *,
        force_refresh: bool = False,
        rejected_access_token: str = "",
    ) -> str:
        _require_available(installation)
        if not force_refresh and not _expires_soon(installation.get("expires_at")):
            return _required_access_token(installation)
        installation_id = str(installation.get("id") or "")
        async with self.store.linear_installation_token_lock(installation_id):
            current = await self.get_active_linear_installation(str(installation.get("user_id") or ""))
            if current is None or str(current.get("id") or "") != installation_id:
                raise LinearTokenUnavailable("linear_installation_inactive", "Linear installation is not active")
            _require_available(current)
            if rejected_access_token and current.get("access_token") != rejected_access_token:
                return _required_access_token(current)
            if not force_refresh and not _expires_soon(current.get("expires_at")):
                return _required_access_token(current)
            return await self._refresh_linear_access_token(current)

    async def _refresh_linear_access_token(self, installation: dict[str, Any]) -> str:
        application = await self.get_linear_application_config(str(installation["application_config_id"]))
        if application is None:
            await self._mark_linear_reauthorization_required_locked(
                installation,
                "linear_application_missing",
            )
            raise LinearTokenUnavailable("linear_reauthorization_required", "Linear application is unavailable")
        try:
            hook = getattr(self, "linear_token_refresh", None)
            payload = (
                await invoke_hook(hook, installation["refresh_token"], application)
                if hook is not None
                else await refresh_linear_token(installation["refresh_token"], application)
            )
            metadata = _validated_refresh(payload, installation)
        except Exception as exc:
            await self._mark_linear_reauthorization_required_locked(
                installation,
                "linear_token_refresh_failed",
            )
            LOGGER.error(
                "event=linear_token_refresh_failed installation_id=%s error_type=%s error_code=linear_reauthorization_required "
                "sanitized_reason=Linear_token_refresh_failed action_required=reauthorize retryable=false next_action=reauthorize",
                installation.get("id"),
                type(exc).__name__,
            )
            raise LinearTokenUnavailable(
                "linear_reauthorization_required",
                "Linear authorization must be renewed",
            ) from exc
        updated = {
            **installation,
            **metadata,
            "state": "ready",
            "error_code": "",
            "sanitized_reason": "",
            "retryable": False,
            "action_required": "",
            "next_action": "",
            "updated_at": utc_now_iso(),
        }
        await self.save_linear_installation_record(updated)
        LOGGER.info("event=linear_token_refreshed installation_id=%s", installation.get("id"))
        return str(updated["access_token"])

    async def mark_linear_reauthorization_required(self, installation: dict[str, Any], cause: str) -> None:
        installation_id = str(installation.get("id") or "")
        async with self.store.linear_installation_token_lock(installation_id):
            current = await self.get_active_linear_installation(
                str(installation.get("user_id") or "")
            )
            if current is None or str(current.get("id") or "") != installation_id:
                LOGGER.warning(
                    "event=linear_reauthorization_marker_ignored installation_id=%s "
                    "error_code=linear_installation_inactive sanitized_reason=Linear_installation_is_not_active "
                    "action_required=none retryable=false next_action=none cause=%s",
                    installation_id,
                    cause,
                )
                return
            await self._mark_linear_reauthorization_required_locked(current, cause)

    async def _mark_linear_reauthorization_required_locked(
        self,
        installation: dict[str, Any],
        cause: str,
    ) -> None:
        await self.save_linear_installation_record(
            {
                **installation,
                "state": "reauthorization_required",
                "error_code": "linear_reauthorization_required",
                "sanitized_reason": "Linear authorization must be renewed",
                "retryable": False,
                "action_required": "reauthorize",
                "next_action": "reauthorize",
                "updated_at": utc_now_iso(),
            }
        )
        LOGGER.error(
            "event=linear_reauthorization_required installation_id=%s error_code=linear_reauthorization_required "
            "sanitized_reason=Linear_authorization_must_be_renewed action_required=reauthorize retryable=false "
            "next_action=reauthorize cause=%s",
            installation.get("id"),
            cause,
        )

    async def linear_graphql_for_installation(
        self,
        installation: dict[str, Any],
        *,
        query: str,
        variables: dict[str, Any],
        operation_name: str,
    ) -> dict[str, Any]:
        token = await self.linear_access_token(installation)
        try:
            return await execute_linear_graphql(
                access_token=token,
                query=query,
                variables=variables,
                operation_name=operation_name,
                transport=self.linear_graphql_transport,
            )
        except LinearGraphQLRequestError as exc:
            if exc.status_code != 401:
                raise
        refreshed = await self.linear_access_token(
            installation,
            force_refresh=True,
            rejected_access_token=token,
        )
        try:
            return await execute_linear_graphql(
                access_token=refreshed,
                query=query,
                variables=variables,
                operation_name=operation_name,
                transport=self.linear_graphql_transport,
            )
        except LinearGraphQLRequestError as exc:
            if exc.status_code == 401:
                current = await self.get_active_linear_installation(str(installation.get("user_id") or ""))
                if current is not None:
                    await self.mark_linear_reauthorization_required(current, "linear_token_rejected_after_refresh")
            raise

    async def disconnect_linear_installation(self, user_id: str) -> dict[str, Any]:
        while True:
            installation = await self.get_active_linear_installation(user_id)
            if installation is None:
                return {"state": "disconnected"}
            installation_id = str(installation["id"])
            async with self.store.linear_installation_token_lock(installation_id):
                current = await self.get_active_linear_installation(user_id)
                if current is None:
                    return {"state": "disconnected"}
                if str(current.get("id") or "") != installation_id:
                    continue
                bindings = await self.store.list_project_bindings_for_user(user_id)
                if bindings:
                    self._raise_disconnect_blocked(
                        current,
                        DISCONNECT_BOUND_REASON,
                        "unbind_projects",
                    )
                if await self._workspace_has_active_work(user_id):
                    self._raise_disconnect_blocked(
                        current,
                        DISCONNECT_WORK_REASON,
                        "wait_for_managed_work",
                    )
                disconnected, blocked = await self.store.disconnect_workspace_installation(
                    user_id,
                    installation_id,
                )
                if blocked:
                    self._raise_disconnect_blocked(
                        current,
                        DISCONNECT_BOUND_REASON,
                        "unbind_projects",
                    )
                if not disconnected:
                    continue
                await self._revoke_linear_credentials(
                    {
                        **current,
                        "active": False,
                        "state": "disconnected",
                        "updated_at": utc_now_iso(),
                    },
                    clear_selected_projects=True,
                )
                LOGGER.info(
                    "event=linear_installation_disconnected workspace_id=%s installation_id=%s",
                    user_id,
                    installation_id,
                )
                return {"state": "disconnected"}

    async def retry_linear_revocation(self, user_id: str, installation_id: str) -> dict[str, Any]:
        installation = await self.get_linear_installation_record(user_id, installation_id)
        state = str((installation or {}).get("state") or "")
        if (
            installation is not None
            and not installation.get("active")
            and state in {"disconnected", "retired"}
            and not installation.get("access_token")
            and not installation.get("refresh_token")
        ):
            return {"state": state}
        if installation is None or not state.endswith("_revocation_failed"):
            raise LinearTokenUnavailable("linear_revocation_not_retryable", "Linear revocation is not retryable")
        target_state = state.removesuffix("_revocation_failed")
        await self._revoke_linear_credentials(
            {**installation, "state": target_state, "active": False},
            clear_selected_projects=target_state == "disconnected",
        )
        return {"state": target_state}

    async def _revoke_linear_credentials(
        self,
        installation: dict[str, Any],
        *,
        clear_selected_projects: bool = False,
    ) -> None:
        hook = getattr(self, "linear_token_revoke", None)
        target_state = str(installation.get("state") or "disconnected")
        first_failure: Exception | None = None
        for token_kind in ("refresh_token", "access_token"):
            token = str(installation.get(token_kind) or "")
            if not token:
                continue
            try:
                if hook is not None:
                    await invoke_hook(hook, token, token_kind)
                else:
                    await revoke_linear_token(token, token_kind)
            except Exception as exc:
                if first_failure is None:
                    first_failure = exc
        if first_failure is not None:
            failed = {
                **installation,
                "state": f"{target_state}_revocation_failed",
                "error_code": "linear_token_revocation_failed",
                "sanitized_reason": "Linear credential revocation failed",
                "retryable": True,
                "action_required": "retry_revocation",
                "next_action": "retry_revocation",
                "updated_at": utc_now_iso(),
            }
            await self.save_linear_installation_record(failed)
            LOGGER.error(
                "event=linear_token_revocation_failed installation_id=%s error_type=%s error_code=linear_token_revocation_failed "
                "sanitized_reason=Linear_credential_revocation_failed action_required=retry_revocation retryable=true next_action=retry_revocation",
                installation.get("id"),
                type(first_failure).__name__,
            )
            raise LinearTokenUnavailable(
                "linear_token_revocation_failed",
                "Linear credential revocation failed",
                next_action="retry_revocation",
            ) from first_failure
        blocked = await self.save_linear_installation_record(
            {
                **installation,
                "access_token": "",
                "refresh_token": "",
                "error_code": "",
                "sanitized_reason": "",
                "retryable": False,
                "action_required": "",
                "next_action": "",
                "updated_at": utc_now_iso(),
            },
            reauthorized_projects=[] if clear_selected_projects else None,
        )
        if blocked:
            self._raise_disconnect_blocked(
                installation,
                DISCONNECT_BOUND_REASON,
                "unbind_projects",
            )
        LOGGER.info(
            "event=linear_token_revocation_completed installation_id=%s target_state=%s",
            installation.get("id"),
            target_state,
        )

    def _raise_disconnect_blocked(
        self,
        installation: dict[str, Any],
        reason: str,
        next_action: str,
    ) -> NoReturn:
        LOGGER.warning(
            "event=linear_disconnect_blocked installation_id=%s error_type=LinearTokenUnavailable "
            "error_code=linear_disconnect_in_use sanitized_reason=%s action_required=%s "
            "retryable=false next_action=%s",
            installation.get("id"),
            reason.replace(" ", "_"),
            next_action,
            next_action,
        )
        raise LinearTokenUnavailable(
            "linear_disconnect_in_use",
            reason,
            next_action=next_action,
        )


async def refresh_linear_token(refresh_token: str, application: dict[str, Any]) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
        response = await client.post(
            LINEAR_TOKEN_URL,
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": application["client_id"],
                "client_secret": application["client_secret"],
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if response.status_code != 200:
        raise LinearTokenUnavailable("linear_token_refresh_failed", "Linear token refresh failed")
    payload = response.json()
    if not isinstance(payload, dict):
        raise LinearTokenUnavailable("linear_token_refresh_failed", "Linear token refresh returned invalid data")
    return payload


async def revoke_linear_token(token: str, token_type_hint: str) -> None:
    async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
        response = await client.post(
            LINEAR_REVOKE_URL,
            data={"token": token, "token_type_hint": token_type_hint},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if response.status_code not in {200, 204}:
        raise LinearTokenUnavailable("linear_token_revocation_failed", "Linear credential revocation failed")


def _validated_refresh(payload: Any, installation: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("invalid refresh response")
    access_token = str(payload.get("access_token") or "")
    refresh_token = str(payload.get("refresh_token") or "")
    token_type = str(payload.get("token_type") or "Bearer")
    scopes = normalize_scopes(payload.get("scope")) or set(installation.get("scope") or [])
    expires_in = int(payload.get("expires_in") or 0)
    if not access_token or not refresh_token or token_type.lower() != "bearer" or expires_in <= 0:
        raise ValueError("invalid refresh metadata")
    if scopes != LINEAR_REQUIRED_SCOPES:
        raise ValueError("invalid refresh scopes")
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "Bearer",
        "scope": sorted(scopes),
        "expires_at": expires_at.isoformat().replace("+00:00", "Z"),
    }


def _expires_soon(value: Any) -> bool:
    try:
        expires_at = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
        if expires_at.tzinfo is None:
            return True
    except (TypeError, ValueError):
        return True
    return expires_at <= datetime.now(timezone.utc) + REFRESH_SKEW


def _require_available(installation: dict[str, Any]) -> None:
    if installation.get("state") == "reauthorization_required":
        raise LinearTokenUnavailable("linear_reauthorization_required", "Linear authorization must be renewed")


def _required_access_token(installation: dict[str, Any]) -> str:
    token = str(installation.get("access_token") or "")
    if not token:
        raise LinearTokenUnavailable("linear_reauthorization_required", "Linear authorization must be renewed")
    return token
