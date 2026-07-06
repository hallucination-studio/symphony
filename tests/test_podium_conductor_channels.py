from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from podium.app import create_app


def make_app(
    *,
    linear_webhook_secret: str = "",
    linear_graphql_transport: Any = None,
    data_dir: Any = None,
    secret_key: str = "test-secret",
    pg_store: Any = None,
    redis_store: Any = None,
):
    return create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        linear_webhook_secret=linear_webhook_secret,
        linear_graphql_transport=linear_graphql_transport,
        data_dir=data_dir,
        secret_key=secret_key,
        pg_store=pg_store,
        redis_store=redis_store,
    )


async def register(client: httpx.AsyncClient, email: str = "phase@example.com") -> str:
    response = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "correct-horse", "turnstile_token": "turnstile-ok"},
    )
    assert response.status_code == 200
    return str(response.json()["user"]["id"])


async def enroll_conductor(client: httpx.AsyncClient) -> dict[str, Any]:
    token_response = await client.post("/api/v1/onboarding/runtime/enrollment-token")
    assert token_response.status_code == 200
    enrolled = await client.post(
        "/api/v1/runtime/enroll",
        json={
            "enrollment_token": token_response.json()["enrollment_token"],
            "hostname": "server-a",
            "label": "Server A",
            "version": "0.2.0",
        },
    )
    assert enrolled.status_code == 200
    return enrolled.json()


def agent_session_payload(*, workspace_id: str, project_slug: str, delegate_id: str) -> dict[str, Any]:
    return {
        "type": "AgentSessionEvent",
        "workspace": {"id": workspace_id},
        "agentSession": {
            "id": "agent-session-1",
            "appUserId": delegate_id,
            "issue": {
                "id": "issue-1",
                "identifier": f"{project_slug}-1",
                "project": {"slugId": project_slug},
                "delegate": {"id": delegate_id},
            },
        },
    }


def agent_session_payload_without_session_id(
    *,
    workspace_id: str,
    project_slug: str,
    delegate_id: str,
    issue_id: str,
    identifier: str,
) -> dict[str, Any]:
    payload = agent_session_payload(workspace_id=workspace_id, project_slug=project_slug, delegate_id=delegate_id)
    payload["agentSession"].pop("id", None)
    payload["agentSession"]["issue"]["id"] = issue_id
    payload["agentSession"]["issue"]["identifier"] = identifier
    return payload


def agent_session_payload_with_distinct_session_app_user(
    *,
    workspace_id: str,
    project_slug: str,
    session_app_user_id: str,
    issue_delegate_id: str,
) -> dict[str, Any]:
    payload = agent_session_payload(workspace_id=workspace_id, project_slug=project_slug, delegate_id=session_app_user_id)
    payload["agentSession"]["appUserId"] = session_app_user_id
    payload["agentSession"]["issue"]["delegate"] = {"id": issue_delegate_id}
    return payload


def dependent_agent_session_payload(*, workspace_id: str, project_slug: str, delegate_id: str) -> dict[str, Any]:
    payload = agent_session_payload(workspace_id=workspace_id, project_slug=project_slug, delegate_id=delegate_id)
    payload["agentSession"]["issue"]["parent"] = {"id": "parent-1", "identifier": "ALPHA-ROOT"}
    payload["agentSession"]["issue"]["blocked_by"] = [{"id": "blocker-1", "identifier": "ALPHA-1"}]
    return payload


def signature(raw: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


@pytest.mark.asyncio
async def test_runtime_report_upserts_conductor_bindings_metrics_and_log_tail() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await register(client)
        enrolled = await enroll_conductor(client)

        report = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "hostname": "server-a",
                "label": "Server A",
                "version": "0.2.1",
                "bindings": [
                    {
                        "instance_id": "inst-a",
                        "name": "Alpha",
                        "linear_project": "Project Alpha",
                        "project_slug": "ALPHA",
                        "agent_app_user_id": "agent-alpha",
                        "workflow_profile": "gated-task",
                        "process_status": "running",
                        "constraint_labels": ["symphony:performer/Alpha", "symphony:profile/gated-task"],
                        "repo_source": {"type": "local_path", "value": "/repo/a"},
                    },
                    {
                        "instance_id": "inst-b",
                        "name": "Beta",
                        "linear_project": "Project Beta",
                        "project_slug": "BETA",
                        "agent_app_user_id": "agent-beta",
                        "workflow_profile": "task",
                        "process_status": "stopped",
                    },
                ],
                "metrics": {
                    "inst-a": {
                        "tokens": 10,
                        "runtime_seconds": 20,
                        "retries": 1,
                        "continuations": 2,
                        "blocked": 3,
                        "pending_human": 4,
                        "failures": 4,
                    }
                },
                "queue": {"inst-a": {"queued": 5, "leased": 1, "running": 1}},
                "log_tail": {
                    "inst-a": {
                        "generation": 7,
                        "offset_end": 123,
                        "lines": ["newest", "older"],
                    }
                },
            },
        )

        listed = await client.get("/api/v1/runtimes")
        logs = await client.get(f"/api/v1/runtimes/{enrolled['runtime_id']}/instances/inst-a/logs?tail=2&order=desc")

    assert report.status_code == 200
    assert report.json()["bindings_upserted"] == 2
    assert listed.status_code == 200
    conductor = listed.json()["conductors"][0]
    assert conductor["conductor_id"] == enrolled["runtime_id"]
    assert conductor["online"] is False
    assert [binding["project_slug"] for binding in conductor["bindings"]] == ["ALPHA", "BETA"]
    assert conductor["bindings"][0]["metrics"]["tokens"] == 10
    assert conductor["bindings"][0]["metrics"]["pending_human"] == 4
    assert conductor["bindings"][0]["queue"]["queue_depth"] == 6
    assert conductor["bindings"][0]["constraint_labels"] == [
        "symphony:performer/Alpha",
        "symphony:profile/gated-task",
    ]
    assert conductor["bindings"][1]["constraint_labels"] == []
    assert logs.status_code == 200
    assert logs.json()["logs"]["lines"] == ["newest", "older"]
    assert logs.json()["logs"]["cursor"] == 123


@pytest.mark.asyncio
async def test_injected_postgres_and_redis_persist_auth_across_app_restart() -> None:
    from tests.test_podium_infra import FakePgStore, FakeRedisStore

    pg_store = FakePgStore()
    redis_store = FakeRedisStore()
    app = make_app()
    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        secret_key="test-secret",
        pg_store=pg_store,
        redis_store=redis_store,
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "durable-routing@example.com")

    restarted = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        secret_key="test-secret",
        pg_store=pg_store,
        redis_store=redis_store,
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=restarted), base_url="http://podium.test") as client:
        login = await client.post(
            "/api/v1/auth/login",
            json={
                "email": "durable-routing@example.com",
                "password": "correct-horse",
                "turnstile_token": "turnstile-ok",
            },
        )
        assert login.status_code == 200
        boot = await client.get("/api/v1/bootstrap")

    assert boot.status_code == 200
    assert boot.json()["session"]["workspace_id"] == user_id
    assert boot.json()["session"]["email"] == "durable-routing@example.com"
    assert pg_store.created_users == [user_id]
    assert redis_store.saved_sessions


@pytest.mark.asyncio
async def test_injected_postgres_persists_runtime_credentials_across_app_restart() -> None:
    from tests.test_podium_infra import FakePgStore, FakeRedisStore

    pg_store = FakePgStore()
    redis_store = FakeRedisStore()
    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        secret_key="test-secret",
        pg_store=pg_store,
        redis_store=redis_store,
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await register(client, "durable-runtime@example.com")
        enrolled = await enroll_conductor(client)

    restarted = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        secret_key="test-secret",
        pg_store=pg_store,
        redis_store=redis_store,
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=restarted), base_url="http://podium.test") as client:
        report = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={"bindings": [{"instance_id": "inst-a", "project_slug": "ALPHA", "agent_app_user_id": "agent-alpha"}]},
        )

    assert report.status_code == 200
    assert report.json()["bindings_upserted"] == 1
    assert f"{enrolled['runtime_id']}:inst-a" in pg_store.project_bindings


@pytest.mark.asyncio
async def test_injected_postgres_persists_queued_dispatch_across_app_restart() -> None:
    from tests.test_podium_infra import FakePgStore, FakeRedisStore

    pg_store = FakePgStore()
    redis_store = FakeRedisStore()
    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        secret_key="test-secret",
        pg_store=pg_store,
        redis_store=redis_store,
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "durable-dispatch@example.com")
        enrolled = await enroll_conductor(client)
        await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={"bindings": [{"instance_id": "inst-a", "project_slug": "ALPHA", "agent_app_user_id": "agent-alpha"}]},
        )
        queued = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            json=agent_session_payload(workspace_id=user_id, project_slug="ALPHA", delegate_id="agent-alpha"),
        )

    restarted = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        secret_key="test-secret",
        pg_store=pg_store,
        redis_store=redis_store,
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=restarted), base_url="http://podium.test") as client:
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )

    assert queued.status_code == 200
    assert queued.json()["queued"] == 1
    assert lease.status_code == 200
    assert lease.json()["dispatch"]["issue_identifier"] == "ALPHA-1"
    assert lease.json()["dispatch"]["fencing_token"] == 1


@pytest.mark.asyncio
async def test_injected_postgres_routes_webhook_and_lease_across_distinct_workers() -> None:
    from tests.test_podium_infra import FakePgStore, FakeRedisStore

    pg_store = FakePgStore()
    redis_store = FakeRedisStore()

    enrollment_app = make_app(pg_store=pg_store, redis_store=redis_store)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=enrollment_app), base_url="http://podium.test") as client:
        user_id = await register(client, "multiworker@example.com")
        enrolled = await enroll_conductor(client)
        report = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={"bindings": [{"instance_id": "inst-a", "project_slug": "ALPHA", "agent_app_user_id": "agent-alpha"}]},
        )

    webhook_app = make_app(pg_store=pg_store, redis_store=redis_store)
    assert webhook_app.state.podium.runtime_groups == {}
    assert webhook_app.state.podium.project_bindings == {}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webhook_app), base_url="http://podium.test") as client:
        queued = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            json=agent_session_payload(workspace_id=user_id, project_slug="ALPHA", delegate_id="agent-alpha"),
        )

    lease_app = make_app(pg_store=pg_store, redis_store=redis_store)
    assert lease_app.state.podium.runtimes == {}
    assert lease_app.state.podium.runtime_groups == {}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=lease_app), base_url="http://podium.test") as client:
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )

    assert report.status_code == 200
    assert queued.status_code == 200
    assert queued.json()["queued"] == 1
    assert lease.status_code == 200
    dispatch = lease.json()["dispatch"]
    assert dispatch["issue_identifier"] == "ALPHA-1"
    assert dispatch["project_binding_id"] == f"{enrolled['runtime_id']}:inst-a"
    assert dispatch["fencing_token"] == 1


@pytest.mark.asyncio
async def test_injected_postgres_acks_leased_dispatch_across_distinct_workers_and_requires_fencing() -> None:
    from tests.test_podium_infra import FakePgStore, FakeRedisStore

    pg_store = FakePgStore()
    redis_store = FakeRedisStore()

    enrollment_app = make_app(pg_store=pg_store, redis_store=redis_store)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=enrollment_app), base_url="http://podium.test") as client:
        user_id = await register(client, "multiworker-ack@example.com")
        enrolled = await enroll_conductor(client)
        await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={"bindings": [{"instance_id": "inst-a", "project_slug": "ALPHA", "agent_app_user_id": "agent-alpha"}]},
        )

    webhook_app = make_app(pg_store=pg_store, redis_store=redis_store)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webhook_app), base_url="http://podium.test") as client:
        queued = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            json=agent_session_payload(workspace_id=user_id, project_slug="ALPHA", delegate_id="agent-alpha"),
        )

    lease_app = make_app(pg_store=pg_store, redis_store=redis_store)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=lease_app), base_url="http://podium.test") as client:
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )
    dispatch = lease.json()["dispatch"]

    ack_app = make_app(pg_store=pg_store, redis_store=redis_store)
    assert ack_app.state.podium.dispatches == {}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=ack_app), base_url="http://podium.test") as client:
        missing_fence = await client.post(
            "/api/v1/runtime/dispatches/ack",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={"dispatch_id": dispatch["dispatch_id"], "status": "completed", "runtime_phase": "done"},
        )
        ack = await client.post(
            "/api/v1/runtime/dispatches/ack",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "dispatch_id": dispatch["dispatch_id"],
                "fencing_token": dispatch["fencing_token"],
                "status": "completed",
                "reason": "completed_by_runtime",
                "runtime_phase": "done",
            },
        )

    assert queued.status_code == 200
    assert queued.json()["queued"] == 1
    assert lease.status_code == 200
    assert missing_fence.status_code == 409
    assert missing_fence.json()["error"]["code"] == "stale_dispatch_lease"
    assert ack.status_code == 200
    assert ack.json()["dispatch"]["status"] == "completed"
    assert pg_store.dispatches[dispatch["dispatch_id"]]["status"] == "completed"


@pytest.mark.asyncio
async def test_injected_postgres_reaps_expired_leased_dispatch_for_release() -> None:
    from tests.test_podium_infra import FakePgStore, FakeRedisStore

    pg_store = FakePgStore()
    redis_store = FakeRedisStore()
    app = make_app(pg_store=pg_store, redis_store=redis_store)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "reaper@example.com")
        enrolled = await enroll_conductor(client)
        await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={"bindings": [{"instance_id": "inst-a", "project_slug": "ALPHA", "agent_app_user_id": "agent-alpha"}]},
        )
        await client.post(
            "/api/v1/linear/webhooks/agent-session",
            json=agent_session_payload(workspace_id=user_id, project_slug="ALPHA", delegate_id="agent-alpha"),
        )
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )

    dispatch_id = lease.json()["dispatch"]["dispatch_id"]
    pg_store.dispatches[dispatch_id]["leased_until"] = "2026-01-01T00:00:00Z"

    reaper_app = make_app(pg_store=pg_store, redis_store=redis_store)
    reaped = await reaper_app.state.podium.reap_expired_dispatch_leases()

    lease_app = make_app(pg_store=pg_store, redis_store=redis_store)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=lease_app), base_url="http://podium.test") as client:
        renewed = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )

    assert reaped == 1
    assert renewed.status_code == 200
    assert renewed.json()["dispatch"]["dispatch_id"] == dispatch_id
    assert renewed.json()["dispatch"]["fencing_token"] == 2


@pytest.mark.asyncio
async def test_dispatch_routes_by_project_binding_not_single_workspace_group() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "routing@example.com")
        enrolled = await enroll_conductor(client)
        await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "bindings": [
                    {"instance_id": "inst-a", "project_slug": "ALPHA", "agent_app_user_id": "agent-alpha"},
                    {
                        "instance_id": "inst-b",
                        "project_slug": "BETA",
                        "agent_app_user_id": "agent-beta",
                        "codex_profile": {
                            "model": "gpt-5-codex",
                            "sandbox": "workspace_write",
                            "config_overrides": [
                                "model_provider=openai",
                                "model_providers.openai.api_key=$OPENAI_API_KEY",
                            ],
                        },
                    },
                ]
            },
        )
        queued = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            content=json.dumps(agent_session_payload(workspace_id=user_id, project_slug="BETA", delegate_id="agent-beta")).encode(),
            headers={"Content-Type": "application/json", "Linear-Signature": "ignored"},
        )
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )

    assert queued.status_code == 200
    assert queued.json()["queued"] == 1
    assert lease.status_code == 200
    dispatch = lease.json()["dispatch"]
    assert dispatch["project_binding_id"].endswith(":inst-b")
    assert dispatch["project_slug"] == "BETA"
    assert dispatch["instance_id"] == "inst-b"
    assert dispatch["codex_profile"] == {
        "model": "gpt-5-codex",
        "sandbox": "workspace_write",
        "config_overrides": [
            "model_provider=openai",
            "model_providers.openai.api_key=$OPENAI_API_KEY",
        ],
    }
    assert "sk-" not in json.dumps(dispatch)


@pytest.mark.asyncio
async def test_webhook_routes_when_either_agent_session_or_issue_delegate_matches() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "routing-or@example.com")
        enrolled = await enroll_conductor(client)
        await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "bindings": [
                    {"instance_id": "inst-a", "project_slug": "ALPHA", "agent_app_user_id": "agent-alpha"},
                    {"instance_id": "inst-b", "project_slug": "BETA", "agent_app_user_id": "agent-beta"},
                ]
            },
        )

        issue_delegate_match = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            json=agent_session_payload_with_distinct_session_app_user(
                workspace_id=user_id,
                project_slug="ALPHA",
                session_app_user_id="other-agent",
                issue_delegate_id="agent-alpha",
            ),
        )
        session_app_match = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            json=agent_session_payload_with_distinct_session_app_user(
                workspace_id=user_id,
                project_slug="BETA",
                session_app_user_id="agent-beta",
                issue_delegate_id="other-agent",
            ),
        )

    assert issue_delegate_match.status_code == 200
    assert issue_delegate_match.json()["queued"] == 1
    assert session_app_match.status_code == 200
    assert session_app_match.json()["queued"] == 1


@pytest.mark.asyncio
async def test_agent_session_webhook_preserves_dependency_metadata_for_runtime_dispatch() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "dependency-routing@example.com")
        enrolled = await enroll_conductor(client)
        await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "bindings": [
                    {"instance_id": "inst-a", "project_slug": "ALPHA", "agent_app_user_id": "agent-alpha"}
                ]
            },
        )
        queued = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            json=dependent_agent_session_payload(workspace_id=user_id, project_slug="ALPHA", delegate_id="agent-alpha"),
        )
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )

    assert queued.status_code == 200
    assert queued.json()["queued"] == 1
    dispatch = lease.json()["dispatch"]
    assert dispatch["parent_issue_id"] == "parent-1"
    assert dispatch["blocked_by"] == ["blocker-1"]


@pytest.mark.asyncio
async def test_webhook_rejects_invalid_signature_and_invalid_json() -> None:
    secret = "webhook-secret"
    app = make_app(linear_webhook_secret=secret)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        bad_signature = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            json={"type": "AgentSessionEvent"},
            headers={"Linear-Signature": "bad"},
        )

        bad_raw = b"{"
        bad_json = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            content=bad_raw,
            headers={"Linear-Signature": signature(bad_raw, secret)},
        )

    assert bad_signature.status_code == 401
    assert bad_signature.json()["error"]["code"] == "invalid_signature"
    assert bad_json.status_code == 400
    assert bad_json.json()["error"]["code"] == "invalid_json"


@pytest.mark.asyncio
async def test_signed_webhook_queues_dispatch_and_runtime_ack_completes_it() -> None:
    secret = "webhook-secret"
    app = make_app(linear_webhook_secret=secret)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "signed-routing@example.com")
        enrolled = await enroll_conductor(client)
        await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "bindings": [
                    {
                        "instance_id": "inst-a",
                        "project_slug": "ALPHA",
                        "agent_app_user_id": "agent-alpha",
                        "workflow_profile": "gated-task",
                    }
                ]
            },
        )

        rejected_payload = agent_session_payload(
            workspace_id=user_id,
            project_slug="ALPHA",
            delegate_id="other-agent",
        )
        rejected_raw = json.dumps(rejected_payload).encode()
        rejected = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            content=rejected_raw,
            headers={"Content-Type": "application/json", "Linear-Signature": signature(rejected_raw, secret)},
        )

        queued_payload = agent_session_payload(
            workspace_id=user_id,
            project_slug="ALPHA",
            delegate_id="agent-alpha",
        )
        queued_raw = json.dumps(queued_payload).encode()
        queued = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            content=queued_raw,
            headers={"Content-Type": "application/json", "Linear-Signature": signature(queued_raw, secret)},
        )
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )
        dispatch = lease.json()["dispatch"]
        ack = await client.post(
            "/api/v1/runtime/dispatches/ack",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "dispatch_id": dispatch["dispatch_id"],
                "status": "completed",
                "reason": "completed_by_runtime",
                "runtime_phase": "done",
            },
        )

    assert rejected.status_code == 200
    assert rejected.json()["queued"] == 0
    assert queued.status_code == 200
    assert queued.json()["queued"] == 1
    assert dispatch["issue_id"] == "issue-1"
    assert dispatch["issue_identifier"] == "ALPHA-1"
    assert dispatch["workflow_profile"] == "gated-task"
    assert ack.status_code == 200
    assert ack.json()["dispatch"]["status"] == "completed"
    assert ack.json()["dispatch"]["reason"] == "completed_by_runtime"
    assert ack.json()["dispatch"]["runtime_phase"] == "done"


@pytest.mark.asyncio
async def test_agent_session_webhook_is_idempotent_by_binding_and_agent_session() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "idempotent-webhook@example.com")
        enrolled = await enroll_conductor(client)
        await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={"bindings": [{"instance_id": "inst-a", "project_slug": "ALPHA", "agent_app_user_id": "agent-alpha"}]},
        )
        payload = agent_session_payload(workspace_id=user_id, project_slug="ALPHA", delegate_id="agent-alpha")

        first = await client.post("/api/v1/linear/webhooks/agent-session", json=payload)
        second = await client.post("/api/v1/linear/webhooks/agent-session", json=payload)
        runs = await client.get("/api/v1/runs/recent")

    assert first.status_code == 200
    assert first.json()["queued"] == 1
    assert second.status_code == 200
    assert second.json()["queued"] == 0
    assert [run["issue_identifier"] for run in runs.json()["runs"]] == ["ALPHA-1"]


@pytest.mark.asyncio
async def test_injected_postgres_empty_agent_session_id_dedupes_by_issue_not_binding_only() -> None:
    from tests.test_podium_infra import FakePgStore, FakeRedisStore

    pg_store = FakePgStore()
    redis_store = FakeRedisStore()
    app = make_app(pg_store=pg_store, redis_store=redis_store)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "empty-session@example.com")
        enrolled = await enroll_conductor(client)
        await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={"bindings": [{"instance_id": "inst-a", "project_slug": "ALPHA", "agent_app_user_id": "agent-alpha"}]},
        )
        issue_a = agent_session_payload_without_session_id(
            workspace_id=user_id,
            project_slug="ALPHA",
            delegate_id="agent-alpha",
            issue_id="issue-a",
            identifier="ALPHA-1",
        )
        issue_b = agent_session_payload_without_session_id(
            workspace_id=user_id,
            project_slug="ALPHA",
            delegate_id="agent-alpha",
            issue_id="issue-b",
            identifier="ALPHA-2",
        )

        first_a = await client.post("/api/v1/linear/webhooks/agent-session", json=issue_a)
        second_a = await client.post("/api/v1/linear/webhooks/agent-session", json=issue_a)
        first_b = await client.post("/api/v1/linear/webhooks/agent-session", json=issue_b)

    assert first_a.status_code == 200
    assert first_a.json()["queued"] == 1
    assert second_a.status_code == 200
    assert second_a.json()["queued"] == 0
    assert first_b.status_code == 200
    assert first_b.json()["queued"] == 1
    assert sorted(dispatch["issue_identifier"] for dispatch in pg_store.dispatches.values()) == ["ALPHA-1", "ALPHA-2"]


@pytest.mark.asyncio
async def test_runtime_presence_reads_redis_owner_across_distinct_workers() -> None:
    from tests.test_podium_infra import FakePgStore, FakeRedisStore

    pg_store = FakePgStore()
    redis_store = FakeRedisStore()
    enrollment_app = make_app(pg_store=pg_store, redis_store=redis_store)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=enrollment_app), base_url="http://podium.test") as client:
        user_id = await register(client, "presence-worker@example.com")
        enrolled = await enroll_conductor(client)

    await redis_store.set_conductor_owner(enrolled["runtime_id"], "podium-a", ttl_seconds=90)

    list_app = make_app(pg_store=pg_store, redis_store=redis_store)
    assert list_app.state.podium.presence == {}
    user = await list_app.state.podium.user_by_id(user_id)
    assert user is not None
    token = await list_app.state.podium.create_session(user_id)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=list_app),
        base_url="http://podium.test",
        cookies={list_app.state.podium.session_cookie_name: token},
    ) as client:
        status = await client.get("/api/v1/onboarding/runtime/status")
        runtimes = await client.get("/api/v1/runtimes")

    assert status.status_code == 200
    assert status.json()["online_count"] == 1
    assert runtimes.status_code == 200
    assert runtimes.json()["runtimes"][0]["online"] is True
    assert runtimes.json()["conductors"][0]["online"] is True


@pytest.mark.asyncio
async def test_runtime_auth_rechecks_postgres_disabled_state_instead_of_memory_cache() -> None:
    from tests.test_podium_infra import FakePgStore, FakeRedisStore

    pg_store = FakePgStore()
    redis_store = FakeRedisStore()
    app = make_app(pg_store=pg_store, redis_store=redis_store)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await register(client, "runtime-disabled@example.com")
        enrolled = await enroll_conductor(client)

    runtime_id = enrolled["runtime_id"]
    app.state.podium.runtimes[runtime_id]["disabled"] = False
    pg_store.conductors[runtime_id]["disabled"] = True

    runtime = await app.state.podium.runtime_for_bearer(f"Bearer {enrolled['runtime_token']}")

    assert runtime is None


@pytest.mark.asyncio
async def test_dispatch_lease_returns_fencing_token_and_ack_requires_current_token() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "fencing@example.com")
        enrolled = await enroll_conductor(client)
        await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={"bindings": [{"instance_id": "inst-a", "project_slug": "ALPHA", "agent_app_user_id": "agent-alpha"}]},
        )
        await client.post(
            "/api/v1/linear/webhooks/agent-session",
            json=agent_session_payload(workspace_id=user_id, project_slug="ALPHA", delegate_id="agent-alpha"),
        )

        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )
        dispatch = lease.json()["dispatch"]
        stale_ack = await client.post(
            "/api/v1/runtime/dispatches/ack",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "dispatch_id": dispatch["dispatch_id"],
                "fencing_token": dispatch["fencing_token"] - 1,
                "status": "completed",
                "runtime_phase": "done",
            },
        )
        current_ack = await client.post(
            "/api/v1/runtime/dispatches/ack",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "dispatch_id": dispatch["dispatch_id"],
                "fencing_token": dispatch["fencing_token"],
                "status": "completed",
                "runtime_phase": "done",
            },
        )

    assert lease.status_code == 200
    assert dispatch["status"] == "leased"
    assert dispatch["fencing_token"] == 1
    assert stale_ack.status_code == 409
    assert stale_ack.json()["error"]["code"] == "stale_dispatch_lease"
    assert current_ack.status_code == 200
    assert current_ack.json()["dispatch"]["status"] == "completed"


@pytest.mark.asyncio
async def test_dispatch_ack_reconcile_flags_missing_terminal_runtime_phase() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await register(client, "dispatch-reconcile@example.com")
        enrolled = await enroll_conductor(client)
        await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={"bindings": [{"instance_id": "inst-a", "project_slug": "ALPHA", "agent_app_user_id": "agent-alpha"}]},
        )
        state = app.state.podium
        state.dispatches["dispatch-1"] = {
            "dispatch_id": "dispatch-1",
            "runtime_group_id": enrolled["runtime_group_id"],
            "project_binding_id": enrolled["runtime_group_id"],
            "issue_id": "issue-1",
            "issue_identifier": "ALPHA-1",
            "linear_workspace_id": "workspace-1",
            "project_slug": "ALPHA",
            "agent_session_id": "session-1",
            "agent_app_user_id": "agent-alpha",
            "routing_rule_id": enrolled["runtime_group_id"],
            "workflow_profile": "task",
            "codex_profile": {},
            "status": "completed",
            "reason": "completed_by_runtime",
            "runtime_phase": "reviewing",
            "leased_runtime_id": enrolled["runtime_id"],
            "leased_until": None,
            "created_at": "2026-07-04T00:00:00Z",
        }

        findings = state.reconcile_dispatch_acks()

    assert findings == [
        {
            "code": "dispatch_ack_without_terminal_run_event",
            "dispatch_id": "dispatch-1",
            "issue_id": "issue-1",
            "runtime_phase": "reviewing",
            "status": "completed",
        }
    ]


@pytest.mark.asyncio
async def test_linear_proxy_requires_proxy_token_and_audits_requests() -> None:
    seen_authorization: list[str] = []

    def linear_transport(request: httpx.Request) -> httpx.Response:
        seen_authorization.append(request.headers["Authorization"])
        return httpx.Response(200, json={"data": {"viewer": {"id": "viewer-1"}}})

    app = make_app(linear_graphql_transport=linear_transport)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "proxy@example.com")
        enrolled = await enroll_conductor(client)

        unauthorized = await client.post("/api/v1/linear/graphql", json={"query": "{ viewer { id } }"})
        missing_installation = await client.post(
            "/api/v1/linear/graphql",
            json={"operationName": "Viewer", "query": "{ viewer { id } }"},
            headers={"Authorization": f"Bearer {enrolled['proxy_token']}"},
        )

        await app.state.podium.save_linear_installation(user_id, {
            "workspace_id": user_id,
            "access_token": "oauth-installation-token",
            "scope": "read write",
            "expires_at": None,
        })
        allowed = await client.post(
            "/api/v1/linear/graphql",
            json={"operationName": "Viewer", "query": "{ viewer { id } }"},
            headers={"Authorization": f"Bearer {enrolled['proxy_token']}"},
        )

    assert unauthorized.status_code == 401
    assert missing_installation.status_code == 400
    assert missing_installation.json()["error"]["code"] == "linear_installation_not_found"
    assert allowed.status_code == 200
    assert allowed.json() == {"data": {"viewer": {"id": "viewer-1"}}}
    assert seen_authorization == ["oauth-installation-token"]


@pytest.mark.asyncio
async def test_linear_proxy_persists_audit_event_when_postgres_is_injected() -> None:
    from tests.test_podium_infra import FakePgStore

    pg_store = FakePgStore()

    def linear_transport(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"viewer": {"id": "viewer-1"}}})

    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        secret_key="test-secret",
        pg_store=pg_store,
        linear_graphql_transport=linear_transport,
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "pg-audit@example.com")
        enrolled = await enroll_conductor(client)
        await app.state.podium.save_linear_installation(user_id, {
            "workspace_id": user_id,
            "access_token": "oauth-installation-token",
            "scope": "read write",
            "expires_at": None,
        })
        proxied = await client.post(
            "/api/v1/linear/graphql",
            json={"operationName": "Viewer", "query": "query Viewer { viewer { id } }"},
            headers={"Authorization": f"Bearer {enrolled['proxy_token']}"},
        )

    assert proxied.status_code == 200
    assert pg_store.proxy_audit_events == [
        {
            "runtime_id": enrolled["runtime_id"],
            "allowed": True,
            "operation_name": "Viewer",
            "workspace_id": user_id,
            "timestamp": pg_store.proxy_audit_events[0]["timestamp"],
        }
    ]
    assert "oauth-installation-token" not in json.dumps(pg_store.proxy_audit_events)


@pytest.mark.asyncio
async def test_linear_proxy_returns_structured_error_for_corrupt_stored_token() -> None:
    from tests.test_podium_infra import FakePgStore

    pg_store = FakePgStore()
    app = make_app(pg_store=pg_store)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "proxy-secret-error@example.com")
        enrolled = await enroll_conductor(client)
        await app.state.podium.save_linear_installation(
            user_id,
            {
                "workspace_id": user_id,
                "access_token": "oauth-installation-token",
                "scope": "read write",
                "expires_at": None,
            },
        )
        pg_store.linear_installations[user_id]["access_token_encrypted"] = "not-a-fernet-token"

        response = await client.post(
            "/api/v1/linear/graphql",
            json={"operationName": "Viewer", "query": "{ viewer { id } }"},
            headers={"Authorization": f"Bearer {enrolled['proxy_token']}"},
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "secret_decryption_failed"
    assert pg_store.proxy_audit_events[-1]["reason"] == "secret_decryption_failed"


@pytest.mark.asyncio
async def test_linear_proxy_can_use_environment_access_token_without_workspace_installation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, str | None] = {}

    def linear_transport(request: httpx.Request) -> httpx.Response:
        captured["authorization"] = request.headers.get("Authorization")
        return httpx.Response(200, json={"data": {"viewer": {"id": "viewer-1"}}})

    monkeypatch.setenv("PODIUM_LINEAR_ACCESS_TOKEN", "operator-linear-token")
    app = make_app(linear_graphql_transport=linear_transport)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await register(client, "env-proxy@example.com")
        enrolled = await enroll_conductor(client)
        proxied = await client.post(
            "/api/v1/linear/graphql",
            json={"query": "query { viewer { id } }"},
            headers={"Authorization": f"Bearer {enrolled['proxy_token']}"},
        )

    assert proxied.status_code == 200
    assert proxied.json() == {"data": {"viewer": {"id": "viewer-1"}}}
    assert captured["authorization"] == "operator-linear-token"


def test_runtime_ws_presence_dispatch_wakeup_and_log_fetch_roundtrip() -> None:
    with TestClient(make_app()) as client:
        register_response = client.post(
            "/api/v1/auth/register",
            json={"email": "ws@example.com", "password": "correct-horse", "turnstile_token": "turnstile-ok"},
        )
        assert register_response.status_code == 200
        user_id = register_response.json()["user"]["id"]
        token_response = client.post("/api/v1/onboarding/runtime/enrollment-token")
        enrolled = client.post("/api/v1/runtime/enroll", json={"enrollment_token": token_response.json()["enrollment_token"]}).json()
        client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={"bindings": [{"instance_id": "inst-a", "project_slug": "ALPHA", "agent_app_user_id": "agent-alpha"}]},
        )

        with client.websocket_connect(
            "/api/v1/runtime/ws",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        ) as ws:
            ws.send_json({"type": "hello"})
            assert ws.receive_json()["type"] == "ping"

            queued = client.post(
                "/api/v1/linear/webhooks/agent-session",
                content=json.dumps(agent_session_payload(workspace_id=user_id, project_slug="ALPHA", delegate_id="agent-alpha")).encode(),
                headers={"Content-Type": "application/json", "Linear-Signature": "ignored"},
            )
            assert queued.status_code == 200
            wakeup = ws.receive_json()
            assert wakeup["type"] == "dispatch.available"
            assert wakeup["instance_id"] == "inst-a"

            fetch = client.get(f"/api/v1/runtimes/{enrolled['runtime_id']}/instances/inst-a/logs?tail=3&previous=1")
            assert fetch.status_code == 202
            command = ws.receive_json()
            assert command["type"] == "log.fetch"
            assert command["instance_id"] == "inst-a"
            assert command["tail"] == 3
            assert command["previous"] is True
            chunk = client.post(
                "/api/v1/runtime/log-chunks",
                headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
                json={
                    "request_id": command["request_id"],
                    "instance_id": "inst-a",
                    "generation": 2,
                    "offset_start": 10,
                    "offset_end": 20,
                    "order": "desc",
                    "lines": ["tail-1", "tail-2"],
                },
            )
            assert chunk.status_code == 200
            result = client.get(f"/api/v1/runtime/log-fetches/{command['request_id']}")
            assert result.status_code == 200
            assert result.json()["logs"]["lines"] == ["tail-1", "tail-2"]

        listed = client.get("/api/v1/runtimes")
        assert listed.json()["conductors"][0]["online"] is False
