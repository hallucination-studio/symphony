from __future__ import annotations

from typing import Any

ISSUE_FIELDS = """
nodes {
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state { name }
  project { slugId name }
  assignee { id }
  delegate { id }
  labels { nodes { name } }
  inverseRelations { nodes { type issue { id identifier state { name } } } }
}
pageInfo { hasNextPage endCursor }
"""


def _issues_query(operation_name: str, *, include_delegate_filter: bool) -> str:
    delegate_variable = ", $delegateId: ID" if include_delegate_filter else ""
    delegate_filter = "\n      delegate: { id: { eq: $delegateId } }" if include_delegate_filter else ""
    return f"""
query {operation_name}($projectSlug: String!, $stateNames: [String!], $first: Int!, $after: String{delegate_variable}) {{
  issues(
    first: $first
    after: $after
    filter: {{
      project: {{ slugId: {{ eq: $projectSlug }} }}
      state: {{ name: {{ in: $stateNames }} }}{delegate_filter}
    }}
  ) {{
    {ISSUE_FIELDS}
  }}
}}
"""


CANDIDATE_QUERY = _issues_query("PerformerCandidateIssues", include_delegate_filter=False)
ISSUES_BY_STATES_QUERY = _issues_query("PerformerIssuesByStates", include_delegate_filter=False)


def _issues_query_and_variables(
    operation_name: str,
    config: TrackerConfig,
    state_names: list[str],
    *,
    page_size: int,
) -> tuple[str, dict[str, Any]]:
    include_delegate_filter = config.required_delegate_id is not None
    variables: dict[str, Any] = {
        "projectSlug": config.project_slug,
        "stateNames": state_names,
        "first": page_size,
        "after": None,
    }
    if config.required_delegate_id is not None:
        variables["delegateId"] = config.required_delegate_id
    return _issues_query(
        operation_name,
        include_delegate_filter=include_delegate_filter,
    ), variables


ISSUE_STATES_QUERY = """
query PerformerIssueStates($ids: [ID!], $projectSlug: String!) {
  issues(filter: { id: { in: $ids }, project: { slugId: { eq: $projectSlug } } }) {
    nodes {
      id
      identifier
      title
      description
      state { name }
      project { slugId name }
      assignee { id }
      delegate { id }
      labels { nodes { name } }
      url
      inverseRelations { nodes { type issue { id identifier state { name } } } }
    }
  }
}
"""


COMMENT_CREATE_MUTATION = """
mutation PerformerCommentIssue($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id }
  }
}
"""


ISSUE_COMMENTS_QUERY = """
query PerformerIssueComments($issueId: String!, $first: Int!) {
  issue(id: $issueId) {
    comments(first: $first) {
      nodes {
        id
        body
        createdAt
        user { id name }
      }
    }
  }
}
"""


ISSUE_UPDATE_STATE_MUTATION = """
mutation PerformerTransitionIssue($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
    issue { id identifier state { name } }
  }
}
"""


ISSUE_TEAM_STATES_QUERY = """
query PerformerIssueTeamStates($issueId: String!) {
  issue(id: $issueId) {
    id
    identifier
    team {
      id
      states(first: 100) {
        nodes { id name }
      }
    }
  }
}
"""


ISSUE_DESCRIPTION_QUERY = """
query PerformerIssueDescription($issueId: String!) {
  issue(id: $issueId) {
    id
    identifier
    description
  }
}
"""


ISSUE_UPDATE_DESCRIPTION_MUTATION = """
mutation PerformerUpdateIssueDescription($issueId: String!, $description: String!) {
  issueUpdate(id: $issueId, input: { description: $description }) {
    success
    issue { id identifier description }
  }
}
"""


ISSUE_ACCEPTANCE_RELATIONS_QUERY = """
query PerformerAcceptanceRelations($issueId: String!) {
  issue(id: $issueId) {
    id
    identifier
    inverseRelations {
      nodes {
        id
        type
        issue {
          id
          identifier
          title
          url
          state { name }
          labels { nodes { name } }
        }
        relatedIssue {
          id
          identifier
          title
          url
          state { name }
          labels { nodes { name } }
        }
      }
    }
    relations {
      nodes {
        id
        type
        issue {
          id
          identifier
          title
          url
          state { name }
          labels { nodes { name } }
        }
        relatedIssue {
          id
          identifier
          title
          url
          state { name }
          labels { nodes { name } }
        }
      }
    }
  }
}
"""


ISSUE_CREATE_MUTATION = """
mutation PerformerCreateIssue(
  $teamId: String!,
  $projectId: String!,
  $stateId: String!,
  $labelIds: [String!],
  $title: String!,
  $description: String!,
  $parentId: String,
  $assigneeId: String,
  $delegateId: String
) {
  issueCreate(input: {
    teamId: $teamId,
    projectId: $projectId,
    stateId: $stateId,
    labelIds: $labelIds,
    title: $title,
    description: $description,
    parentId: $parentId,
    assigneeId: $assigneeId,
    delegateId: $delegateId
  }) {
    success
    issue {
      id
      identifier
      title
      url
      state { name }
      assignee { id }
      delegate { id }
      labels { nodes { name } }
    }
  }
}
"""


ISSUE_CHILDREN_QUERY = """
query PerformerIssueChildren($issueId: String!, $childrenAfter: String, $commentsAfter: String) {
  issue(id: $issueId) {
    id
    children(first: 100, after: $childrenAfter) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        identifier
        title
        description
        url
        state { name }
        assignee { id }
        delegate { id }
        labels { nodes { name } }
        comments(first: 100, after: $commentsAfter) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            body
            createdAt
            user { id name }
          }
        }
      }
    }
  }
}
"""


ISSUE_RELATION_CREATE_MUTATION = """
mutation PerformerCreateIssueRelation($input: IssueRelationCreateInput!) {
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
"""


ISSUE_LABEL_CONTEXT_QUERY = """
query PerformerIssueLabelContext($issueId: String!) {
  issue(id: $issueId) {
    id
    identifier
    team { id }
    labels { nodes { id name } }
  }
}
"""


ISSUE_CREATION_CONTEXT_QUERY = """
query PerformerIssueCreationContext($issueId: String!) {
  issue(id: $issueId) {
    id
    identifier
    team { id }
    project { id }
    state { id name }
  }
}
"""


ISSUE_LABEL_BY_NAME_QUERY = """
query PerformerIssueLabelByName($name: String!, $teamId: ID!) {
  issueLabels(first: 20, filter: { name: { eq: $name }, team: { id: { eq: $teamId } } }) {
    nodes { id name }
  }
}
"""


ISSUE_LABEL_CREATE_MUTATION = """
mutation PerformerIssueLabelCreate($name: String!, $teamId: String!) {
  issueLabelCreate(input: { name: $name, teamId: $teamId }) {
    success
    issueLabel { id name }
  }
}
"""


ISSUE_UPDATE_LABELS_MUTATION = """
mutation PerformerUpdateIssueLabels($issueId: String!, $labelIds: [String!]) {
  issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
    success
    issue {
      id
      identifier
      labels { nodes { id name } }
    }
  }
}
"""


ISSUE_UPDATE_DELEGATE_MUTATION = """
mutation PerformerUpdateIssueDelegate($issueId: String!, $delegateId: String!) {
  issueUpdate(id: $issueId, input: { delegateId: $delegateId }) {
    success
    issue {
      id
      identifier
      delegate { id }
    }
  }
}
"""



__all__ = [name for name in globals() if name.isupper() or name.startswith("_")]
