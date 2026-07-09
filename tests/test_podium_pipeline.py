from __future__ import annotations

from test_podium_conductor_channels_support import *  # noqa: F401,F403


async def test_runtime_config_push_rejects_stale_versions_and_sanitizes_pipeline_view() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await register(client, "pipeline@example.com")
        enrolled = await enroll_conductor(client)
        payload = {
            "version": 2,
            "scheduler_policy": {
                "policy_id": "policy-2",
                "version": 2,
                "effective_at": "2026-07-06T00:00:00Z",
                "capacity": {"global": 4, "by_mode": {"plan": 1, "execute": None, "verify": 2}},
            },
            "profiles": {
                "plan": {
                    "name": "planner",
                    "backend": "codex",
                    "settings": {
                        "model": "gpt-5.3-codex",
                        "token": "secret-token",
                        "codex_home_source": "$SYMPHONY_E2E_CODEX_HOME_SOURCE",
                    },
                },
                "execute": {
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
        browser_view = await client.get("/api/v1/pipeline")
        runtime_view = await client.get(
            "/api/v1/runtime/config",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )

    assert accepted.status_code == 200
    assert accepted.json()["accepted"] is True
    assert stale.status_code == 409
    assert browser_view.status_code == 200
    assert browser_view.json()["policy_revision"] == 2
    assert browser_view.json()["profiles"]["plan"]["settings"] == {"model": "gpt-5.3-codex"}
    assert "secret-token" not in str(browser_view.json())
    assert "codex_home_source" not in str(browser_view.json())
    assert "SYMPHONY_E2E_CODEX_HOME_SOURCE" not in str(browser_view.json())
    assert runtime_view.status_code == 200
    assert runtime_view.json()["config"]["version"] == 2
    assert runtime_view.json()["config"]["profiles"]["plan"]["settings"]["codex_home_source"] == "$SYMPHONY_E2E_CODEX_HOME_SOURCE"


async def test_runtime_config_push_rejects_incomplete_pipeline_profiles() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await register(client, "pipeline-invalid@example.com")
        enrolled = await enroll_conductor(client)
        rejected = await client.post(
            "/api/v1/runtime/config",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "version": 3,
                "scheduler_policy": {
                    "policy_id": "policy-3",
                    "version": 3,
                    "effective_at": "2026-07-06T00:00:00Z",
                    "capacity": {"global": 4, "by_mode": {"plan": 1, "execute": 1, "verify": 1}},
                },
                "profiles": {
                    "plan": {"name": "planner", "backend": "codex", "settings": {"model": "gpt-5.3-codex"}}
                },
            },
        )

    assert rejected.status_code == 400
    assert rejected.json()["error"]["code"] == "invalid_runtime_config"
    assert "runtime_profiles_missing:execute,verify" in rejected.json()["error"]["details"]
