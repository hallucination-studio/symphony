from test_podium_conductor_channels_support import *  # noqa: F401,F403

async def test_runtime_report_upserts_conductor_bindings_metrics_and_log_tail() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client)
        enrolled = await enroll_conductor(client)
        report, _ = await bind_and_ack_conductor(
            app,
            client,
            user_id,
            enrolled,
            report_overrides={"process_status": "running"},
            report_extras={
                "hostname": "server-a",
                "label": "Server A",
                "version": "0.2.1",
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
    assert report.json()["bindings_upserted"] == 1
    assert listed.status_code == 200
    conductor = listed.json()["conductors"][0]
    assert conductor["conductor_id"] == enrolled["runtime_id"]
    assert conductor["online"] is True
    assert [binding["project_slug"] for binding in conductor["bindings"]] == ["ALPHA"]
    assert conductor["bindings"][0]["metrics"]["tokens"] == 10
    assert conductor["bindings"][0]["metrics"]["pending_human"] == 4
    assert conductor["bindings"][0]["queue"]["queue_depth"] == 6
    assert conductor["bindings"][0]["constraint_labels"] == []
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
            "managed_run_policy": {
                "policy_id": "policy-e2e",
                "version": 7,
                "effective_at": "2026-07-07T00:00:00Z",
                "capacity": {"global": 3, "by_role": {"plan": 1, "work_item": 1, "verify": 1}},
                "max_rework_attempts": 1,
            },
            "profiles": {
                "plan": {"name": "codex-plan", "backend": "codex", "role": "plan", "settings": {"model": "gpt-5.3-codex"}},
                "work_item": {"name": "codex-work-item", "backend": "codex", "role": "work_item", "settings": {"model": "gpt-5.3-codex"}},
                "verify": {"name": "codex-verify", "backend": "codex", "role": "verify", "settings": {"model": "gpt-5.3-codex"}},
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
    assert sorted(body["config"]["profiles"]) == ["plan", "verify", "work_item"]
    assert body["config"]["profiles"]["plan"]["settings"]["model"] == "gpt-5.3-codex"

async def test_injected_json_store_persists_auth_across_app_restart() -> None:
    from podium.store import PodiumStore

    store = PodiumStore()
    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        secret_key="test-secret",
        store=store,
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "durable-routing@example.com")

    restarted = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        secret_key="test-secret",
        store=store,
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
    assert await store.get_user(user_id) is not None
    assert store._load_map("sessions.json")

async def test_injected_postgres_persists_runtime_credentials_across_app_restart() -> None:
    from podium.store import PodiumStore

    store = PodiumStore()
    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        secret_key="test-secret",
        store=store,
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "durable-runtime@example.com")
        enrolled = await enroll_conductor(client)
        initial_report, binding = await bind_and_ack_conductor(app, client, user_id, enrolled)
        assert initial_report.status_code == 200

    restarted = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        secret_key="test-secret",
        store=store,
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=restarted), base_url="http://podium.test") as client:
        report = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "bindings": [
                    {
                        "instance_id": "inst-a",
                        "linear_project_id": "project-alpha",
                        "project_slug": "ALPHA",
                        "agent_app_user_id": "agent-alpha",
                        "binding_config_version": binding["config_version"],
                        "repo_source": {"type": "local_path", "value": "/repo/a"},
                    }
                ]
            },
        )

    assert report.status_code == 200
    assert report.json()["bindings_upserted"] == 1
    assert f"binding_{enrolled['runtime_id']}" in store._load_map("project_bindings.json")

async def test_injected_postgres_persists_queued_dispatch_across_app_restart() -> None:
    from podium.store import PodiumStore

    store = PodiumStore()
    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        secret_key="test-secret",
        store=store,
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "durable-dispatch@example.com")
        enrolled = await enroll_conductor(client)
        await bind_and_ack_conductor(app, client, user_id, enrolled)
        queued = await queue_agent_session(
            app,
            agent_session_payload(workspace_id=user_id, project_slug="ALPHA", delegate_id="agent-alpha"),
        )

    restarted = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        secret_key="test-secret",
        store=store,
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


async def test_injected_postgres_persists_structured_managed_run_intent_across_app_restart() -> None:
    from podium.store import PodiumStore

    store = PodiumStore()
    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        secret_key="test-secret",
        store=store,
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "durable-intent-dispatch@example.com")
        enrolled = await enroll_conductor(client)
        await bind_and_ack_conductor(app, client, user_id, enrolled)
        queued = await queue_agent_session(
            app,
            agent_session_payload_with_managed_run_intent(
                workspace_id=user_id,
                project_slug="ALPHA",
                delegate_id="agent-alpha",
            ),
        )

    restarted = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        secret_key="test-secret",
        store=store,
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=restarted), base_url="http://podium.test") as client:
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )

    assert queued.status_code == 200
    assert queued.json()["queued"] == 1
    assert lease.status_code == 200
    dispatch = lease.json()["dispatch"]
    assert dispatch["managed_run_intent"]["parallel_dependency_shape"]["parallel_branch_node_ids"] == [
        "parallel-a",
        "parallel-b",
    ]


async def test_injected_store_routes_direct_dispatch_and_lease_across_distinct_workers() -> None:
    from podium.store import PodiumStore

    store = PodiumStore()

    enrollment_app = make_app(store=store)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=enrollment_app), base_url="http://podium.test") as client:
        user_id = await register(client, "multiworker@example.com")
        enrolled = await enroll_conductor(client)
        report, _ = await bind_and_ack_conductor(enrollment_app, client, user_id, enrolled)

    queue_app = make_app(store=store)
    queued = await queue_agent_session(
        queue_app,
        agent_session_payload(workspace_id=user_id, project_slug="ALPHA", delegate_id="agent-alpha"),
    )

    lease_app = make_app(store=store)
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
    assert dispatch["project_binding_id"] == f"binding_{enrolled['runtime_id']}"
    assert dispatch["fencing_token"] == 1

async def test_injected_store_lease_loads_runtime_from_persisted_state_after_restart() -> None:
    from podium.store import PodiumStore

    store = PodiumStore()
    enroll_app = make_app(store=store)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=enroll_app), base_url="http://podium.test") as client:
        user_id = await register(client, "lease-pg-runtime@example.com")
        enrolled = await enroll_conductor(client)
        await bind_and_ack_conductor(enroll_app, client, user_id, enrolled)
        queued = await queue_agent_session(
            enroll_app,
            agent_session_payload(workspace_id=user_id, project_slug="ALPHA", delegate_id="agent-alpha"),
        )

    lease_app = make_app(store=store)

    leased = await lease_app.state.podium.lease_dispatch(enrolled["runtime_id"])

    assert queued.status_code == 200
    assert leased is not None
    assert leased["issue_identifier"] == "ALPHA-1"
    assert (await store.get_runtime(enrolled["runtime_id"]))["id"] == enrolled["runtime_id"]

async def test_injected_postgres_acks_leased_dispatch_across_distinct_workers_and_requires_fencing() -> None:
    from podium.store import PodiumStore

    store = PodiumStore()

    enrollment_app = make_app(store=store)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=enrollment_app), base_url="http://podium.test") as client:
        user_id = await register(client, "multiworker-ack@example.com")
        enrolled = await enroll_conductor(client)
        await bind_and_ack_conductor(enrollment_app, client, user_id, enrolled)

    queue_app = make_app(store=store)
    queued = await queue_agent_session(
        queue_app,
        agent_session_payload(workspace_id=user_id, project_slug="ALPHA", delegate_id="agent-alpha"),
    )

    lease_app = make_app(store=store)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=lease_app), base_url="http://podium.test") as client:
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )
    dispatch = lease.json()["dispatch"]

    ack_app = make_app(store=store)
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
                "run_id": "run-1",
                "parent_issue_id": "issue-1",
                "active_work_item_id": "wi-1",
                "managed_run_state": "done",
                "plan_version": 1,
                "backend_session_id": "thread-1",
            },
        )

    assert queued.status_code == 200
    assert queued.json()["queued"] == 1
    assert lease.status_code == 200
    assert missing_fence.status_code == 409
    assert missing_fence.json()["error"]["code"] == "stale_dispatch_lease"
    assert ack.status_code == 200
    assert ack.json()["dispatch"]["status"] == "completed"
    assert store._load_map("dispatches.json")[dispatch["dispatch_id"]]["status"] == "completed"

async def test_injected_postgres_reaps_expired_leased_dispatch_for_release() -> None:
    from podium.store import PodiumStore

    store = PodiumStore()
    app = make_app(store=store)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "reaper@example.com")
        enrolled = await enroll_conductor(client)
        await bind_and_ack_conductor(app, client, user_id, enrolled)
        await queue_agent_session(
            app,
            agent_session_payload(workspace_id=user_id, project_slug="ALPHA", delegate_id="agent-alpha"),
        )
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )

    dispatch_id = lease.json()["dispatch"]["dispatch_id"]
    dispatch_rows = store._load_map("dispatches.json")
    dispatch_rows[dispatch_id]["leased_until"] = "2026-01-01T00:00:00Z"
    store._write("dispatches.json", dispatch_rows)

    reaper_app = make_app(store=store)
    reaped = await reaper_app.state.podium.reap_expired_dispatch_leases()

    lease_app = make_app(store=store)
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
        await activate_linear_installation(
            app,
            user_id,
            projects=[
                {"id": "project-alpha", "name": "Alpha", "slug_id": "ALPHA"},
                {"id": "project-beta", "name": "Beta", "slug_id": "BETA"},
            ],
        )
        alpha = await enroll_conductor(client)
        beta = await enroll_conductor(client)
        await bind_and_ack_conductor(app, client, user_id, alpha)
        await bind_and_ack_conductor(
            app,
            client,
            user_id,
            beta,
            project_id="project-beta",
            project_slug="BETA",
            app_user_id="agent-alpha",
            instance_id="inst-b",
        )
        queued = await queue_agent_session(
            app,
            agent_session_payload(workspace_id=user_id, project_slug="BETA", delegate_id="agent-alpha"),
        )
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {beta['runtime_token']}"},
        )

    assert queued.status_code == 200
    assert queued.json()["queued"] == 1
    assert lease.status_code == 200
    dispatch = lease.json()["dispatch"]
    assert dispatch["project_binding_id"] == f"binding_{beta['runtime_id']}"
    assert dispatch["project_slug"] == "BETA"
    assert dispatch["instance_id"] == "inst-b"
    assert "codex_profile" not in dispatch
    assert "sk-" not in json.dumps(dispatch)

async def test_direct_dispatch_routes_when_either_session_or_issue_delegate_matches() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "routing-or@example.com")
        await activate_linear_installation(
            app,
            user_id,
            projects=[
                {"id": "project-alpha", "name": "Alpha", "slug_id": "ALPHA"},
                {"id": "project-beta", "name": "Beta", "slug_id": "BETA"},
            ],
        )
        alpha = await enroll_conductor(client)
        beta = await enroll_conductor(client)
        await bind_and_ack_conductor(app, client, user_id, alpha)
        await bind_and_ack_conductor(
            app,
            client,
            user_id,
            beta,
            project_id="project-beta",
            project_slug="BETA",
            app_user_id="agent-alpha",
            instance_id="inst-b",
        )

        issue_delegate_match = await queue_agent_session(
            app,
            agent_session_payload_with_distinct_session_app_user(
                workspace_id=user_id,
                project_slug="ALPHA",
                session_app_user_id="other-agent",
                issue_delegate_id="agent-alpha",
            ),
        )
        session_app_match = await queue_agent_session(
            app,
            agent_session_payload_with_distinct_session_app_user(
                workspace_id=user_id,
                project_slug="BETA",
                session_app_user_id="agent-alpha",
                issue_delegate_id="other-agent",
            ),
        )

    assert issue_delegate_match.status_code == 200
    assert issue_delegate_match.json()["queued"] == 1
    assert session_app_match.status_code == 200
    assert session_app_match.json()["queued"] == 1

async def test_direct_dispatch_preserves_dependency_metadata_for_runtime_dispatch() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "dependency-routing@example.com")
        enrolled = await enroll_conductor(client)
        await bind_and_ack_conductor(app, client, user_id, enrolled)
        queued = await queue_agent_session(
            app,
            dependent_agent_session_payload(workspace_id=user_id, project_slug="ALPHA", delegate_id="agent-alpha"),
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


async def test_direct_dispatch_preserves_structured_managed_run_intent_for_runtime_dispatch() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "intent-routing@example.com")
        enrolled = await enroll_conductor(client)
        await bind_and_ack_conductor(app, client, user_id, enrolled)
        queued = await queue_agent_session(
            app,
            agent_session_payload_with_managed_run_intent(
                workspace_id=user_id,
                project_slug="ALPHA",
                delegate_id="agent-alpha",
            ),
        )
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )

    assert queued.status_code == 200
    assert queued.json()["queued"] == 1
    dispatch = lease.json()["dispatch"]
    assert dispatch["managed_run_intent"]["parallel_dependency_shape"] == {
        "parallel_branch_node_ids": ["parallel-a", "parallel-b"],
        "downstream_node_ids": ["downstream"],
    }
    assert dispatch["managed_run_intent"]["required_gate_steps"] == [
        {"step": "pytest tests/test_smoke.py -q", "source": "acceptance_appendix"}
    ]


async def test_agent_session_webhook_http_route_is_removed() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        response = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            json={"type": "AgentSessionEvent"},
        )

    assert response.status_code == 404

async def test_direct_dispatch_queue_and_runtime_ack_completes_it() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "direct-routing@example.com")
        enrolled = await enroll_conductor(client)
        await bind_and_ack_conductor(app, client, user_id, enrolled)

        rejected = await queue_agent_session(
            app,
            agent_session_payload(
            workspace_id=user_id,
            project_slug="ALPHA",
            delegate_id="other-agent",
            ),
        )

        queued = await queue_agent_session(
            app,
            agent_session_payload(
                workspace_id=user_id,
                project_slug="ALPHA",
                delegate_id="agent-alpha",
            ),
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
                "fencing_token": dispatch["fencing_token"],
                "status": "completed",
                "reason": "completed_by_runtime",
                "run_id": "run-1",
                "parent_issue_id": "issue-1",
                "active_work_item_id": "wi-1",
                "managed_run_state": "done",
                "plan_version": 1,
                "backend_session_id": "thread-1",
            },
        )

    assert rejected.status_code == 200
    assert rejected.json()["queued"] == 0
    assert queued.status_code == 200
    assert queued.json()["queued"] == 1
    assert dispatch["issue_id"] == "issue-1"
    assert dispatch["issue_identifier"] == "ALPHA-1"
    assert dispatch["managed_run_profile"] == "default"
    assert "workflow_profile" not in dispatch
    assert ack.status_code == 200
    assert ack.json()["dispatch"]["status"] == "completed"
    assert ack.json()["dispatch"]["reason"] == "completed_by_runtime"
    assert "runtime_phase" not in ack.json()["dispatch"]
    assert ack.json()["dispatch"]["run_id"] == "run-1"
    assert ack.json()["dispatch"]["active_work_item_id"] == "wi-1"
    assert ack.json()["dispatch"]["managed_run_state"] == "done"
    assert "graph_id" not in ack.json()["dispatch"]

async def test_direct_dispatch_queue_is_idempotent_by_binding_and_agent_session() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "idempotent-dispatch@example.com")
        enrolled = await enroll_conductor(client)
        await bind_and_ack_conductor(app, client, user_id, enrolled)
        payload = agent_session_payload(workspace_id=user_id, project_slug="ALPHA", delegate_id="agent-alpha")

        first = await queue_agent_session(app, payload)
        second = await queue_agent_session(app, payload)
        managed_runs = await client.get("/api/v1/managed-runs")
        removed_managed_run = await client.get("/api/v1/managed_run")
        old_pipeline = await client.get("/api/v1/pipeline")

    assert first.status_code == 200
    assert first.json()["queued"] == 1
    assert second.status_code == 200
    assert second.json()["queued"] == 0
    assert managed_runs.status_code == 200
    assert removed_managed_run.status_code == 404
    assert "managed_runs" in managed_runs.json()["conductors"][0]
    assert old_pipeline.status_code == 404

async def test_injected_postgres_empty_agent_session_id_dedupes_by_issue_not_binding_only() -> None:
    from podium.store import PodiumStore

    store = PodiumStore()
    app = make_app(store=store)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "empty-session@example.com")
        enrolled = await enroll_conductor(client)
        await bind_and_ack_conductor(app, client, user_id, enrolled)
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

        first_a = await queue_agent_session(app, issue_a)
        second_a = await queue_agent_session(app, issue_a)
        first_b = await queue_agent_session(app, issue_b)

    assert first_a.status_code == 200
    assert first_a.json()["queued"] == 1
    assert second_a.status_code == 200
    assert second_a.json()["queued"] == 0
    assert first_b.status_code == 200
    assert first_b.json()["queued"] == 1
    assert sorted(dispatch["issue_identifier"] for dispatch in store._load_map("dispatches.json").values()) == ["ALPHA-1", "ALPHA-2"]
