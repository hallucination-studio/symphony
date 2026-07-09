from __future__ import annotations

from typing import Any

from .linear_errors import LinearError
from .linear_models import _relation_matches
from .linear_queries import ISSUE_PIPELINE_RELATIONS_QUERY, ISSUE_RELATION_CREATE_MUTATION


class LinearRelationMixin:
    async def create_issue_relation(
        self,
        *,
        issue_id: str,
        related_issue_id: str,
        relation_type: str,
    ) -> dict[str, Any]:
        payload = await self.graphql(
            ISSUE_RELATION_CREATE_MUTATION,
            {"input": {"type": relation_type, "issueId": issue_id, "relatedIssueId": related_issue_id}},
        )
        result = ((payload.get("data") or {}).get("issueRelationCreate") or {})
        relation = result.get("issueRelation") if isinstance(result, dict) else {}
        if not result.get("success") or not isinstance(relation, dict) or not relation.get("id"):
            raise LinearError("linear_issue_relation_create_failed", "Linear issueRelationCreate returned success=false")
        return relation

    async def ensure_issue_relation(
        self,
        *,
        issue_id: str,
        related_issue_id: str,
        relation_type: str,
    ) -> dict[str, Any]:
        relation = await self._find_inverse_relation(issue_id, related_issue_id, relation_type)
        if relation is not None:
            return relation
        relation = await self._find_direct_relation(issue_id, related_issue_id, relation_type)
        if relation is not None:
            return relation
        return await self.create_issue_relation(issue_id=issue_id, related_issue_id=related_issue_id, relation_type=relation_type)

    async def _find_inverse_relation(
        self,
        issue_id: str,
        related_issue_id: str,
        relation_type: str,
    ) -> dict[str, Any] | None:
        payload = await self.graphql(ISSUE_PIPELINE_RELATIONS_QUERY, {"issueId": related_issue_id})
        issue = ((payload.get("data") or {}).get("issue") or {})
        relations = (((issue.get("inverseRelations") or {}).get("nodes")) or []) if isinstance(issue, dict) else []
        for relation in relations:
            if not isinstance(relation, dict) or relation.get("type") != relation_type:
                continue
            blocker = relation.get("issue") if isinstance(relation.get("issue"), dict) else {}
            if blocker.get("id") == issue_id or _relation_matches(relation, relation_type=relation_type, issue_id=issue_id, related_issue_id=related_issue_id):
                return relation
        return None

    async def _find_direct_relation(
        self,
        issue_id: str,
        related_issue_id: str,
        relation_type: str,
    ) -> dict[str, Any] | None:
        payload = await self.graphql(ISSUE_PIPELINE_RELATIONS_QUERY, {"issueId": issue_id})
        issue = ((payload.get("data") or {}).get("issue") or {})
        direct_relations = (((issue.get("relations") or {}).get("nodes")) or []) if isinstance(issue, dict) else []
        for relation in direct_relations:
            if not isinstance(relation, dict) or relation.get("type") != relation_type:
                continue
            related_issue = relation.get("relatedIssue") if isinstance(relation.get("relatedIssue"), dict) else {}
            if related_issue.get("id") == related_issue_id or _relation_matches(relation, relation_type=relation_type, issue_id=issue_id, related_issue_id=related_issue_id):
                return relation
        return None
