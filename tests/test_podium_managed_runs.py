from __future__ import annotations

from test_podium_conductor_channels_support import *  # noqa: F401,F403


def runtime_config(version: int, *, secret: str = "") -> dict[str, Any]:
    plan_settings = {"model": "gpt-5.3-codex"}
    if secret:
        plan_settings.update(
            {
                "token": secret,
                "codex_home_source": "$SYMPHONY_E2E_CODEX_HOME_SOURCE",
            }
        )
    return {
        "version": version,
        "managed_run_policy": {
            "policy_id": f"policy-{version}",
            "version": version,
            "effective_at": "2026-07-06T00:00:00Z",
            "capacity": {"global": 4, "by_role": {"plan": 1, "work_item": None, "verify": 2}},
        },
        "profiles": {
            "plan": {"name": "planner", "backend": "codex", "settings": plan_settings},
            "work_item": {
                "name": "executor",
                "backend": "codex",
                "settings": {"model": "gpt-5.3-codex"},
            },
            "verify": {
                "name": "verifier",
                "backend": "codex",
                "settings": {"model": "gpt-5.3-codex"},
            },
        },
    }


async def test_runtime_config_push_rejects_stale_versions_and_sanitizes_managed_runs_view() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "managed-runs@example.com")
        await activate_linear_installation(app, user_id)
        enrolled = await enroll_conductor(client)
        await bind_and_ack_conductor(app, client, user_id, enrolled)
        payload = runtime_config(2, secret="secret-token")

        accepted = await client.post(
            "/api/v1/runtime/config",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json=payload,
        )
        stale = await client.post(
            "/api/v1/runtime/config",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json=payload,
        )
        browser_view = await client.get("/api/v1/managed-runs")
        removed_managed_run_view = await client.get("/api/v1/managed_run")
        removed_view = await client.get("/api/v1/pipeline")
        runtime_view = await client.get(
            "/api/v1/runtime/config",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )

    assert accepted.status_code == 200
    assert accepted.json()["accepted"] is True
    assert stale.status_code == 409
    assert browser_view.status_code == 200
    assert removed_managed_run_view.status_code == 404
    assert removed_view.status_code == 404
    assert len(browser_view.json()["conductors"]) == 1
    report = browser_view.json()["conductors"][0]
    assert report["policy_revision"] == 2
    assert report["project"] == {"id": "project-alpha", "slug": "ALPHA", "name": "Alpha"}
    assert "managed_runs" in report
    assert report["profiles"]["plan"]["settings"] == {"model": "gpt-5.3-codex"}
    assert "runtime_group_id" not in browser_view.json()
    assert "managed_runs" not in browser_view.json()
    assert "secret-token" not in str(browser_view.json())
    assert "codex_home_source" not in str(browser_view.json())
    assert "SYMPHONY_E2E_CODEX_HOME_SOURCE" not in str(browser_view.json())
    assert runtime_view.status_code == 200
    assert runtime_view.json()["config"]["version"] == 2
    assert runtime_view.json()["config"]["profiles"]["plan"]["settings"]["codex_home_source"] == "$SYMPHONY_E2E_CODEX_HOME_SOURCE"


async def test_managed_runs_aggregates_every_project_conductor() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "managed-runs-many@example.com")
        await activate_linear_installation(
            app,
            user_id,
            projects=[
                {"id": "project-alpha", "name": "Alpha", "slug_id": "ALPHA"},
                {"id": "project-beta", "name": "Beta", "slug_id": "BETA"},
            ],
        )
        await app.state.podium.select_linear_projects(user_id, ["project-alpha", "project-beta"])
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
            instance_id="inst-beta",
            repository="/repo/beta",
        )
        for enrolled, version, run_id in ((alpha, 2, "run-alpha"), (beta, 5, "run-beta")):
            headers = {"Authorization": f"Bearer {enrolled['runtime_token']}"}
            accepted = await client.post("/api/v1/runtime/config", headers=headers, json=runtime_config(version))
            reported = await client.post(
                "/api/v1/runtime/report",
                headers=headers,
                json={"managed_runs": {"runs": [{"run_id": run_id, "work_items": []}]}},
            )
            assert accepted.status_code == 200
            assert reported.status_code == 200

        response = await client.get("/api/v1/managed-runs")

    assert response.status_code == 200
    reports = response.json()["conductors"]
    assert [row["project"]["slug"] for row in reports] == ["ALPHA", "BETA"]
    assert [row["policy_revision"] for row in reports] == [2, 5]
    assert [row["managed_runs"]["runs"][0]["run_id"] for row in reports] == ["run-alpha", "run-beta"]
    assert {row["conductor"]["id"] for row in reports} == {alpha["runtime_id"], beta["runtime_id"]}


async def test_runtime_config_push_rejects_incomplete_runtime_profiles() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await register(client, "managed-runs-invalid@example.com")
        enrolled = await enroll_conductor(client)
        rejected = await client.post(
            "/api/v1/runtime/config",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "version": 3,
                "managed_run_policy": {
                    "policy_id": "policy-3",
                    "version": 3,
                    "effective_at": "2026-07-06T00:00:00Z",
                    "capacity": {"global": 4, "by_role": {"plan": 1, "work_item": 1, "verify": 1}},
                },
                "profiles": {
                    "plan": {"name": "planner", "backend": "codex", "settings": {"model": "gpt-5.3-codex"}}
                },
            },
        )

    assert rejected.status_code == 400
    assert rejected.json()["error"]["code"] == "invalid_runtime_config"
    assert "runtime_profiles_missing:verify,work_item" in rejected.json()["error"]["details"]
