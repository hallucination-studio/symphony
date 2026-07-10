from __future__ import annotations

from typing import Any, Awaitable, Callable

from real_symphony_e2e_common import Evidence
from real_symphony_e2e_errors import E2EFailure
from real_symphony_e2e_linear import resolve_project


ProjectResolver = Callable[[str, str], Awaitable[dict[str, Any]]]


async def verify_linear_fixture_access(
    token: str,
    requested_project: str,
    evidence: Evidence,
    *,
    resolver: ProjectResolver = resolve_project,
) -> bool:
    try:
        project = await resolver(token, requested_project)
    except E2EFailure as exc:
        evidence.check(
            "linear-fixture:project-accessible",
            False,
            failure_class=exc.failure_class,
            error_code=exc.error_code,
            sanitized_reason=exc.sanitized_reason,
            retryable=exc.retryable,
            next_action=_fixture_next_action(exc),
        )
        return False
    except Exception as exc:
        evidence.check(
            "linear-fixture:project-accessible",
            False,
            failure_class="external_service_unavailable",
            error_code="linear_fixture_probe_failed",
            sanitized_reason=f"{type(exc).__name__}: Linear fixture project probe failed",
            retryable=True,
            next_action="retry_linear_fixture_probe",
        )
        return False
    evidence.check(
        "linear-fixture:project-accessible",
        True,
        project_id=project.get("id"),
        project_slug=project.get("slugId"),
        project_name=project.get("name"),
    )
    return True


def _fixture_next_action(exc: E2EFailure) -> str:
    if exc.error_code in {"linear_authentication_failed", "linear_app_user_scope_invalid"}:
        return "refresh_linear_fixture_token"
    return exc.next_action
