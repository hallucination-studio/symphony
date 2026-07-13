from __future__ import annotations

import httpx
import pytest

from tools import linear_fixture


def test_linear_fixture_uses_bearer_for_podium_app_token(monkeypatch) -> None:
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.setenv("PODIUM_LINEAR_APP_ACCESS_TOKEN", "oauth-token")
    request = httpx.Request("POST", "https://api.linear.app/graphql")
    response = httpx.Response(200, request=request, json={"data": {"viewer": {"id": "viewer-1"}}})
    captured: dict[str, object] = {}

    def fake_post(*args, **kwargs):
        captured.update(kwargs)
        return response

    monkeypatch.setattr(linear_fixture.httpx, "post", fake_post)

    assert linear_fixture.LinearFixture.from_environment().graphql("query { viewer { id } }") == {
        "viewer": {"id": "viewer-1"}
    }
    assert captured["headers"]["Authorization"] == "Bearer oauth-token"


def test_linear_fixture_ignores_endpoint_override_from_environment(monkeypatch) -> None:
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.setenv("PODIUM_LINEAR_APP_ACCESS_TOKEN", "oauth-token")
    monkeypatch.setenv("LINEAR_GRAPHQL_ENDPOINT", "https://attacker.invalid/graphql")

    fixture = linear_fixture.LinearFixture.from_environment()

    assert fixture.endpoint == linear_fixture.DEFAULT_ENDPOINT


def test_linear_fixture_normalizes_current_project_teams_shape(monkeypatch) -> None:
    request = httpx.Request("POST", "https://api.linear.app/graphql")
    response = httpx.Response(
        200,
        request=request,
        json={
            "data": {
                "projects": {
                    "nodes": [
                        {
                            "id": "project-1",
                            "name": "Fixture",
                            "slugId": "fixture",
                            "teams": {"nodes": [{"id": "team-1"}]},
                        }
                    ]
                }
            }
        },
    )
    captured: dict[str, object] = {}

    def fake_post(*args, **kwargs):
        captured.update(kwargs)
        return response

    monkeypatch.setattr(linear_fixture.httpx, "post", fake_post)

    project = linear_fixture.LinearFixture("fixture-token").project("fixture")

    assert project["team"] == {"id": "team-1"}
    assert "teams { nodes { id } }" in captured["json"]["query"]


def test_linear_fixture_reports_http_status_without_credentials(monkeypatch) -> None:
    request = httpx.Request("POST", "https://api.linear.app/graphql")
    response = httpx.Response(401, request=request)
    monkeypatch.setattr(linear_fixture.httpx, "post", lambda *args, **kwargs: response)
    fixture = linear_fixture.LinearFixture("not-a-real-token")

    with pytest.raises(linear_fixture.LinearFixtureError, match=r"linear_request_failed:http_401$"):
        fixture.graphql("query { viewer { id } }")


def test_linear_fixture_lists_team_workflow_states(monkeypatch) -> None:
    request = httpx.Request("POST", "https://api.linear.app/graphql")
    response = httpx.Response(
        200,
        request=request,
        json={
            "data": {
                "workflowStates": {
                    "nodes": [
                        {"id": "state-backlog", "name": "Backlog", "type": "backlog"},
                        {"id": "state-done", "name": "Done", "type": "completed"},
                    ]
                }
            }
        },
    )
    captured: dict[str, object] = {}

    def fake_post(*args, **kwargs):
        captured.update(kwargs)
        return response

    monkeypatch.setattr(linear_fixture.httpx, "post", fake_post)

    states = linear_fixture.LinearFixture("fixture-token").workflow_states("team-1")

    assert states == [
        {"id": "state-backlog", "name": "Backlog", "type": "backlog"},
        {"id": "state-done", "name": "Done", "type": "completed"},
    ]
    assert "workflowStates" in captured["json"]["query"]


def test_linear_fixture_creates_a_parent_issue_with_explicit_parent_null(monkeypatch) -> None:
    request = httpx.Request("POST", "https://api.linear.app/graphql")
    response = httpx.Response(
        200,
        request=request,
        json={
            "data": {
                "issueCreate": {
                    "success": True,
                    "issue": {
                        "id": "issue-1",
                        "identifier": "HELL-999",
                        "title": "Fixture parent",
                        "parent": None,
                        "delegate": {"id": "app-user-1"},
                        "project": {"id": "project-1"},
                        "state": {"id": "state-backlog"},
                        "project": {"id": "project-1"},
                        "state": {"id": "state-backlog"},
                    },
                }
            }
        },
    )
    captured: dict[str, object] = {}

    def fake_post(*args, **kwargs):
        captured.update(kwargs)
        return response

    monkeypatch.setattr(linear_fixture.httpx, "post", fake_post)

    issue = linear_fixture.LinearFixture("fixture-token").create_parent_issue(
        team_id="team-1",
        project_id="project-1",
        state_id="state-backlog",
        title="Fixture parent",
        description="Real-flow fixture parent.",
        delegate_id="app-user-1",
    )

    assert issue["id"] == "issue-1"
    assert issue["identifier"] == "HELL-999"
    assert issue["parent"] is None
    assert captured["json"]["variables"] == {
        "teamId": "team-1",
        "projectId": "project-1",
        "stateId": "state-backlog",
        "title": "Fixture parent",
        "description": "Real-flow fixture parent.",
        "delegateId": "app-user-1",
    }
