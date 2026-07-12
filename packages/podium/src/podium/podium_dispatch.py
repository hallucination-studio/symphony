from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from .linear_reconciliation_model import active_blocker_ids
from .linear_reconciliation_queries import DISPATCH_BLOCKERS_QUERY
from .podium_shared import runtime_group_alias, utc_now_iso


LOGGER = logging.getLogger(__name__)
ACTIVE_BLOCKERS_REASON = "active_linear_blockers"
BLOCKER_CHECK_FAILED_REASON = "linear_blocker_check_failed"


class LinearBlockerCheckError(RuntimeError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


class PodiumDispatchMixin:
    def reconciliation_dispatch(self, event: dict[str, Any], binding: dict[str, Any]) -> dict[str, Any]:
        return self._dispatch_from_event(event, binding)

    def _dispatch_from_event(self, event: dict[str, Any], binding: dict[str, Any]) -> dict[str, Any]:
        project_binding_id = str(binding["id"])
        now = utc_now_iso()
        blockers = list(event.get("blocked_by") or [])
        return {
            "dispatch_id": f"dispatch_{secrets.token_urlsafe(18)}",
            "project_binding_id": project_binding_id,
            "user_id": str(binding.get("user_id") or event["workspace_id"]),
            "issue_id": event["issue_id"],
            "issue_identifier": event["issue_identifier"],
            "issue_title": event.get("issue_title") or "",
            "issue_description": event.get("issue_description") or "",
            "linear_workspace_id": event["workspace_id"],
            "project_slug": event["project_slug"],
            "agent_app_user_id": event.get("agent_app_user_id") or "",
            "routing_rule_id": project_binding_id,
            "blocked_by": blockers,
            "parent_issue_id": event.get("parent_issue_id") or "",
            "managed_run_intent": dict(event.get("managed_run_intent") or {}),
            "intake_key": str(event.get("intake_key") or f"linear-issue:{event['issue_id']}"),
            "status": "queued",
            "reason": ACTIVE_BLOCKERS_REASON if blockers else "",
            "run_id": "",
            "active_work_item_id": "",
            "managed_run_state": "",
            "plan_version": 0,
            "backend_session_id": "",
            "leased_runtime_id": None,
            "leased_until": None,
            "fencing_token": 0,
            "created_at": now,
            "updated_at": now,
        }

    async def lease_dispatch(self, runtime_id: str) -> dict[str, Any] | None:
        runtime = await self.store.get_runtime(runtime_id)
        if runtime is None:
            return None
        binding_ids = [
            str(binding.get("id") or "")
            for binding in await self.store.list_project_bindings_for_conductor(runtime_id)
            if str(binding.get("id") or "")
        ]
        leased = await self.store.lease_dispatch(
            runtime_id,
            binding_ids=sorted(binding_ids),
            lease_until=(datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat().replace("+00:00", "Z"),
        )
        if leased is None:
            return None
        binding: dict[str, Any] | None = None
        try:
            binding = await self.store.get_project_binding(str(leased.get("project_binding_id") or ""))
            blockers = await self._live_blocker_ids(leased, binding)
        except Exception as exc:
            self._log_blocker_check_failure(leased, exc)
            await self._requeue_after_blocker_check(
                runtime_id,
                leased,
                list(leased.get("blocked_by") or []),
                reason=BLOCKER_CHECK_FAILED_REASON,
            )
            return None
        if blockers:
            await self._requeue_after_blocker_check(
                runtime_id,
                leased,
                blockers,
                reason=ACTIVE_BLOCKERS_REASON,
            )
            LOGGER.info(
                "event=podium_dispatch_waiting_for_linear_blockers runtime_id=%s dispatch_id=%s "
                "issue_id=%s blocker_count=%s action_required=none retryable=false "
                "next_action=wait_for_linear_blocker",
                runtime_id,
                leased.get("dispatch_id"),
                leased.get("issue_id"),
                len(blockers),
            )
            return None
        leased.update(
            {
                "runtime_group_id": runtime_group_alias(runtime_id),
                "routing_rule_id": str(leased.get("project_binding_id") or ""),
                "blocked_by": [],
                "parent_issue_id": str(leased.get("parent_issue_id") or ""),
                "instance_id": str((binding or {}).get("instance_id") or ""),
            }
        )
        return leased

    async def refresh_blocked_dispatches(
        self,
        installation: dict[str, Any],
        binding: dict[str, Any],
    ) -> int:
        refreshed = 0
        for dispatch in await self.store.list_dispatches_requiring_blocker_recheck(str(binding.get("id") or "")):
            try:
                blockers = await self._active_blocker_ids_for_issue(installation, str(dispatch.get("issue_id") or ""))
            except Exception as exc:
                self._log_blocker_check_failure(dispatch, exc)
                await self.store.update_dispatch_blockers(
                    str(dispatch.get("dispatch_id") or ""),
                    list(dispatch.get("blocked_by") or []),
                    reason=BLOCKER_CHECK_FAILED_REASON,
                )
                raise
            updated = await self.store.update_dispatch_blockers(
                str(dispatch.get("dispatch_id") or ""),
                blockers,
                reason=ACTIVE_BLOCKERS_REASON if blockers else "",
            )
            refreshed += int(updated is not None)
        return refreshed

    async def _live_blocker_ids(
        self,
        dispatch: dict[str, Any],
        binding: dict[str, Any] | None,
    ) -> list[str]:
        if binding is None:
            raise LinearBlockerCheckError(
                "linear_blocker_check_binding_missing",
                "Dispatch project binding is unavailable",
            )
        installation = await self.get_active_linear_installation(str(dispatch.get("user_id") or ""))
        if installation is None:
            raise LinearBlockerCheckError(
                "linear_blocker_check_installation_missing",
                "Active Linear installation is unavailable",
            )
        if (
            str(binding.get("installation_id") or "") != str(installation.get("id") or "")
            or str(binding.get("agent_app_user_id") or "") != str(installation.get("app_user_id") or "")
        ):
            raise LinearBlockerCheckError(
                "linear_blocker_check_installation_mismatch",
                "Dispatch binding no longer matches the active Linear installation",
            )
        return await self._active_blocker_ids_for_issue(installation, str(dispatch.get("issue_id") or ""))

    async def _active_blocker_ids_for_issue(
        self,
        installation: dict[str, Any],
        issue_id: str,
    ) -> list[str]:
        if not issue_id:
            raise LinearBlockerCheckError(
                "linear_blocker_check_issue_missing",
                "Dispatch issue is unavailable",
            )
        blockers: set[str] = set()
        after: str | None = None
        seen_cursors: set[str] = set()
        while True:
            data = await self.linear_graphql_for_installation(
                installation,
                query=DISPATCH_BLOCKERS_QUERY,
                variables={"issueId": issue_id, "after": after},
                operation_name="SymphonyDispatchBlockers",
            )
            relations, has_next_page, end_cursor = _blocker_relation_page(data)
            blockers.update(active_blocker_ids({"inverseRelations": relations}))
            if not has_next_page:
                return sorted(blockers)
            if not end_cursor or end_cursor in seen_cursors:
                raise LinearBlockerCheckError(
                    "linear_blocker_check_pagination_invalid",
                    "Linear blocker pagination did not advance",
                )
            seen_cursors.add(end_cursor)
            after = end_cursor

    async def _requeue_after_blocker_check(
        self,
        runtime_id: str,
        dispatch: dict[str, Any],
        blockers: list[str],
        *,
        reason: str,
    ) -> None:
        requeued = await self.store.requeue_dispatch_for_blockers(
            runtime_id,
            str(dispatch.get("dispatch_id") or ""),
            int(dispatch.get("fencing_token") or 0),
            blockers,
            reason=reason,
        )
        if requeued is None:
            LOGGER.warning(
                "event=podium_dispatch_blocker_requeue_stale runtime_id=%s dispatch_id=%s "
                "issue_id=%s error_code=stale_dispatch_lease action_required=none "
                "retryable=false next_action=ignore_stale_dispatch",
                runtime_id,
                dispatch.get("dispatch_id"),
                dispatch.get("issue_id"),
            )

    def _log_blocker_check_failure(self, dispatch: dict[str, Any], error: Exception) -> None:
        LOGGER.warning(
            "event=podium_dispatch_blocker_check_failed dispatch_id=%s issue_id=%s "
            "error_type=%s error_code=%s sanitized_reason=Linear_blocker_check_failed "
            "action_required=wait_for_linear_reconciliation retryable=true attempt_number=1 "
            "next_action=retry_linear_blocker_check",
            dispatch.get("dispatch_id"),
            dispatch.get("issue_id"),
            type(error).__name__,
            str(getattr(error, "code", BLOCKER_CHECK_FAILED_REASON)),
        )

    async def reap_expired_dispatch_leases(self) -> int:
        return int(await self.store.reap_expired_dispatch_leases())

    async def ack_dispatch(
        self,
        runtime_id: str,
        dispatch_id: str,
        status: str,
        *,
        fencing_token: int | None = None,
        reason: str | None = None,
        managed_run: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        if fencing_token is None:
            return {"dispatch_id": dispatch_id, "_ack_error": "stale_dispatch_lease"}
        managed_run = _sanitize_managed_run_ack(managed_run or {})
        completed_at = utc_now_iso() if status in {"completed", "failed", "cancelled", "canceled"} else None
        saved = await self.store.ack_dispatch(
            runtime_id,
            dispatch_id,
            status,
            fencing_token=fencing_token,
            reason=reason or "",
            managed_run=managed_run,
            completed_at=completed_at,
        )
        if saved is None:
            return {"dispatch_id": dispatch_id, "_ack_error": "stale_dispatch_lease"}
        return saved

def _sanitize_managed_run_ack(payload: dict[str, Any]) -> dict[str, Any]:
    sanitized: dict[str, Any] = {}
    for key in ("run_id", "parent_issue_id", "active_work_item_id", "managed_run_state", "backend_session_id"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            sanitized[key] = value[:256]
    for key in ("plan_version",):
        try:
            sanitized[key] = int(payload.get(key) or 0)
        except (TypeError, ValueError):
            sanitized[key] = 0
    return sanitized


def _blocker_relation_page(data: dict[str, Any]) -> tuple[dict[str, Any], bool, str]:
    issue = data.get("issue") if isinstance(data.get("issue"), dict) else None
    relations = issue.get("inverseRelations") if isinstance(issue, dict) else None
    if not isinstance(relations, dict) or not isinstance(relations.get("nodes"), list):
        raise LinearBlockerCheckError(
            "linear_blocker_check_invalid_response",
            "Linear blocker check returned invalid data",
        )
    page_info = relations.get("pageInfo")
    if not isinstance(page_info, dict) or not isinstance(page_info.get("hasNextPage"), bool):
        raise LinearBlockerCheckError(
            "linear_blocker_check_invalid_response",
            "Linear blocker check returned invalid pagination",
        )
    for relation in relations["nodes"]:
        if not isinstance(relation, dict) or not isinstance(relation.get("type"), str):
            raise LinearBlockerCheckError(
                "linear_blocker_check_invalid_response",
                "Linear blocker check returned invalid relation data",
            )
        if relation["type"] != "blocks":
            continue
        blocker = relation.get("issue")
        state = blocker.get("state") if isinstance(blocker, dict) else None
        if not isinstance(blocker, dict) or not str(blocker.get("id") or "") or not isinstance(state, dict):
            raise LinearBlockerCheckError(
                "linear_blocker_check_invalid_response",
                "Linear blocker check returned invalid blocker data",
            )
        if not isinstance(state.get("type"), str):
            raise LinearBlockerCheckError(
                "linear_blocker_check_invalid_response",
                "Linear blocker check returned invalid blocker state",
            )
    return relations, page_info["hasNextPage"], str(page_info.get("endCursor") or "")
