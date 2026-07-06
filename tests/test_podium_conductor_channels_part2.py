from test_podium_conductor_channels_support import *  # noqa: F401,F403

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

def test_runtime_ws_rejects_invalid_fencing_token_without_closing_loop() -> None:
    app = make_app()
    with TestClient(app) as client:
        user_id = client.post(
            "/api/v1/auth/register",
            json={"email": "ws-invalid-fence@example.com", "password": "correct-horse", "turnstile_token": "turnstile-ok"},
        ).json()["user"]["id"]
        token = client.post("/api/v1/onboarding/runtime/enrollment-token").json()["enrollment_token"]
        enrolled = client.post(
            "/api/v1/runtime/enroll",
            json={"enrollment_token": token, "hostname": "server-a", "label": "Server A", "version": "0.2.0"},
        ).json()
        with client.websocket_connect(
            "/api/v1/runtime/ws",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        ) as websocket:
            websocket.send_json({"type": "dispatch.ack", "dispatch_id": "missing", "fencing_token": "not-int"})
            invalid = websocket.receive_json()
            websocket.send_json({"type": "heartbeat"})
            heartbeat = websocket.receive_json()

    assert user_id
    assert invalid["type"] == "error"
    assert invalid["code"] == "invalid_fencing_token"
    assert heartbeat == {"type": "ping"}

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
