from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from podium.app import create_app
from podium.podium_shared import utc_now_iso


USER_ID = "user-1"
USER = {"id": USER_ID, "email": "smoke-owner@example.com"}
RUNTIME_CHECKS = [
    {"name": "binding_identity", "passed": True},
    {"name": "repository_readiness", "passed": True},
    {"name": "linear_proxy_access", "passed": True},
    {"name": "runtime_config_validity", "passed": True},
    {"name": "project_label_state", "passed": True},
]


def _runtime_config(version: int, runtime_group_id: str) -> dict[str, Any]:
    return {
        "runtime_group_id": runtime_group_id,
        "version": version,
        "managed_run_policy": {
            "policy_id": f"policy-{version}",
            "version": version,
            "effective_at": "2026-07-10T00:00:00Z",
            "capacity": {
                "global": 3,
                "by_role": {"plan": 1, "work_item": 1, "verify": 1},
            },
        },
        "profiles": {
            role: {
                "name": role,
                "backend": "codex",
                "role": role,
                "settings": {"model": "gpt-5.3-codex"},
            }
            for role in ("plan", "work_item", "verify")
        },
    }


class _SmokeStore:
    def __init__(self) -> None:
        self.installation: dict[str, Any] | None = None
        self.selected_projects: list[dict[str, Any]] = []
        self.bindings: list[dict[str, Any]] = []
        self.runtimes: dict[str, dict[str, Any]] = {}
        self.runtime_groups: dict[str, dict[str, Any]] = {}
        self.runtime_configs: dict[str, dict[str, Any]] = {}
        self.presence: dict[str, dict[str, Any]] = {}
        self.commands: dict[str, list[dict[str, Any]]] = {}
        self._command_keys: set[tuple[str, str]] = set()
        self.smoke_result: dict[str, Any] | None = None
        self.onboarding: dict[str, dict[str, Any]] = {}
        self._smoke_lock = asyncio.Lock()

    async def list_project_bindings_for_user(self, user_id: str) -> list[dict[str, Any]]:
        return [dict(row) for row in self.bindings if row.get("user_id") == user_id]

    async def get_runtime(self, runtime_id: str) -> dict[str, Any] | None:
        return self.runtimes.get(runtime_id)

    async def get_runtime_group(self, group_id: str) -> dict[str, Any] | None:
        return self.runtime_groups.get(group_id)

    async def get_runtime_config(self, group_id: str) -> dict[str, Any] | None:
        return self.runtime_configs.get(group_id)

    async def save_runtime_config(self, group_id: str, config: dict[str, Any]) -> None:
        self.runtime_configs[group_id] = dict(config)

    async def get_presence(self, runtime_id: str) -> dict[str, Any] | None:
        return self.presence.get(runtime_id)

    async def list_conductors_for_user(self, user_id: str) -> list[dict[str, Any]]:
        return [
            dict(row)
            for row in self.runtimes.values()
            if row.get("user_id") == user_id
        ]

    async def append_runtime_command_once(
        self,
        runtime_id: str,
        dedupe_key: str,
        command: dict[str, Any],
    ) -> dict[str, Any]:
        key = (runtime_id, dedupe_key)
        if key not in self._command_keys:
            self._command_keys.add(key)
            self.commands.setdefault(runtime_id, []).append(dict(command))
        return dict(command)

    async def get_smoke_result(self, _user_id: str) -> dict[str, Any] | None:
        return dict(self.smoke_result) if self.smoke_result is not None else None

    async def save_smoke_result(self, _user_id: str, result: dict[str, Any]) -> None:
        self.smoke_result = dict(result)

    async def compare_and_save_smoke_result(
        self,
        _user_id: str,
        expected_revision: int,
        result: dict[str, Any],
    ) -> bool:
        async with self._smoke_lock:
            current_revision = int((self.smoke_result or {}).get("revision") or 0)
            if current_revision != expected_revision:
                return False
            self.smoke_result = dict(result)
            return True

    async def get_onboarding_state(self, user_id: str) -> dict[str, Any] | None:
        row = self.onboarding.get(user_id)
        return dict(row) if row is not None else None

    async def save_onboarding_state(
        self,
        user_id: str,
        completed_steps: list[str],
        metadata: dict[str, Any],
    ) -> None:
        self.onboarding[user_id] = {
            "completed_steps": list(completed_steps),
            "metadata": dict(metadata),
        }


def _smoke_app(
    *,
    project_ids: tuple[str, ...] = ("project-alpha",),
    with_installation: bool = True,
) -> tuple[Any, _SmokeStore, list[dict[str, Any]]]:
    store = _SmokeStore()
    projects = [
        {
            "id": project_id,
            "name": project_id.removeprefix("project-").title(),
            "slug_id": project_id.removeprefix("project-").upper(),
        }
        for project_id in project_ids
    ]
    if with_installation:
        store.installation = {
            "id": "installation-1",
            "user_id": USER_ID,
            "active": True,
            "state": "ready",
            "actor": "app",
            "scope": ["read", "write", "app:assignable"],
            "expires_at": "2099-01-01T00:00:00Z",
            "linear_organization_id": "org-1",
            "app_user_id": "agent-alpha",
            "projects": projects,
            "reconciliation_state": "healthy",
            "last_reconciliation_at": utc_now_iso(),
        }
        store.selected_projects = [
            {
                "linear_project_id": project["id"],
                "project_slug": project["slug_id"],
                "access_state": "ready",
            }
            for project in projects
        ]

    enrolled_rows: list[dict[str, Any]] = []
    for index, project in enumerate(projects):
        runtime_id = f"runtime-{index}"
        group_id = f"group-{index}"
        binding_id = f"binding-{index}"
        runtime_token = f"runtime-token-{index}"
        store.runtimes[runtime_id] = {
            "id": runtime_id,
            "user_id": USER_ID,
            "runtime_group_id": group_id,
            "enrollment_state": "enrolled",
        }
        store.runtime_groups[group_id] = {
            "id": group_id,
            "project_binding_id": binding_id,
            "linear_workspace_id": USER_ID,
            "project_slug": project["slug_id"],
            "linear_agent_app_user_id": "agent-alpha",
        }
        store.bindings.append(
            {
                "id": binding_id,
                "conductor_id": runtime_id,
                "user_id": USER_ID,
                "instance_id": f"instance-{index}",
                "linear_project_id": project["id"],
                "project_slug": project["slug_id"],
                "agent_app_user_id": "agent-alpha",
                "installation_id": "installation-1",
                "state": "ready",
                "active": True,
                "config_version": 1,
                "acknowledged_config_version": 1,
                "repo_source": {"type": "local_path", "value": f"/repo/{index}"},
                "label_id": f"label-{index}",
                "label_name": f"symphony:conductor/Test-{index}",
            }
        )
        store.runtime_configs[group_id] = _runtime_config(index + 1, group_id)
        store.presence[runtime_id] = {"last_seen_at": utc_now_iso()}
        enrolled_rows.append(
            {
                "runtime_id": runtime_id,
                "runtime_group_id": group_id,
                "runtime_token": runtime_token,
            }
        )

    app = create_app(
        secure_cookies=False,
        secret_key="test-secret",
        store=store,
    )
    state = app.state.podium
    state.user_for_session = AsyncMock(return_value=USER)
    state.get_active_linear_installation = AsyncMock(
        side_effect=lambda _user_id: store.installation
    )
    state.list_selected_linear_projects = AsyncMock(
        side_effect=lambda _user_id: list(store.selected_projects)
    )
    runtimes_by_token = {
        f"Bearer {row['runtime_token']}": store.runtimes[str(row["runtime_id"])]
        for row in enrolled_rows
    }
    state.runtime_for_bearer = AsyncMock(
        side_effect=lambda authorization: runtimes_by_token.get(authorization)
    )
    return app, store, enrolled_rows


def _client(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://podium.test",
    )


def _runtime_result(started: dict[str, Any], *, passed: bool = True) -> dict[str, Any]:
    binding = started["conductors"][0]
    checks = [dict(check) for check in RUNTIME_CHECKS]
    if not passed:
        checks[-1]["passed"] = False
    return {
        "smoke_check_id": started["smoke_check_id"],
        "binding_id": binding["binding_id"],
        "status": "passed" if passed else "failed",
        "checks": checks,
        "error_code": "" if passed else "project_label_missing",
        "sanitized_reason": "" if passed else "Expected managed project label is missing",
        "retryable": not passed,
        "action_required": "" if passed else "restore_project_label",
        "next_action": "" if passed else "rerun_smoke_check",
    }


@pytest.mark.asyncio
async def test_smoke_check_fails_closed_without_installation_and_does_not_complete_onboarding() -> None:
    app, _store, _enrolled = _smoke_app(with_installation=False)
    async with _client(app) as client:
        response = await client.post("/api/v1/onboarding/smoke-check")
        progress = await client.get("/api/v1/onboarding/status")

    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "failed"
    assert result["error_code"] == "smoke_prerequisites_failed"
    assert any(
        check["name"] == "callback_acceptance" and check["passed"] is False
        for check in result["checks"]
    )
    assert "Authorize a Linear application" in result["recommendations"]
    assert "smoke_check" not in progress.json()["completed_steps"]


@pytest.mark.asyncio
async def test_smoke_check_starts_once_and_queues_one_scoped_command_per_conductor() -> None:
    app, store, enrolled_rows = _smoke_app(
        project_ids=("project-alpha", "project-beta")
    )
    async with _client(app) as client:
        first = await client.post("/api/v1/onboarding/smoke-check")
        repeated = await client.post("/api/v1/onboarding/smoke-check")

    assert first.status_code == 202
    assert repeated.status_code == 202
    started = first.json()
    assert repeated.json()["smoke_check_id"] == started["smoke_check_id"]
    assert started["status"] == "running"
    assert len(started["conductors"]) == 2
    assert {row["status"] for row in started["conductors"]} == {"running"}
    for enrolled in enrolled_rows:
        smoke_commands = [
            command
            for command in store.commands[enrolled["runtime_id"]]
            if command.get("type") == "smoke.check"
        ]
        assert len(smoke_commands) == 1
        command = smoke_commands[0]
        conductor = next(
            row
            for row in started["conductors"]
            if row["runtime_id"] == enrolled["runtime_id"]
        )
        assert command["smoke_check_id"] == started["smoke_check_id"]
        assert command["binding_id"] == conductor["binding_id"]
        assert command["linear_project_id"] == conductor["linear_project_id"]
        assert command["expected_label"]["id"]
        assert command["expected_label"]["name"].startswith("symphony:conductor/")
        assert command["runtime_config_version"] > 0


@pytest.mark.asyncio
async def test_smoke_results_aggregate_all_conductors_before_completing_onboarding() -> None:
    app, _store, enrolled_rows = _smoke_app(
        project_ids=("project-alpha", "project-beta")
    )
    async with _client(app) as client:
        started = (await client.post("/api/v1/onboarding/smoke-check")).json()
        by_runtime = {row["runtime_id"]: row for row in started["conductors"]}
        first_payload = _runtime_result(
            {**started, "conductors": [by_runtime[enrolled_rows[0]["runtime_id"]]]}
        )
        first = await client.post(
            "/api/v1/runtime/smoke-check/result",
            headers={"Authorization": f"Bearer {enrolled_rows[0]['runtime_token']}"},
            json=first_payload,
        )
        second_payload = _runtime_result(
            {**started, "conductors": [by_runtime[enrolled_rows[1]["runtime_id"]]]}
        )
        second = await client.post(
            "/api/v1/runtime/smoke-check/result",
            headers={"Authorization": f"Bearer {enrolled_rows[1]['runtime_token']}"},
            json=second_payload,
        )
        stored = await client.get("/api/v1/onboarding/smoke-check/result")
        progress = await client.get("/api/v1/onboarding/status")

    assert first.status_code == 202
    assert first.json()["status"] == "running"
    assert second.status_code == 200
    assert second.json()["status"] == "passed"
    assert stored.json() == second.json()
    assert "smoke_check" in progress.json()["completed_steps"]


@pytest.mark.asyncio
async def test_smoke_result_rejects_wrong_runtime_invalid_shape_and_conflicting_replay() -> None:
    app, _store, enrolled_rows = _smoke_app(
        project_ids=("project-alpha", "project-beta")
    )
    async with _client(app) as client:
        started = (await client.post("/api/v1/onboarding/smoke-check")).json()
        expected = started["conductors"][0]
        payload = _runtime_result({**started, "conductors": [expected]})
        owner = next(
            row for row in enrolled_rows if row["runtime_id"] == expected["runtime_id"]
        )
        other = next(
            row for row in enrolled_rows if row["runtime_id"] != expected["runtime_id"]
        )
        unauthorized = await client.post(
            "/api/v1/runtime/smoke-check/result", json=payload
        )
        wrong_runtime = await client.post(
            "/api/v1/runtime/smoke-check/result",
            headers={"Authorization": f"Bearer {other['runtime_token']}"},
            json=payload,
        )
        malformed = await client.post(
            "/api/v1/runtime/smoke-check/result",
            headers={"Authorization": f"Bearer {owner['runtime_token']}"},
            json={**payload, "checks": payload["checks"][:-1]},
        )
        accepted = await client.post(
            "/api/v1/runtime/smoke-check/result",
            headers={"Authorization": f"Bearer {owner['runtime_token']}"},
            json=payload,
        )
        repeated = await client.post(
            "/api/v1/runtime/smoke-check/result",
            headers={"Authorization": f"Bearer {owner['runtime_token']}"},
            json=payload,
        )
        conflict = await client.post(
            "/api/v1/runtime/smoke-check/result",
            headers={"Authorization": f"Bearer {owner['runtime_token']}"},
            json=_runtime_result({**started, "conductors": [expected]}, passed=False),
        )

    assert unauthorized.status_code == 401
    assert wrong_runtime.status_code == 409
    assert wrong_runtime.json()["error"]["code"] == "smoke_binding_mismatch"
    assert malformed.status_code == 400
    assert malformed.json()["error"]["code"] == "invalid_smoke_result"
    assert accepted.status_code == 202
    assert repeated.status_code == 202
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "smoke_result_conflict"


@pytest.mark.asyncio
async def test_failed_smoke_result_is_sanitized_durable_logged_and_not_completed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level("INFO")
    app, _store, enrolled_rows = _smoke_app()
    async with _client(app) as client:
        started = (await client.post("/api/v1/onboarding/smoke-check")).json()
        payload = _runtime_result(started, passed=False)
        payload["sanitized_reason"] = (
            "label missing Authorization: Bearer super-secret token=second-secret"
        )
        failed = await client.post(
            "/api/v1/runtime/smoke-check/result",
            headers={"Authorization": f"Bearer {enrolled_rows[0]['runtime_token']}"},
            json=payload,
        )
        stored = await client.get("/api/v1/onboarding/smoke-check/result")
        progress = await client.get("/api/v1/onboarding/status")

    assert failed.status_code == 200
    assert failed.json()["status"] == "failed"
    assert failed.json()["error_code"] == "smoke_check_failed"
    assert failed.json()["conductors"][0]["error_code"] == "project_label_missing"
    assert "super-secret" not in failed.text
    assert "second-secret" not in failed.text
    assert "[REDACTED]" in failed.text
    assert stored.json() == failed.json()
    assert "smoke_check" not in progress.json()["completed_steps"]
    assert "event=podium_smoke_check_failed" in caplog.text
    assert started["smoke_check_id"] in caplog.text
    assert "super-secret" not in caplog.text
    assert "second-secret" not in caplog.text


@pytest.mark.asyncio
async def test_stale_smoke_result_cannot_mutate_a_new_check() -> None:
    app, _store, enrolled_rows = _smoke_app()
    async with _client(app) as client:
        first = (await client.post("/api/v1/onboarding/smoke-check")).json()
        passed = await client.post(
            "/api/v1/runtime/smoke-check/result",
            headers={"Authorization": f"Bearer {enrolled_rows[0]['runtime_token']}"},
            json=_runtime_result(first),
        )
        assert passed.json()["status"] == "passed"
        second = (await client.post("/api/v1/onboarding/smoke-check")).json()
        stale = await client.post(
            "/api/v1/runtime/smoke-check/result",
            headers={"Authorization": f"Bearer {enrolled_rows[0]['runtime_token']}"},
            json=_runtime_result(first),
        )
        stored = await client.get("/api/v1/onboarding/smoke-check/result")

    assert second["smoke_check_id"] != first["smoke_check_id"]
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "stale_smoke_check"
    assert stored.json()["smoke_check_id"] == second["smoke_check_id"]
    assert stored.json()["status"] == "running"


@pytest.mark.asyncio
async def test_failed_preflight_never_exposes_internal_context_fields_or_queues_commands() -> None:
    app, store, enrolled_rows = _smoke_app(
        project_ids=("project-alpha", "project-beta")
    )
    for enrolled in enrolled_rows:
        store.runtime_configs[enrolled["runtime_group_id"]] = {}

    async with _client(app) as client:
        failed = await client.post("/api/v1/onboarding/smoke-check")

    assert failed.status_code == 200
    result = failed.json()
    assert result["status"] == "failed"
    assert any(
        check["name"] == "runtime_config_validity" and not check["passed"]
        for check in result["checks"]
    )
    assert all(not key.startswith("_") for row in result["conductors"] for key in row)
    assert store.commands == {}


@pytest.mark.asyncio
async def test_running_smoke_check_times_out_durably_and_clears_completion(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level("INFO")
    app, store, _enrolled_rows = _smoke_app()
    async with _client(app) as client:
        started = (await client.post("/api/v1/onboarding/smoke-check")).json()
        started["expires_at"] = (
            datetime.now(timezone.utc) - timedelta(seconds=1)
        ).isoformat().replace("+00:00", "Z")
        await store.save_smoke_result(USER_ID, started)
        expired = await client.get("/api/v1/onboarding/smoke-check/result")
        progress = await client.get("/api/v1/onboarding/status")

    assert expired.status_code == 200
    result = expired.json()
    assert result["status"] == "failed"
    assert result["error_code"] == "smoke_check_timeout"
    assert result["conductors"][0]["error_code"] == "smoke_result_timeout"
    assert result["conductors"][0]["status"] == "failed"
    assert "smoke_check" not in progress.json()["completed_steps"]
    assert "event=podium_smoke_check_timeout" in caplog.text
    assert started["smoke_check_id"] in caplog.text


@pytest.mark.asyncio
async def test_concurrent_start_and_runtime_results_are_compare_and_swap_safe() -> None:
    app, store, enrolled_rows = _smoke_app(
        project_ids=("project-alpha", "project-beta")
    )
    async with _client(app) as client:
        starts = await asyncio.gather(
            client.post("/api/v1/onboarding/smoke-check"),
            client.post("/api/v1/onboarding/smoke-check"),
        )
        started = starts[0].json()
        assert starts[1].json()["smoke_check_id"] == started["smoke_check_id"]
        by_runtime = {row["runtime_id"]: row for row in started["conductors"]}
        submissions = [
            client.post(
                "/api/v1/runtime/smoke-check/result",
                headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
                json=_runtime_result(
                    {
                        **started,
                        "conductors": [by_runtime[enrolled["runtime_id"]]],
                    }
                ),
            )
            for enrolled in enrolled_rows
        ]
        responses = await asyncio.gather(*submissions)
        stored = await client.get("/api/v1/onboarding/smoke-check/result")

    assert all(response.status_code in {200, 202} for response in responses)
    assert stored.json()["status"] == "passed"
    assert {row["status"] for row in stored.json()["conductors"]} == {"passed"}
    for enrolled in enrolled_rows:
        smoke_commands = [
            command
            for command in store.commands[enrolled["runtime_id"]]
            if command.get("type") == "smoke.check"
        ]
        assert len(smoke_commands) == 1


@pytest.mark.asyncio
async def test_runtime_smoke_result_rejects_contradictory_error_fields_and_non_boolean_retryability() -> None:
    app, _store, enrolled_rows = _smoke_app()
    async with _client(app) as client:
        started = (await client.post("/api/v1/onboarding/smoke-check")).json()
        payload = _runtime_result(started)
        headers = {"Authorization": f"Bearer {enrolled_rows[0]['runtime_token']}"}
        contradictory = await client.post(
            "/api/v1/runtime/smoke-check/result",
            headers=headers,
            json={**payload, "error_code": "unexpected_error"},
        )
        wrong_type = await client.post(
            "/api/v1/runtime/smoke-check/result",
            headers=headers,
            json={**payload, "retryable": "false"},
        )

    assert contradictory.status_code == 400
    assert contradictory.json()["error"]["code"] == "invalid_smoke_result"
    assert wrong_type.status_code == 400
    assert wrong_type.json()["error"]["code"] == "invalid_smoke_result"


@pytest.mark.asyncio
async def test_smoke_preflight_rejects_expired_or_under_scoped_installation() -> None:
    app, store, enrolled_rows = _smoke_app()
    assert store.installation is not None
    store.installation.update(
        {
            "expires_at": (
                datetime.now(timezone.utc) - timedelta(minutes=1)
            ).isoformat().replace("+00:00", "Z"),
            "scope": ["read"],
        }
    )
    async with _client(app) as client:
        failed = await client.post("/api/v1/onboarding/smoke-check")

    assert failed.status_code == 200
    result = failed.json()
    assert result["status"] == "failed"
    assert any(
        check["name"] == "installation_identity" and not check["passed"]
        for check in result["checks"]
    )
    assert store.commands.get(enrolled_rows[0]["runtime_id"], []) == []


@pytest.mark.asyncio
async def test_reconciliation_health_is_required_for_smoke_preflight() -> None:
    app, store, _enrolled_rows = _smoke_app()
    assert store.installation is not None
    store.installation.update(
        {"reconciliation_state": "degraded", "last_reconciliation_at": None}
    )
    async with _client(app) as client:
        started = await client.post("/api/v1/onboarding/smoke-check")

    assert started.status_code == 200
    assert started.json()["status"] == "failed"
    intake_health = next(
        check for check in started.json()["checks"] if check["name"] == "intake_health"
    )
    assert intake_health["passed"] is False
