from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Protocol

from .linear_graphql_client import execute_linear_graphql
from .linear_oauth import revoke_probe_tokens
from .linear_tokens import LinearTokenFailure, LinearTokenLifecycle
from .store.linear import LinearRepository

LOGGER = logging.getLogger(__name__)

Revoker = Callable[[str, str], Awaitable[None]]
RemovalObserver = Callable[[str], Awaitable[bool]]


class TokenStartup(Protocol):
    async def startup(self, installation_id: str) -> str: ...


class LinearAuthorizationFailure(RuntimeError):
    def __init__(
        self, code: str, *, retryable: bool = False, next_action: str
    ) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable
        self.next_action = next_action


class LinearAuthorizationLifecycle:
    def __init__(
        self,
        repository: LinearRepository,
        tokens: TokenStartup,
        *,
        revoke: Revoker,
        observe_removal: RemovalObserver,
    ) -> None:
        self.repository = repository
        self.tokens = tokens
        self.revoke = revoke
        self.observe_removal = observe_removal

    async def recover(
        self, installation_id: str, *, workspace_app_exists: bool
    ) -> dict[str, str]:
        try:
            await self.tokens.startup(installation_id)
        except LinearTokenFailure as error:
            if error.code == "linear_credentials_missing" and workspace_app_exists:
                try:
                    self.repository.mark_credentials_missing(installation_id)
                except Exception as persistence_error:
                    self._raise_persistence_failure(
                        installation_id,
                        persistence_error,
                        next_action="retry_recovery",
                    )
                return {
                    "state": "credentials_missing_for_existing_installation",
                    "next_action": "open_linear_app_settings",
                }
            raise LinearAuthorizationFailure(
                error.code,
                retryable=error.code.endswith("_failed"),
                next_action=(
                    "retry_recovery"
                    if error.code.endswith("_failed")
                    else "reset_and_reconnect"
                ),
            ) from None
        return {"state": "connected", "next_action": "none"}

    async def reset_and_reconnect(
        self,
        installation_id: str,
        *,
        admin_confirmed: bool,
    ) -> dict[str, str]:
        if not admin_confirmed:
            raise LinearAuthorizationFailure(
                "linear_reset_confirmation_required",
                next_action="confirm_reset_and_reconnect",
            )
        try:
            removed = await self.observe_removal(installation_id)
        except Exception:
            removed = False
        if not removed:
            raise LinearAuthorizationFailure(
                "linear_app_removal_required",
                retryable=True,
                next_action="open_linear_app_settings",
            )
        try:
            self.repository.reset_after_removal(installation_id)
        except Exception as error:
            self._raise_persistence_failure(
                installation_id, error, next_action="retry_reset"
            )
        return {"state": "disconnected", "next_action": "start_authorization"}

    async def disconnect(self, installation_id: str) -> dict[str, str]:
        try:
            self.repository.ensure_disconnect_allowed(installation_id)
        except ValueError as error:
            if str(error) == "linear_disconnect_in_use":
                LOGGER.warning(
                    "event=linear_disconnect_blocked installation_id=%s "
                    "error_type=active_binding error_code=linear_disconnect_in_use "
                    "sanitized_reason=linear_disconnect_in_use action_required=true "
                    "retryable=false next_action=unbind_active_projects",
                    installation_id,
                )
                raise LinearAuthorizationFailure(
                    "linear_disconnect_in_use",
                    next_action="unbind_active_projects",
                ) from None
            self._raise_persistence_failure(installation_id, error)
        except Exception as error:
            self._raise_persistence_failure(installation_id, error)
        credentials = self.repository.load_credentials(installation_id)
        if credentials is not None:
            try:
                await self.revoke(credentials.access_token, credentials.refresh_token)
            except Exception:
                self._record_revocation_failure(installation_id)
                raise LinearAuthorizationFailure(
                    "linear_disconnect_revocation_failed",
                    retryable=True,
                    next_action="retry_disconnect",
                ) from None
        try:
            self.repository.disconnect(installation_id)
        except ValueError as error:
            code = str(error)
            if code == "linear_disconnect_in_use":
                raise LinearAuthorizationFailure(
                    code, next_action="unbind_active_projects"
                ) from None
            self._raise_persistence_failure(installation_id, error)
        except Exception as error:
            self._raise_persistence_failure(installation_id, error)
        return {"state": "disconnected", "next_action": "none"}

    def _record_revocation_failure(self, installation_id: str) -> None:
        try:
            self.repository.record_error(
                installation_id, "linear_disconnect_revocation_failed"
            )
        except Exception as error:
            LOGGER.error(
                "event=linear_disconnect_failure_record_failed installation_id=%s "
                "error_type=%s error_code=linear_disconnect_failure_record_failed "
                "sanitized_reason=linear_disconnect_failure_record_failed "
                "action_required=true retryable=true next_action=retry_disconnect",
                installation_id,
                type(error).__name__,
            )
        LOGGER.warning(
            "event=linear_disconnect_revocation_failed installation_id=%s "
            "error_type=linear_revocation error_code=linear_disconnect_revocation_failed "
            "sanitized_reason=linear_disconnect_revocation_failed action_required=true "
            "retryable=true next_action=retry_disconnect",
            installation_id,
        )

    def _raise_persistence_failure(
        self,
        installation_id: str,
        error: Exception,
        *,
        next_action: str = "retry_disconnect",
    ) -> None:
        LOGGER.error(
            "event=linear_authorization_persistence_failed installation_id=%s "
            "error_type=%s error_code=linear_authorization_persistence_failed "
            "sanitized_reason=linear_authorization_persistence_failed action_required=true "
            "retryable=true next_action=%s",
            installation_id,
            type(error).__name__,
            next_action,
        )
        raise LinearAuthorizationFailure(
            "linear_authorization_persistence_failed",
            retryable=True,
            next_action=next_action,
        ) from None


def default_authorization_lifecycle(
    repository: LinearRepository,
) -> LinearAuthorizationLifecycle:
    return LinearAuthorizationLifecycle(
        repository,
        LinearTokenLifecycle(repository, verify=_verify_identity),
        revoke=_revoke_pair,
        observe_removal=_removal_not_observed,
    )


async def _verify_identity(access_token: str) -> dict[str, object]:
    data = await execute_linear_graphql(
        access_token=access_token,
        query="query SymphonyLinearViewer { viewer { id app organization { id } } }",
        variables={},
        operation_name="SymphonyLinearViewer",
    )
    viewer = data.get("viewer")
    organization = viewer.get("organization") if isinstance(viewer, dict) else None
    return {"viewer": viewer, "organization": organization}


async def _revoke_pair(access_token: str, refresh_token: str) -> None:
    await revoke_probe_tokens(
        {"access_token": access_token, "refresh_token": refresh_token}
    )


async def _removal_not_observed(_installation_id: str) -> bool:
    return False
