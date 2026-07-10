from __future__ import annotations

from typing import Any

from performer_api.models import Issue

from .linear_errors import LinearError
from .linear_models import _normalize_issue, _preserve_managed_run_projection_label
from .linear_queries import (
    ISSUE_LABEL_BY_NAME_QUERY,
    ISSUE_LABEL_CONTEXT_QUERY,
    ISSUE_LABEL_CREATE_MUTATION,
    ISSUE_UPDATE_LABELS_MUTATION,
)


class LinearLabelMixin:
    async def set_issue_managed_run_label(self, issue_id: str, label_name: str) -> dict[str, Any]:
        if not label_name.startswith("symphony:managed-run/"):
            raise ValueError("managed-run labels must start with symphony:managed-run/")
        return await self._set_issue_managed_run_label(issue_id, label_name)

    async def _set_issue_managed_run_label(self, issue_id: str, label_name: str) -> dict[str, Any]:
        context = await self._fetch_issue_label_context(issue_id)
        target = await self._ensure_issue_label(context["team_id"], label_name)
        managed_run_prefix = "symphony:managed-run/"
        legacy_pipeline_prefix = "performer:pipeline/"
        preserved = [
            label
            for label in context["labels"]
            if not str(label.get("name") or "").lower().startswith(managed_run_prefix)
            and not str(label.get("name") or "").lower().startswith(legacy_pipeline_prefix)
            and _preserve_managed_run_projection_label(str(label.get("name") or ""))
        ]
        label_ids = [label["id"] for label in preserved if label.get("id")]
        if target["id"] not in label_ids:
            label_ids.append(target["id"])
        payload = await self.graphql(ISSUE_UPDATE_LABELS_MUTATION, {"issueId": issue_id, "labelIds": label_ids})
        result = ((payload.get("data") or {}).get("issueUpdate") or {})
        issue = result.get("issue") if isinstance(result, dict) else {}
        return {
            "success": bool(result.get("success")),
            "issue_id": issue.get("id") if isinstance(issue, dict) else None,
            "identifier": issue.get("identifier") if isinstance(issue, dict) else None,
            "label": label_name,
            "label_ids": label_ids,
        }

    async def _fetch_issue_label_context(self, issue_id: str) -> dict[str, Any]:
        payload = await self.graphql(ISSUE_LABEL_CONTEXT_QUERY, {"issueId": issue_id})
        issue = ((payload.get("data") or {}).get("issue") or {})
        team = issue.get("team") if isinstance(issue, dict) else {}
        team_id = team.get("id") if isinstance(team, dict) else None
        if not isinstance(team_id, str) or not team_id:
            raise LinearError("linear_missing_issue_team", "Linear issue.team.id missing")
        labels = (((issue.get("labels") or {}).get("nodes")) or []) if isinstance(issue, dict) else []
        return {
            "issue_id": issue.get("id") if isinstance(issue, dict) else issue_id,
            "identifier": issue.get("identifier") if isinstance(issue, dict) else None,
            "team_id": team_id,
            "labels": [label for label in labels if isinstance(label, dict)],
        }

    async def _ensure_issue_label(self, team_id: str, label_name: str) -> dict[str, str]:
        payload = await self.graphql(ISSUE_LABEL_BY_NAME_QUERY, {"name": label_name, "teamId": team_id})
        nodes = (((payload.get("data") or {}).get("issueLabels") or {}).get("nodes") or [])
        for node in nodes:
            if isinstance(node, dict) and node.get("id") and node.get("name") == label_name:
                return {"id": node["id"], "name": node["name"]}
        payload = await self.graphql(ISSUE_LABEL_CREATE_MUTATION, {"name": label_name, "teamId": team_id})
        result = ((payload.get("data") or {}).get("issueLabelCreate") or {})
        label = result.get("issueLabel") if isinstance(result, dict) else {}
        if not result.get("success") or not isinstance(label, dict) or not label.get("id"):
            raise LinearError("linear_label_create_failed", f"Could not create Linear label: {label_name}")
        return {"id": label["id"], "name": label.get("name") or label_name}

    async def _fetch_paginated(self, query: str, variables: dict[str, Any]) -> list[Issue]:
        issues: list[Issue] = []
        while True:
            payload = await self.graphql(query, variables)
            connection = ((payload.get("data") or {}).get("issues") or {})
            nodes = connection.get("nodes")
            page_info = connection.get("pageInfo") or {}
            if not isinstance(nodes, list):
                raise LinearError("linear_unknown_payload", "Linear issues.nodes missing")
            issues.extend(_normalize_issue(node) for node in nodes)
            if not page_info.get("hasNextPage"):
                return issues
            end_cursor = page_info.get("endCursor")
            if not end_cursor:
                raise LinearError("linear_missing_end_cursor", "Linear pageInfo.endCursor missing")
            variables = dict(variables)
            variables["after"] = end_cursor
