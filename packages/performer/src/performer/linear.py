from __future__ import annotations

import json
from typing import Any

import httpx

from performer_api.config import TrackerConfig
from .linear_client_comments import LinearCommentMixin
from .linear_client_issues import LinearIssueMixin
from .linear_client_labels import LinearLabelMixin
from .linear_client_relations import LinearRelationMixin
from .linear_errors import LinearError
from .linear_queries import *  # noqa: F403
from .linear_models import *  # noqa: F403



class LinearClient(LinearCommentMixin, LinearIssueMixin, LinearRelationMixin, LinearLabelMixin):
    def __init__(
        self,
        endpoint: str,
        api_key: str,
        *,
        timeout_ms: int = 30_000,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.endpoint = endpoint
        self.api_key = api_key
        self.timeout = timeout_ms / 1000
        self._transport = transport

    async def graphql(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        headers = {"Authorization": self.api_key, "Content-Type": "application/json"}
        try:
            async with httpx.AsyncClient(timeout=self.timeout, transport=self._transport, trust_env=False) as client:
                response = await client.post(
                    self.endpoint,
                    json={"query": query, "variables": variables or {}},
                    headers=headers,
                )
        except httpx.HTTPError as exc:
            raise LinearError("linear_api_request", str(exc)) from exc

        if response.status_code != 200:
            raise LinearError("linear_api_status", f"Linear returned HTTP {response.status_code}")
        try:
            payload = response.json()
        except json.JSONDecodeError as exc:
            raise LinearError("linear_unknown_payload", "Linear response was not valid JSON") from exc
        if not isinstance(payload, dict):
            raise LinearError("linear_unknown_payload", "Linear response was not an object")
        if payload.get("errors") and payload.get("data") is None:
            raise LinearError("linear_graphql_errors", str(payload["errors"]))
        return payload



class LinearTracker:
    def __init__(
        self,
        config: TrackerConfig,
        *,
        client: LinearClient | None = None,
    ):
        self.config = config
        self.client = client or LinearClient(config.endpoint, config.api_key)

    def update_config(self, config: TrackerConfig) -> None:
        if config.endpoint != self.config.endpoint or config.api_key != self.config.api_key:
            self.client = LinearClient(config.endpoint, config.api_key)
        self.config = config

    async def fetch_issue_states_by_ids(self, issue_ids: list[str]) -> list[Issue]:
        return await self.client.fetch_issue_states_by_ids(self.config, issue_ids)

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, Any]:
        return await self.client.comment_issue(issue_id, body)

    async def update_issue_comment_marker_block(
        self,
        issue_id: str,
        marker_name: str,
        block: str,
    ) -> dict[str, Any]:
        return await self.client.update_issue_comment_marker_block(issue_id, marker_name, block)

    async def agent_activity_create(
        self,
        *,
        agent_session_id: str,
        content: dict[str, Any],
    ) -> dict[str, Any]:
        return await self.client.agent_activity_create(
            agent_session_id=agent_session_id,
            content=content,
        )

    async def fetch_issue_comments(self, issue_id: str, *, first: int = 20) -> list[dict[str, Any]]:
        return await self.client.fetch_issue_comments(issue_id, first=first)

    async def transition_issue(self, issue_id: str, state_id: str) -> dict[str, Any]:
        return await self.client.transition_issue(issue_id, state_id)

    async def transition_issue_by_state_name(self, issue_id: str, state_name: str) -> dict[str, Any]:
        return await self.client.transition_issue_by_state_name(issue_id, state_name)

    async def update_issue_description_marker_block(
        self,
        issue_id: str,
        marker_name: str,
        block: str,
    ) -> dict[str, Any]:
        return await self.client.update_issue_description_marker_block(issue_id, marker_name, block)

    async def create_issue(
        self,
        *,
        team_id: str,
        project_id: str,
        state_id: str,
        label_ids: list[str],
        title: str,
        description: str,
        parent_id: str | None = None,
        assignee_id: str | None = None,
        delegate_id: str | None = None,
    ) -> dict[str, Any]:
        return await self.client.create_issue(
            team_id=team_id,
            project_id=project_id,
            state_id=state_id,
            label_ids=label_ids,
            title=title,
            description=description,
            parent_id=parent_id,
            assignee_id=assignee_id,
            delegate_id=delegate_id,
        )

    async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, Any]]:
        return await self.client.fetch_child_issues(parent_issue_id, label_name=label_name)

    async def create_child_issue_for(
        self,
        *,
        parent_issue_id: str,
        title: str,
        description: str,
        label_names: list[str],
        delegate_id: str | None = None,
        assignee_id: str | None = None,
    ) -> dict[str, Any]:
        return await self.client.create_child_issue_for(
            parent_issue_id=parent_issue_id,
            title=title,
            description=description,
            label_names=label_names,
            assignee_id=assignee_id,
            delegate_id=delegate_id,
        )

    async def create_issue_relation(
        self,
        *,
        issue_id: str,
        related_issue_id: str,
        relation_type: str,
    ) -> dict[str, Any]:
        return await self.client.create_issue_relation(
            issue_id=issue_id,
            related_issue_id=related_issue_id,
            relation_type=relation_type,
        )

    async def ensure_issue_relation(
        self,
        *,
        issue_id: str,
        related_issue_id: str,
        relation_type: str,
    ) -> dict[str, Any]:
        return await self.client.ensure_issue_relation(
            issue_id=issue_id,
            related_issue_id=related_issue_id,
            relation_type=relation_type,
        )

    async def set_issue_pipeline_label(self, issue_id: str, label_name: str) -> dict[str, Any]:
        return await self.client.set_issue_pipeline_label(issue_id, label_name)
