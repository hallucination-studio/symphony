from __future__ import annotations


LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize"
LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token"
LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"
LINEAR_REQUIRED_SCOPES = frozenset({"read", "write", "app:assignable", "app:mentionable"})
LINEAR_DEFAULT_SCOPE = ",".join(sorted(LINEAR_REQUIRED_SCOPES))

LINEAR_ACCEPTANCE_QUERY = """
query SymphonyInstallationAcceptance {
  viewer { id name app supportsAgentSessions }
  organization { id name urlKey }
  projects(first: 250) { nodes { id name slugId } }
}
"""


def normalize_scopes(value: object) -> set[str]:
    if isinstance(value, str):
        return {part for part in value.replace(",", " ").split() if part}
    if isinstance(value, list):
        return {str(part).strip() for part in value if str(part).strip()}
    return set()
