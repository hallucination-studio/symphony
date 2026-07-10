from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx

from real_symphony_e2e_common import LINEAR_ENDPOINT
from real_symphony_e2e_errors import E2EFailure


class LinearE2EError(E2EFailure):
    pass


async def linear_graphql(token: str, query: str, variables: dict[str, Any]) -> dict[str, Any]:
    last_error: Exception | None = None
    max_attempts = 8
    for attempt in range(1, max_attempts + 1):
        try:
            async with httpx.AsyncClient(timeout=45, trust_env=False) as client:
                response = await client.post(
                    LINEAR_ENDPOINT,
                    json={"query": query, "variables": variables},
                    headers={"Authorization": token, "Content-Type": "application/json"},
                )
            if response.status_code in {401, 403}:
                raise _linear_authentication_error(response.status_code)
            try:
                payload = response.json()
            except json.JSONDecodeError as exc:
                raise RuntimeError(
                    json.dumps(
                        {"status": response.status_code, "body": response.text[:500]},
                        indent=2,
                    )
                ) from exc
            if _has_linear_authentication_error(payload):
                raise _linear_authentication_error(response.status_code)
            if _has_linear_app_user_scope_error(payload):
                raise _linear_app_user_scope_error()
            if response.status_code != 200 or payload.get("errors"):
                raise RuntimeError(json.dumps({"status": response.status_code, "payload": payload}, indent=2))
            return payload["data"]
        except LinearE2EError:
            raise
        except (httpx.HTTPError, TimeoutError, RuntimeError) as exc:
            last_error = exc
            if attempt == max_attempts:
                break
            await asyncio.sleep(min(2 ** (attempt - 1), 20))
    raise RuntimeError(f"Linear GraphQL request failed after retries: {last_error!r}") from last_error


def _linear_authentication_error(status_code: int) -> LinearE2EError:
    return LinearE2EError(
        failure_class="credential_or_config_failure",
        error_code="linear_authentication_failed",
        sanitized_reason=f"Linear authentication or authorization failed (HTTP {status_code}).",
        retryable=False,
        next_action="refresh_linear_app_access_token",
    )


def _linear_app_user_scope_error() -> LinearE2EError:
    return LinearE2EError(
        failure_class="credential_or_config_failure",
        error_code="linear_app_user_scope_invalid",
        sanitized_reason="Linear app user delegation requires the app:assignable scope.",
        retryable=False,
        next_action="refresh_linear_app_access_token_with_app_assignable_scope",
    )


def _has_linear_authentication_error(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    errors = payload.get("errors")
    if not isinstance(errors, list):
        return False
    auth_codes = {"AUTHENTICATION_ERROR", "AUTHORIZATION_ERROR", "FORBIDDEN"}
    return any(
        isinstance(error, dict)
        and str((error.get("extensions") or {}).get("code") or "").upper() in auth_codes
        for error in errors
    )


def _has_linear_app_user_scope_error(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    errors = payload.get("errors")
    if not isinstance(errors, list):
        return False
    for error in errors:
        if not isinstance(error, dict):
            continue
        extensions = (
            error.get("extensions") if isinstance(error.get("extensions"), dict) else {}
        )
        text = " ".join(
            str(value).lower()
            for value in (error.get("message"), extensions.get("userPresentableMessage"))
            if value
        )
        if "app user" in text and "required scope" in text:
            return True
    return False


async def fetch_linear_viewer(token: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            query Viewer {
              viewer { id name email }
            }
            """,
            {},
        )
    )["viewer"]


async def create_linear_issue(
    token: str,
    project_slug: str,
    run_id: str,
    *,
    delegate_id: str | None = None,
    parent_id: str | None = None,
    title: str | None = None,
    description: str | None = None,
) -> dict[str, Any]:
    project = await resolve_project(token, project_slug)
    teams = project.get("teams", {}).get("nodes") or []
    if not teams:
        raise RuntimeError(f"Linear project has no teams: {project_slug}")
    team = teams[0]
    states = (
        await linear_graphql(
            token,
            """
            query States($teamId: ID!) {
              workflowStates(first: 50, filter: { team: { id: { eq: $teamId } } }) {
                nodes { id name type }
              }
            }
            """,
            {"teamId": team["id"]},
        )
    )["workflowStates"]["nodes"]
    todo = next((state for state in states if state["name"].lower() == "todo"), None)
    if todo is None:
        todo = next(state for state in states if state["type"] == "unstarted")
    issue = (
        await linear_graphql(
            token,
            """
            mutation CreateIssue($input: IssueCreateInput!) {
              issueCreate(input: $input) {
                success
                issue {
                  id
                  identifier
                  title
                  description
                  url
                  state { name type }
                  assignee { id name }
                  delegate { id name }
                  parent { id identifier }
                  labels { nodes { name } }
                }
              }
            }
            """,
            {
                "input": {
                    "teamId": team["id"],
                    "projectId": project["id"],
                    "stateId": todo["id"],
                    "title": title or f"Symphony managed agent dispatch {run_id}",
                    "description": description or (
                        "Real Symphony e2e task. Create SYMPHONY_REAL_E2E_RESULT.md at the workspace root, "
                        "include this Linear issue identifier, say Podium, Conductor, and Performer reached Codex, "
                        "and run pytest tests/test_smoke.py -q."
                    ),
                    **({"delegateId": delegate_id} if delegate_id else {}),
                    **({"parentId": parent_id} if parent_id else {}),
                }
            },
        )
    )["issueCreate"]["issue"]
    return {"project": project, "team": team, "todo_state": todo, "issue": issue}


async def resolve_project(token: str, project: str) -> dict[str, Any]:
    by_slug = (
        await linear_graphql(
            token,
            """
            query ProjectBySlug($project: String!) {
              projects(first: 5, filter: { slugId: { eq: $project } }) {
                nodes { id name slugId teams { nodes { id key name } } }
              }
            }
            """,
            {"project": project},
        )
    )["projects"]["nodes"]
    if by_slug:
        return by_slug[0]
    by_name = (
        await linear_graphql(
            token,
            """
            query ProjectByName($project: String!) {
              projects(first: 5, filter: { name: { eq: $project } }) {
                nodes { id name slugId teams { nodes { id key name } } }
              }
            }
            """,
            {"project": project},
        )
    )["projects"]["nodes"]
    if by_name:
        return by_name[0]
    raise RuntimeError(f"Linear project not found by slugId or name: {project}")
