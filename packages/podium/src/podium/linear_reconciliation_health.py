from __future__ import annotations

import logging
from typing import Any

from .linear_reconciliation_model import failure_state, initial_reconciliation_state
from .linear_reconciliation_queries import LinearReconciliationError


LOGGER = logging.getLogger("podium.linear_reconciliation")


class BindingReconciliationFailed(RuntimeError):
    def __init__(
        self,
        cause: Exception,
        queued: int,
        *,
        expected_state: dict[str, Any] | None,
        state_loaded: bool,
    ) -> None:
        super().__init__(str(cause))
        self.cause = cause
        self.queued = queued
        self.expected_state = expected_state
        self.state_loaded = state_loaded


async def update_installation_health(
    state: Any,
    installation: dict[str, Any],
    *,
    retry_while_binding_state: dict[str, Any] | None = None,
    **changes: Any,
) -> bool:
    candidate = installation
    max_attempts = 2 if retry_while_binding_state is not None else 1
    for attempt in range(max_attempts):
        expected_revision = str(candidate.get("updated_at") or "")
        updated = await state.update_linear_reconciliation_health(
            candidate,
            expected_updated_at=expected_revision,
            **changes,
        )
        if _health_update_applied(updated, expected_revision, changes):
            return True
        if retry_while_binding_state is None:
            return False
        current_state = await state.store.get_linear_reconciliation_state(
            str(retry_while_binding_state["binding_id"])
        )
        if current_state != retry_while_binding_state:
            return False
        current_installation = await state.get_active_linear_installation(
            str(installation.get("user_id") or "")
        )
        if not _same_installation(current_installation, installation):
            return False
        if _installation_health_matches(current_installation, changes):
            return True
        if attempt + 1 < max_attempts:
            candidate = current_installation
    raise LinearReconciliationError(
        "linear_reconciliation_health_contention",
        "Linear reconciliation health contention exceeded the retry limit",
    )


async def record_binding_error(
    state: Any,
    installation: dict[str, Any],
    binding: dict[str, Any],
    failure: BindingReconciliationFailed,
) -> bool:
    if not failure.state_loaded:
        raise failure.cause
    binding_id = str(binding["id"])
    error = failure.cause
    code, reason = _visible_error(error)
    failed = failure_state(
        {
            **initial_reconciliation_state(binding_id),
            **(failure.expected_state or {}),
        },
        binding_id,
        code,
        reason,
    )
    committed = await state.store.commit_linear_reconciliation_page(
        binding_id,
        expected_state=failure.expected_state,
        expected_installation_id=str(installation.get("id") or ""),
        expected_agent_app_user_id=str(installation.get("app_user_id") or ""),
        state=failed,
        observations=[],
        dispatches=[],
    )
    if committed is None:
        _log_stale_failure(installation, binding_id, error, code, "superseded_reconciliation_failure")
        return False
    health_updated = await update_installation_health(
        state,
        installation,
        retry_while_binding_state=failed,
        reconciliation_state="degraded",
        reconciliation_error_code=code,
        reconciliation_error=reason,
        reconciliation_retry_count=int(failed["retry_count"]),
        reconciliation_next_retry_at=failed["next_retry_at"],
    )
    if not health_updated:
        _log_stale_failure(installation, binding_id, error, code, "superseded_during_health_update")
        return False
    _log_binding_failure(installation, binding_id, error, code, reason, failed)
    return True


def _same_installation(current: Any, expected: dict[str, Any]) -> bool:
    return bool(
        isinstance(current, dict)
        and str(current.get("id") or "") == str(expected.get("id") or "")
    )


def _health_update_applied(updated: Any, revision: str, changes: dict[str, Any]) -> bool:
    return bool(
        isinstance(updated, dict)
        and str(updated.get("updated_at") or "") != revision
        and _installation_health_matches(updated, changes)
    )


def _installation_health_matches(installation: dict[str, Any], changes: dict[str, Any]) -> bool:
    return bool(
        str(installation.get("reconciliation_state") or "")
        == str(changes.get("reconciliation_state") or "")
        and str(installation.get("reconciliation_error_code") or "")
        == str(changes.get("reconciliation_error_code") or "")
        and int(installation.get("reconciliation_retry_count") or 0)
        == int(changes.get("reconciliation_retry_count") or 0)
    )


def _visible_error(error: Exception) -> tuple[str, str]:
    code = str(getattr(error, "code", "linear_reconciliation_failed"))
    reason = str(
        getattr(error, "reason", "")
        or f"Linear reconciliation failed ({type(error).__name__})"
    )
    return code[:64], reason.replace("\n", " ").replace("\r", " ")[:300]


def _log_stale_failure(
    installation: dict[str, Any],
    binding_id: str,
    error: Exception,
    code: str,
    reason: str,
) -> None:
    LOGGER.info(
        "event=linear_reconciliation_stale_failure_discarded "
        "installation_id=%s binding_id=%s error_type=%s error_code=%s "
        "sanitized_reason=%s action_required=none retryable=false "
        "next_action=keep_newer_state",
        installation.get("id"), binding_id, type(error).__name__, code, reason,
    )


def _log_binding_failure(
    installation: dict[str, Any],
    binding_id: str,
    error: Exception,
    code: str,
    reason: str,
    failed: dict[str, Any],
) -> None:
    LOGGER.warning(
        "event=linear_reconciliation_failed installation_id=%s binding_id=%s "
        "error_type=%s error_code=%s sanitized_reason=%s action_required=retry "
        "retryable=true attempt_number=%s next_action=retry_reconciliation",
        installation.get("id"), binding_id, type(error).__name__, code, reason,
        failed["retry_count"],
    )
