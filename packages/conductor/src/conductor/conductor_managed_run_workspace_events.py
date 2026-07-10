from __future__ import annotations

import logging
from typing import Any

from .conductor_managed_run_driver_helpers import _redact_secret_text


LOGGER = logging.getLogger("conductor.managed_run_workspace")


def log_workspace_failure(
    run: dict[str, Any],
    instance: Any,
    *,
    work_item_id: str,
    reason: str,
    attempt: dict[str, Any] | None = None,
    branch_name: str = "",
) -> None:
    attempt = attempt or {}
    context = attempt.get("turn_context") if isinstance(attempt.get("turn_context"), dict) else {}
    sanitized_reason = _sanitize_reason(reason)
    LOGGER.error(
        "event=managed_run_workspace_failed run_id=%s instance_id=%s work_item_id=%s attempt_id=%s turn_id=%s lease_id=%s fencing_token=%s policy_revision=%s plan_version=%s branch_name=%s error_code=%s sanitized_reason=%s action_required=inspect_workspace retryable=false next_action=inspect_workspace",
        run.get("run_id") or "-",
        getattr(instance, "id", "-") or "-",
        work_item_id or "-",
        attempt.get("attempt_id") or "-",
        context.get("turn_id") or attempt.get("turn_id") or "-",
        context.get("lease_id") or attempt.get("lease_id") or "-",
        context.get("fencing_token") or attempt.get("fencing_token") or "-",
        context.get("policy_revision") or attempt.get("policy_revision") or "-",
        context.get("plan_version") or run.get("plan_version") or "-",
        branch_name or attempt.get("branch_name") or "-",
        sanitized_reason.split(":", 1)[0],
        sanitized_reason,
    )


def _sanitize_reason(reason: str) -> str:
    return _redact_secret_text(str(reason or "workspace_failure").replace("\n", " ").replace("\r", " "))[:300]


__all__ = ["log_workspace_failure"]
