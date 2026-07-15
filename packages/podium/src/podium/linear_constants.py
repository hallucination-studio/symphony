from __future__ import annotations

from .linear_manifest import LINEAR_OAUTH_SCOPES

LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize"
LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token"
LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"
LINEAR_REQUIRED_SCOPES = frozenset(LINEAR_OAUTH_SCOPES)
LINEAR_DEFAULT_SCOPE = ",".join(LINEAR_OAUTH_SCOPES)

LINEAR_ACCEPTANCE_QUERY = """
query SymphonyInstallationAcceptance($first: Int!, $after: String) {
  viewer { id name app }
  organization { id name urlKey }
  projects(first: $first, after: $after) {
    nodes { id name slugId }
    pageInfo { hasNextPage endCursor }
  }
}
"""


def normalize_scopes(value: object) -> set[str]:
    if isinstance(value, str):
        return {part for part in value.replace(",", " ").split() if part}
    if isinstance(value, list):
        return {str(part).strip() for part in value if str(part).strip()}
    return set()
