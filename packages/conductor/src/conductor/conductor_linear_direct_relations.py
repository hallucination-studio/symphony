from __future__ import annotations

from typing import Any

from .conductor_linear_direct_base import LinearDirectProxyError
from .conductor_linear_direct_helpers import _relation_matches


class ManagedRunRelationMixin:
    async def create_issue_relation(
        self,
        *,
        issue_id: str,
        related_issue_id: str,
        relation_type: str,
    ) -> dict[str, Any]:
        payload = await self.graphql(
            """
mutation ConductorCreateIssueRelation($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) {
    success
    issueRelation {
      id
      type
      issue { id identifier }
      relatedIssue { id identifier }
    }
  }
}
""",
            {
                "input": {
                    "type": relation_type,
                    "issueId": issue_id,
                    "relatedIssueId": related_issue_id,
                }
            },
        )
        result = ((payload.get("data") or {}).get("issueRelationCreate") or {})
        relation = result.get("issueRelation") if isinstance(result, dict) else {}
        if not result.get("success") or not isinstance(relation, dict) or not relation.get("id"):
            raise LinearDirectProxyError("linear_issue_relation_create_failed", "Linear issueRelationCreate returned success=false")
        return relation

    async def ensure_issue_relation(
        self,
        *,
        issue_id: str,
        related_issue_id: str,
        relation_type: str,
    ) -> dict[str, Any]:
        payload = await self.graphql(
            """
query ConductorInverseIssueRelations($issueId: String!) {
  issue(id: $issueId) {
    inverseRelations(first: 100) {
      nodes {
        id
        type
        issue { id identifier }
        relatedIssue { id identifier }
      }
    }
  }
}
""",
            {"issueId": related_issue_id},
        )
        issue = ((payload.get("data") or {}).get("issue") or {})
        inverse_relations = (((issue.get("inverseRelations") or {}).get("nodes")) or []) if isinstance(issue, dict) else []
        for relation in inverse_relations:
            if _relation_matches(relation, relation_type=relation_type, issue_id=issue_id, related_issue_id=related_issue_id):
                return relation
        payload = await self.graphql(
            """
query ConductorDirectIssueRelations($issueId: String!) {
  issue(id: $issueId) {
    relations(first: 100) {
      nodes {
        id
        type
        issue { id identifier }
        relatedIssue { id identifier }
      }
    }
  }
}
""",
            {"issueId": issue_id},
        )
        issue = ((payload.get("data") or {}).get("issue") or {})
        direct_relations = (((issue.get("relations") or {}).get("nodes")) or []) if isinstance(issue, dict) else []
        for relation in direct_relations:
            if _relation_matches(relation, relation_type=relation_type, issue_id=issue_id, related_issue_id=related_issue_id):
                return relation
        return await self.create_issue_relation(
            issue_id=issue_id,
            related_issue_id=related_issue_id,
            relation_type=relation_type,
        )
