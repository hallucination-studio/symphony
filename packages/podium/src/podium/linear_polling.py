from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import httpx

from .podium_dispatch import PodiumDispatchMixin
from .podium_shared import utc_now_iso


LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql"
COLD_START_LOOKBACK_SECONDS = 300

DELEGATED_ISSUES_QUERY = """
query SymphonyDelegatedIssues($projectSlug: String!, $delegateId: ID!, $updatedAfter: DateTimeOrDuration, $first: Int!) {
  issues(
    first: $first,
    orderBy: updatedAt,
    filter: {
      project: { slugId: { eq: $projectSlug } },
      delegate: { id: { eq: $delegateId } },
      updatedAt: { gte: $updatedAfter }
    }
  ) {
    nodes {
      id
      identifier
      title
      description
      createdAt
      updatedAt
      project { slugId }
      delegate { id }
      parent { id identifier }
      inverseRelations(first: 50) {
        nodes {
          type
          issue { id identifier }
          relatedIssue { id identifier }
        }
      }
    }
  }
}
"""


TransportFactory = Callable[[httpx.Request], httpx.Response]


class LinearDelegatePoller:
    def __init__(
        self,
        *,
        store: Any,
        application_id: str,
        app_token: str,
        endpoint: str = LINEAR_GRAPHQL_ENDPOINT,
        transport: TransportFactory | None = None,
        page_size: int = 50,
        initial_lookback_seconds: int = 86_400,
    ) -> None:
        self.store = store
        self.application_id = application_id.strip()
        self.app_token = app_token.strip()
        self.endpoint = endpoint
        self.transport = transport
        self.page_size = max(1, int(page_size or 50))
        self.initial_lookback_seconds = max(COLD_START_LOOKBACK_SECONDS, int(initial_lookback_seconds or 0))

    async def poll_once(self) -> dict[str, int]:
        if not self.application_id or not self.app_token:
            return {"bindings": 0, "queued": 0, "errors": 0}
        queued = 0
        errors = 0
        bindings = 0
        for binding in await self._pollable_bindings():
            bindings += 1
            binding_id = str(binding.get("project_binding_id") or binding.get("id") or "")
            try:
                state = await self.store.get_linear_poll_state(binding_id) or {}
                stored_cursor = str(state.get("cursor") or "")
                updated_after = stored_cursor or self._initial_cursor()
                issues = await self._fetch_delegated_issues(binding, updated_after=updated_after)
                binding_queued = 0
                cursor = updated_after
                for issue in _newest_first(issues):
                    if not stored_cursor and _issue_created_before(issue, updated_after):
                        continue
                    event = self._event_from_issue(binding, issue)
                    if event is None:
                        continue
                    inserted = await self._queue_dispatch(event)
                    if inserted:
                        binding_queued += 1
                    cursor = max(cursor, str(issue.get("updatedAt") or ""))
                queued += binding_queued
                await self.store.save_linear_poll_state(
                    binding_id,
                    {
                        "binding_id": binding_id,
                        "cursor": cursor,
                        "last_success_at": utc_now_iso(),
                        "last_error": "",
                        "last_issue_count": len(issues),
                    },
                )
            except Exception as exc:
                errors += 1
                state = await self.store.get_linear_poll_state(binding_id) or {"binding_id": binding_id, "cursor": ""}
                await self.store.save_linear_poll_state(
                    binding_id,
                    {
                        **state,
                        "binding_id": binding_id,
                        "last_error": _sanitize_poll_error(exc),
                        "last_issue_count": 0,
                    },
                )
        return {"bindings": bindings, "queued": queued, "errors": errors}

    async def _pollable_bindings(self) -> list[dict[str, Any]]:
        groups = await self.store.list_runtime_groups()
        result: list[dict[str, Any]] = []
        for group in groups:
            if not isinstance(group, dict):
                continue
            project_slug = str(group.get("project_slug") or "").strip()
            binding_id = str(group.get("project_binding_id") or group.get("id") or "").strip()
            workspace_id = str(group.get("linear_workspace_id") or "").strip()
            agent_id = str(group.get("linear_agent_app_user_id") or "").strip()
            if project_slug and binding_id and workspace_id and agent_id in {"", self.application_id}:
                result.append(group)
        return result

    def _initial_cursor(self) -> str:
        return (datetime.now(timezone.utc) - timedelta(seconds=self.initial_lookback_seconds)).isoformat().replace("+00:00", "Z")

    async def _fetch_delegated_issues(self, binding: dict[str, Any], *, updated_after: str) -> list[dict[str, Any]]:
        transport = httpx.MockTransport(self.transport) if self.transport is not None else None
        async with httpx.AsyncClient(timeout=30, trust_env=False, transport=transport) as client:
            response = await client.post(
                self.endpoint,
                json={
                    "query": DELEGATED_ISSUES_QUERY,
                    "variables": {
                        "projectSlug": str(binding.get("project_slug") or ""),
                        "delegateId": self.application_id,
                        "updatedAfter": updated_after,
                        "first": self.page_size,
                    },
                },
                headers={"Authorization": self.app_token, "Content-Type": "application/json"},
            )
        payload = response.json()
        if response.status_code != 200 or payload.get("errors"):
            raise RuntimeError(f"linear_poll_failed status={response.status_code} errors={payload.get('errors')}")
        nodes = (((payload.get("data") or {}).get("issues") or {}).get("nodes") or [])
        return [node for node in nodes if isinstance(node, dict)]

    def _event_from_issue(self, binding: dict[str, Any], issue: dict[str, Any]) -> dict[str, Any] | None:
        delegate = issue.get("delegate") if isinstance(issue.get("delegate"), dict) else {}
        project = issue.get("project") if isinstance(issue.get("project"), dict) else {}
        if str(delegate.get("id") or "") != self.application_id:
            return None
        if str(project.get("slugId") or "") != str(binding.get("project_slug") or ""):
            return None
        if _is_symphony_projection_issue(issue):
            return None
        issue_id = str(issue.get("id") or "")
        if not issue_id:
            return None
        return {
            "workspace_id": str(binding.get("linear_workspace_id") or ""),
            "project_slug": str(binding.get("project_slug") or ""),
            "issue_id": issue_id,
            "issue_identifier": str(issue.get("identifier") or ""),
            "issue_title": str(issue.get("title") or ""),
            "issue_description": str(issue.get("description") or ""),
            "agent_session_id": "",
            "agent_app_user_id": self.application_id,
            "issue_delegate_id": str(delegate.get("id") or ""),
            "blocked_by": _blocked_by_ids(issue),
            "parent_issue_id": _parent_issue_id(issue),
            "managed_run_intent": {},
        }

    async def _queue_dispatch(self, event: dict[str, Any]) -> bool:
        groups = await PodiumDispatchMixin._runtime_groups_for_dispatch_event(self, event)
        inserted = False
        for group in groups:
            project_binding_id = str(group.get("project_binding_id") or group["id"])
            dispatch = {
                "dispatch_id": f"dispatch_linear_poll_{event['issue_id']}_{project_binding_id}".replace(":", "_"),
                "runtime_group_id": group["id"],
                "project_binding_id": project_binding_id,
                "user_id": str(group.get("linear_workspace_id") or event["workspace_id"]),
                "issue_id": event["issue_id"],
                "issue_identifier": event.get("issue_identifier") or "",
                "issue_title": event.get("issue_title") or "",
                "issue_description": event.get("issue_description") or "",
                "linear_workspace_id": event["workspace_id"],
                "project_slug": event["project_slug"],
                "agent_session_id": "",
                "agent_app_user_id": event.get("agent_app_user_id") or "",
                "routing_rule_id": group["id"],
                "managed_run_profile": group.get("managed_run_profile") or "default",
                "blocked_by": list(event.get("blocked_by") or []),
                "parent_issue_id": event.get("parent_issue_id") or "",
                "managed_run_intent": dict(event.get("managed_run_intent") or {}),
                "status": "queued",
                "reason": "",
                "run_id": "",
                "active_work_item_id": "",
                "managed_run_state": "",
                "plan_version": 0,
                "backend_session_id": "",
                "leased_runtime_id": None,
                "leased_until": None,
                "fencing_token": 0,
                "created_at": utc_now_iso(),
                "updated_at": utc_now_iso(),
            }
            if await self.store.upsert_dispatch(dispatch):
                binding = await PodiumDispatchMixin._binding_for_group(self, group)
                conductor_id = str((binding or {}).get("conductor_id") or "")
                if conductor_id:
                    await self.store.append_runtime_command(
                        conductor_id,
                        {"type": "dispatch.available", "project_binding_id": project_binding_id, "instance_id": (binding or {}).get("instance_id")},
                    )
                inserted = True
        return inserted

    def _runtime_group_from_project_binding(self, binding: dict[str, Any]) -> dict[str, Any]:
        binding_id = str(binding.get("id") or "")
        return {
            "id": binding_id,
            "linear_workspace_id": str(binding.get("user_id") or ""),
            "project_slug": str(binding.get("project_slug") or ""),
            "linear_agent_app_user_id": str(binding.get("agent_app_user_id") or ""),
            "managed_run_profile": str(binding.get("managed_run_profile") or "default"),
            "project_binding_id": binding_id,
        }


async def run_linear_delegate_poll_loop(poller: LinearDelegatePoller, *, interval_seconds: float) -> None:
    interval = max(1.0, float(interval_seconds or 1.0))
    while True:
        await poller.poll_once()
        await asyncio.sleep(interval)


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


def _sanitize_poll_error(exc: Exception) -> str:
    return f"{type(exc).__name__}: {str(exc)[:300]}"


def _newest_first(issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(issues, key=lambda issue: str(issue.get("updatedAt") or ""), reverse=True)


def _issue_created_before(issue: dict[str, Any], cursor: str) -> bool:
    created_at = str(issue.get("createdAt") or "")
    return bool(created_at and created_at < cursor)


def _is_symphony_projection_issue(issue: dict[str, Any]) -> bool:
    title = str(issue.get("title") or "").strip()
    description = str(issue.get("description") or "")
    if title.startswith("[Human Action]"):
        return True
    return "symphony:run-summary:start" in description or "SYMPHONY WORK ITEM" in description
