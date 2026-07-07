from test_podium_conductor_channels_support import *  # noqa: F401,F403

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
                        "pipeline_profile": "gated-task",
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
                        "pipeline_profile": "default",
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

async def test_runtime_report_returns_stored_runtime_config_for_conductor() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await register(client, "runtime-config-report@example.com")
        enrolled = await enroll_conductor(client)
        config = {
            "version": 7,
            "scheduler_policy": {
                "policy_id": "policy-e2e",
                "version": 7,
                "effective_at": "2026-07-07T00:00:00Z",
                "capacity": {"global": 3, "by_mode": {"plan": 1, "execute": 1, "verify": 1}},
                "dependency_policy": "verify_passed",
                "max_rework_attempts": 1,
            },
            "profiles": {
                "plan": {"name": "codex-plan", "backend": "codex", "mode": "plan", "settings": {"model": "gpt-5.3-codex"}},
                "execute": {"name": "codex-execute", "backend": "codex", "mode": "execute", "settings": {"model": "gpt-5.3-codex"}},
                "verify": {"name": "codex-verify", "backend": "codex", "mode": "verify", "settings": {"model": "gpt-5.3-codex"}},
            },
        }

        pushed = await client.post(
            "/api/v1/runtime/config",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json=config,
        )
        report = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={"bindings": []},
        )

    assert pushed.status_code == 200
    assert report.status_code == 200
    body = report.json()
    assert body["status"] == "ok"
    assert body["config"]["runtime_group_id"] == enrolled["runtime_group_id"]
    assert body["config"]["version"] == 7
    assert sorted(body["config"]["profiles"]) == ["execute", "plan", "verify"]
    assert body["config"]["profiles"]["plan"]["settings"]["model"] == "gpt-5.3-codex"

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

async def test_injected_postgres_lease_loads_runtime_from_pg_when_memory_empty() -> None:
    from tests.test_podium_infra import FakePgStore, FakeRedisStore

    pg_store = FakePgStore()
    redis_store = FakeRedisStore()
    enroll_app = make_app(pg_store=pg_store, redis_store=redis_store)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=enroll_app), base_url="http://podium.test") as client:
        user_id = await register(client, "lease-pg-runtime@example.com")
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

    lease_app = make_app(pg_store=pg_store, redis_store=redis_store)
    assert lease_app.state.podium.runtimes == {}

    leased = await lease_app.state.podium.lease_dispatch(enrolled["runtime_id"])

    assert queued.status_code == 200
    assert leased is not None
    assert leased["issue_identifier"] == "ALPHA-1"
    assert lease_app.state.podium.runtimes[enrolled["runtime_id"]]["id"] == enrolled["runtime_id"]

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
            json={"dispatch_id": dispatch["dispatch_id"], "status": "completed"},
        )
        ack = await client.post(
            "/api/v1/runtime/dispatches/ack",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "dispatch_id": dispatch["dispatch_id"],
                "fencing_token": dispatch["fencing_token"],
                "status": "completed",
                "reason": "completed_by_runtime",
                "graph_id": "graph-1",
                "node_id": "node-1",
                "attempt_id": "attempt-1",
                "mode": "verify",
                "attempt_status": "succeeded",
                "graph_revision": 1,
                "policy_revision": 1,
                "lease_id": "lease-1",
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
    assert "codex_profile" not in dispatch
    assert "sk-" not in json.dumps(dispatch)

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
                        "pipeline_profile": "gated-task",
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
                "graph_id": "graph-1",
                "node_id": "node-1",
                "attempt_id": "attempt-1",
                "mode": "verify",
                "attempt_status": "succeeded",
                "graph_revision": 1,
                "policy_revision": 1,
                "lease_id": "lease-1",
            },
        )

    assert rejected.status_code == 200
    assert rejected.json()["queued"] == 0
    assert queued.status_code == 200
    assert queued.json()["queued"] == 1
    assert dispatch["issue_id"] == "issue-1"
    assert dispatch["issue_identifier"] == "ALPHA-1"
    assert dispatch["pipeline_profile"] == "gated-task"
    assert "workflow_profile" not in dispatch
    assert ack.status_code == 200
    assert ack.json()["dispatch"]["status"] == "completed"
    assert ack.json()["dispatch"]["reason"] == "completed_by_runtime"
    assert "runtime_phase" not in ack.json()["dispatch"]
    assert ack.json()["dispatch"]["graph_id"] == "graph-1"

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
        pipeline = await client.get("/api/v1/pipeline")

    assert first.status_code == 200
    assert first.json()["queued"] == 1
    assert second.status_code == 200
    assert second.json()["queued"] == 0
    assert pipeline.status_code == 200
    assert "pipeline" in pipeline.json()

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
