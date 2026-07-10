from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import httpx

from .podium_shared import utc_now_iso


LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql"
COLD_START_LOOKBACK_SECONDS = 300
logger = logging.getLogger(__name__)

DELEGATED_ISSUES_QUERY = """
query SymphonyDelegatedIssues($projectId: ID!, $delegateId: ID!, $updatedAfter: DateTimeOrDuration, $first: Int!) {
  issues(
    first: $first,
    orderBy: updatedAt,
    filter: {
      project: { id: { eq: $projectId } },
      delegate: { id: { eq: $delegateId } },
      updatedAt: { gte: $updatedAfter }
    }
  ) {
    nodes {
      id identifier title description createdAt updatedAt
      project { id slugId }
      delegate { id }
      parent { id identifier }
      inverseRelations(first: 50) {
        nodes { type issue { id identifier } relatedIssue { id identifier } }
      }
    }
  }
}
"""


TransportFactory = Callable[[httpx.Request], httpx.Response]


class LinearReconciler:
    def __init__(
        self,
        *,
        state: Any,
        transport: TransportFactory | None = None,
        page_size: int = 50,
        initial_lookback_seconds: int = 0,
    ) -> None:
        self.state = state
        self.transport = transport
        self.page_size = max(1, int(page_size or 50))
        self.initial_lookback_seconds = max(
            COLD_START_LOOKBACK_SECONDS,
            int(initial_lookback_seconds or 0),
        )

    async def reconcile_once(self) -> dict[str, int]:
        totals = {"installations": 0, "bindings": 0, "queued": 0, "errors": 0}
        for installation in await self.state.list_active_linear_installations():
            totals["installations"] += 1
            result = await self._reconcile_installation(installation)
            for key in ("bindings", "queued", "errors"):
                totals[key] += result[key]
        logger.info(
            "event=linear_reconciliation_cycle installations=%s bindings=%s queued=%s errors=%s",
            totals["installations"],
            totals["bindings"],
            totals["queued"],
            totals["errors"],
        )
        return totals

    async def _reconcile_installation(self, installation: dict[str, Any]) -> dict[str, int]:
        result = {"bindings": 0, "queued": 0, "errors": 0}
        user_id = str(installation["user_id"])
        for project in await self.state.list_selected_linear_projects(user_id):
            binding = await self.state.store.get_active_project_binding_for_project(
                user_id,
                str(project["linear_project_id"]),
            )
            if binding is None or binding.get("state") != "ready":
                continue
            result["bindings"] += 1
            try:
                result["queued"] += await self._reconcile_binding(installation, project, binding)
            except Exception as exc:
                result["errors"] += 1
                await self._record_binding_error(installation, binding, exc)
        if result["errors"] == 0:
            await self.state.update_linear_installation_health(
                installation,
                reconciliation_state="healthy",
                last_reconciliation_at=utc_now_iso(),
                reconciliation_error="",
                reconciliation_retry_count=0,
            )
        return result

    async def _reconcile_binding(
        self,
        installation: dict[str, Any],
        project: dict[str, Any],
        binding: dict[str, Any],
    ) -> int:
        binding_id = str(binding["id"])
        state = await self.state.store.get_linear_reconciliation_state(binding_id) or {}
        stored_cursor = str(state.get("cursor") or "")
        updated_after = stored_cursor or self._initial_cursor()
        issues = await self._fetch_issues(installation, project, updated_after)
        queued = 0
        cursor = updated_after
        for issue in _newest_first(issues):
            if not stored_cursor and _issue_created_before(issue, updated_after):
                continue
            event = _event_from_issue(installation, project, issue)
            if event is None:
                continue
            queued += await self.state.queue_dispatches(event)
            cursor = max(cursor, str(issue.get("updatedAt") or ""))
        await self.state.store.save_linear_reconciliation_state(
            binding_id,
            {
                "binding_id": binding_id,
                "cursor": cursor,
                "last_success_at": utc_now_iso(),
                "last_error": "",
                "last_issue_count": len(issues),
            },
        )
        return queued

    async def _fetch_issues(
        self,
        installation: dict[str, Any],
        project: dict[str, Any],
        updated_after: str,
    ) -> list[dict[str, Any]]:
        payload = {
            "query": DELEGATED_ISSUES_QUERY,
            "variables": {
                "projectId": str(project["linear_project_id"]),
                "delegateId": str(installation["app_user_id"]),
                "updatedAfter": updated_after,
                "first": self.page_size,
            },
        }
        token = await self.state.linear_access_token(installation)
        response = await self._post_graphql(payload, token)
        if response.status_code == 401:
            token = await self.state.linear_access_token(
                installation,
                force_refresh=True,
                rejected_access_token=token,
            )
            response = await self._post_graphql(payload, token)
        if response.status_code == 401:
            current = await self.state.get_active_linear_installation(str(installation.get("user_id") or ""))
            if current is not None:
                await self.state.mark_linear_reauthorization_required(current, "linear_token_rejected_after_refresh")
        payload = response.json()
        if response.status_code != 200 or payload.get("errors"):
            raise RuntimeError(f"linear_reconciliation_failed status={response.status_code}")
        nodes = (((payload.get("data") or {}).get("issues") or {}).get("nodes") or [])
        return [node for node in nodes if isinstance(node, dict)]

    async def _post_graphql(self, payload: dict[str, Any], token: str) -> httpx.Response:
        transport = httpx.MockTransport(self.transport) if self.transport is not None else None
        async with httpx.AsyncClient(timeout=30, trust_env=False, transport=transport) as client:
            return await client.post(
                LINEAR_GRAPHQL_ENDPOINT,
                json=payload,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            )

    async def _record_binding_error(
        self,
        installation: dict[str, Any],
        binding: dict[str, Any],
        exc: Exception,
    ) -> None:
        binding_id = str(binding["id"])
        reason = _sanitize_error(exc)
        previous = await self.state.store.get_linear_reconciliation_state(binding_id) or {}
        await self.state.store.save_linear_reconciliation_state(
            binding_id,
            {
                **previous,
                "binding_id": binding_id,
                "last_error": reason,
                "last_issue_count": 0,
            },
        )
        await self.state.update_linear_installation_health(
            installation,
            reconciliation_state="degraded",
            reconciliation_error=reason,
            reconciliation_retry_count=int(installation.get("reconciliation_retry_count") or 0) + 1,
        )
        logger.warning(
            "event=linear_reconciliation_failed installation_id=%s work_item_id= binding_id=%s error_type=%s sanitized_reason=%s retryable=true next_action=retry_reconciliation",
            installation.get("id"),
            binding_id,
            type(exc).__name__,
            reason,
        )

    def _initial_cursor(self) -> str:
        value = datetime.now(timezone.utc) - timedelta(seconds=self.initial_lookback_seconds)
        return value.isoformat().replace("+00:00", "Z")


async def run_linear_reconciliation_loop(
    reconciler: LinearReconciler,
    *,
    interval_seconds: float,
) -> None:
    interval = max(1.0, float(interval_seconds or 1.0))
    while True:
        await reconciler.reconcile_once()
        await asyncio.sleep(interval)


def _event_from_issue(
    installation: dict[str, Any],
    project: dict[str, Any],
    issue: dict[str, Any],
) -> dict[str, Any] | None:
    delegate = issue.get("delegate") if isinstance(issue.get("delegate"), dict) else {}
    issue_project = issue.get("project") if isinstance(issue.get("project"), dict) else {}
    if str(delegate.get("id") or "") != str(installation.get("app_user_id") or ""):
        return None
    if str(issue_project.get("id") or "") != str(project.get("linear_project_id") or ""):
        return None
    if _parent_issue_id(issue) or _is_symphony_projection_issue(issue):
        return None
    return {
        "event_type": "linear.delegated_issue",
        "linear_organization_id": str(installation.get("linear_organization_id") or ""),
        "workspace_id": installation.get("user_id"),
        "linear_project_id": str(issue_project.get("id") or ""),
        "project_slug": str(project.get("project_slug") or issue_project.get("slugId") or ""),
        "issue_id": str(issue.get("id") or ""),
        "issue_identifier": str(issue.get("identifier") or ""),
        "issue_title": str(issue.get("title") or ""),
        "issue_description": str(issue.get("description") or ""),
        "agent_app_user_id": str(installation.get("app_user_id") or ""),
        "issue_delegate_id": str(delegate.get("id") or ""),
        "blocked_by": _blocked_by_ids(issue),
        "parent_issue_id": _parent_issue_id(issue),
        "managed_run_intent": {},
        "intake_key": f"linear-issue:{str(issue.get('id') or '')}",
    }


def _blocked_by_ids(issue: dict[str, Any]) -> list[str]:
    relations = issue.get("inverseRelations") if isinstance(issue.get("inverseRelations"), dict) else {}
    result: list[str] = []
    for relation in relations.get("nodes") or []:
        if not isinstance(relation, dict) or relation.get("type") != "blocks":
            continue
        blocker = relation.get("issue") if isinstance(relation.get("issue"), dict) else relation.get("relatedIssue")
        if isinstance(blocker, dict) and blocker.get("id"):
            result.append(str(blocker["id"]))
    return result


def _parent_issue_id(issue: dict[str, Any]) -> str:
    parent = issue.get("parent") if isinstance(issue.get("parent"), dict) else {}
    return str(parent.get("id") or "")


def _newest_first(issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(issues, key=lambda issue: str(issue.get("updatedAt") or ""), reverse=True)


def _issue_created_before(issue: dict[str, Any], cursor: str) -> bool:
    created_at = str(issue.get("createdAt") or "")
    return bool(created_at and created_at < cursor)


def _is_symphony_projection_issue(issue: dict[str, Any]) -> bool:
    title = str(issue.get("title") or "").strip()
    description = str(issue.get("description") or "")
    return title.startswith("[Human Action]") or "symphony:run-summary:start" in description or "SYMPHONY WORK ITEM" in description


def _sanitize_error(exc: Exception) -> str:
    return f"{type(exc).__name__}: {str(exc)[:300]}"
