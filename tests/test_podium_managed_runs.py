from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from podium.app import create_app


USER = {"id": "user-1", "email": "managed-runs@example.com"}


class _ManagedRunViewStore:
    def __init__(self) -> None:
        self.conductors: list[dict[str, Any]] = []
        self.bindings: list[dict[str, Any]] = []
        self.configs: dict[str, dict[str, Any]] = {}
        self.views: dict[str, dict[str, Any]] = {}
        self.online_runtime_ids: set[str] = set()

    async def get_runtime_config(self, group_id: str) -> dict[str, Any] | None:
        return self.configs.get(group_id)

    async def save_runtime_config(self, group_id: str, config: dict[str, Any]) -> None:
        self.configs[group_id] = dict(config)

    async def get_managed_run_view(self, group_id: str) -> dict[str, Any] | None:
        return self.views.get(group_id)

    async def save_managed_run_view(self, group_id: str, view: dict[str, Any]) -> None:
        self.views[group_id] = dict(view)

    async def list_conductors_for_user(self, user_id: str) -> list[dict[str, Any]]:
        return [
            dict(row) for row in self.conductors if row.get("user_id") == user_id
        ]

    async def list_project_bindings_for_user(self, user_id: str) -> list[dict[str, Any]]:
        return [dict(row) for row in self.bindings if row.get("user_id") == user_id]

    async def get_presence(self, runtime_id: str) -> dict[str, str] | None:
        if runtime_id not in self.online_runtime_ids:
            return None
        return {"last_seen_at": "2026-07-11T00:00:00Z"}


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
            "capacity": {
                "global": 4,
                "by_role": {"plan": 1, "work_item": None, "verify": 2},
            },
        },
        "profiles": {
            "plan": {
                "name": "planner",
                "backend": "codex",
                "settings": plan_settings,
            },
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


def _app(
    store: _ManagedRunViewStore,
    runtimes_by_token: dict[str, dict[str, Any]],
) -> Any:
    app = create_app(
        secure_cookies=False,
        secret_key="test-secret",
        store=store,
    )
    state = app.state.podium
    state.user_for_session = AsyncMock(return_value=USER)
    state.runtime_for_bearer = AsyncMock(
        side_effect=lambda authorization: runtimes_by_token.get(authorization)
    )
    state.apply_runtime_report = AsyncMock(return_value={"status": "ok"})
    return app


def _runtime(index: int, *, project_slug: str) -> tuple[dict[str, Any], dict[str, Any]]:
    runtime_id = f"runtime-{index}"
    group_id = f"group-{index}"
    runtime = {
        "id": runtime_id,
        "user_id": USER["id"],
        "runtime_group_id": group_id,
        "enrollment_state": "enrolled",
        "name": f"Conductor {index}",
        "public_id": f"public-{index}",
    }
    binding = {
        "id": f"binding-{index}",
        "user_id": USER["id"],
        "conductor_id": runtime_id,
        "instance_id": f"instance-{index}",
        "linear_project_id": f"project-{project_slug.lower()}",
        "project_slug": project_slug,
        "project_name": project_slug.title(),
        "state": "ready",
        "error_code": "",
        "sanitized_reason": "",
    }
    return runtime, binding


def _client(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://podium.test",
    )


@pytest.mark.asyncio
async def test_runtime_config_push_rejects_stale_versions_and_sanitizes_managed_runs_view() -> None:
    store = _ManagedRunViewStore()
    runtime, binding = _runtime(1, project_slug="ALPHA")
    store.conductors.append(runtime)
    store.bindings.append(binding)
    store.online_runtime_ids.add(runtime["id"])
    app = _app(store, {"Bearer runtime-token": runtime})
    payload = runtime_config(2, secret="secret-token")

    async with _client(app) as client:
        accepted = await client.post(
            "/api/v1/runtime/config",
            headers={"Authorization": "Bearer runtime-token"},
            json=payload,
        )
        stale = await client.post(
            "/api/v1/runtime/config",
            headers={"Authorization": "Bearer runtime-token"},
            json=payload,
        )
        browser_view = await client.get("/api/v1/managed-runs")
        removed_managed_run_view = await client.get("/api/v1/managed_run")
        removed_view = await client.get("/api/v1/pipeline")
        runtime_view = await client.get(
            "/api/v1/runtime/config",
            headers={"Authorization": "Bearer runtime-token"},
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
    assert report["project"] == {
        "id": "project-alpha",
        "slug": "ALPHA",
        "name": "Alpha",
    }
    assert report["managed_runs"] == {}
    assert report["profiles"]["plan"]["settings"] == {"model": "gpt-5.3-codex"}
    assert "runtime_group_id" not in browser_view.json()
    assert "managed_runs" not in browser_view.json()
    assert "secret-token" not in str(browser_view.json())
    assert "codex_home_source" not in str(browser_view.json())
    assert "SYMPHONY_E2E_CODEX_HOME_SOURCE" not in str(browser_view.json())
    assert runtime_view.status_code == 200
    assert runtime_view.json()["config"]["version"] == 2
    assert runtime_view.json()["config"]["profiles"]["plan"]["settings"][
        "codex_home_source"
    ] == "$SYMPHONY_E2E_CODEX_HOME_SOURCE"


@pytest.mark.asyncio
async def test_managed_runs_aggregates_every_project_conductor() -> None:
    store = _ManagedRunViewStore()
    alpha, alpha_binding = _runtime(1, project_slug="ALPHA")
    beta, beta_binding = _runtime(2, project_slug="BETA")
    store.conductors.extend((alpha, beta))
    store.bindings.extend((alpha_binding, beta_binding))
    store.online_runtime_ids.update((alpha["id"], beta["id"]))
    runtimes_by_token = {
        "Bearer alpha-token": alpha,
        "Bearer beta-token": beta,
    }
    app = _app(store, runtimes_by_token)

    async with _client(app) as client:
        for token, runtime, version, run_id in (
            ("alpha-token", alpha, 2, "run-alpha"),
            ("beta-token", beta, 5, "run-beta"),
        ):
            headers = {"Authorization": f"Bearer {token}"}
            accepted = await client.post(
                "/api/v1/runtime/config",
                headers=headers,
                json=runtime_config(version),
            )
            reported = await client.post(
                "/api/v1/runtime/report",
                headers=headers,
                json={"managed_runs": {"runs": [{"run_id": run_id, "work_items": []}]}},
            )
            assert accepted.status_code == 200
            assert reported.status_code == 200
            assert store.views[runtime["runtime_group_id"]]["runs"][0]["run_id"] == run_id
        response = await client.get("/api/v1/managed-runs")

    assert response.status_code == 200
    reports = response.json()["conductors"]
    assert [row["project"]["slug"] for row in reports] == ["ALPHA", "BETA"]
    assert [row["policy_revision"] for row in reports] == [2, 5]
    assert [
        row["managed_runs"]["runs"][0]["run_id"] for row in reports
    ] == ["run-alpha", "run-beta"]
    assert {row["conductor"]["id"] for row in reports} == {"runtime-1", "runtime-2"}


@pytest.mark.asyncio
async def test_runtime_config_push_rejects_incomplete_runtime_profiles() -> None:
    store = _ManagedRunViewStore()
    runtime, _binding = _runtime(1, project_slug="ALPHA")
    app = _app(store, {"Bearer runtime-token": runtime})

    async with _client(app) as client:
        rejected = await client.post(
            "/api/v1/runtime/config",
            headers={"Authorization": "Bearer runtime-token"},
            json={
                "version": 3,
                "managed_run_policy": {
                    "policy_id": "policy-3",
                    "version": 3,
                    "effective_at": "2026-07-06T00:00:00Z",
                    "capacity": {
                        "global": 4,
                        "by_role": {"plan": 1, "work_item": 1, "verify": 1},
                    },
                },
                "profiles": {
                    "plan": {
                        "name": "planner",
                        "backend": "codex",
                        "settings": {"model": "gpt-5.3-codex"},
                    }
                },
            },
        )

    assert rejected.status_code == 400
    assert rejected.json()["error"]["code"] == "invalid_runtime_config"
    assert "runtime_profiles_missing:verify,work_item" in rejected.json()["error"][
        "details"
    ]
