from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import pytest

from podium.podium_shared import utc_now_iso
from test_podium_conductor_channels_support import (
    activate_linear_installation,
    bind_and_ack_conductor,
    enroll_conductor,
    make_app,
    register,
)


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
            "capacity": {"global": 3, "by_role": {"plan": 1, "work_item": 1, "verify": 1}},
        },
        "profiles": {
            role: {"name": role, "backend": "codex", "role": role, "settings": {"model": "gpt-5.3-codex"}}
            for role in ("plan", "work_item", "verify")
        },
    }


async def _ready_workspace(
    client: httpx.AsyncClient,
    app: Any,
    *,
    project_ids: tuple[str, ...] = ("project-alpha",),
) -> tuple[str, list[dict[str, Any]]]:
    user_id = await register(client, "smoke-owner@example.com")
    projects = [
        {
            "id": project_id,
            "name": project_id.removeprefix("project-").title(),
            "slug_id": project_id.removeprefix("project-").upper(),
        }
        for project_id in project_ids
    ]
    await activate_linear_installation(app, user_id, projects=projects)
    await app.state.podium.select_linear_projects(user_id, list(project_ids))
    enrolled_rows: list[dict[str, Any]] = []
    for index, project_id in enumerate(project_ids):
        enrolled = await enroll_conductor(client)
        report, _binding = await bind_and_ack_conductor(
            app,
            client,
            user_id,
            enrolled,
            project_id=project_id,
            project_slug=projects[index]["slug_id"],
            instance_id=f"instance-{index}",
            repository=f"/repo/{index}",
        )
        assert report.status_code == 200, report.text
        await app.state.podium.store.save_runtime_config(
            enrolled["runtime_group_id"],
            _runtime_config(index + 1, enrolled["runtime_group_id"]),
        )
        enrolled_rows.append(enrolled)
    installation = await app.state.podium.get_active_linear_installation(user_id)
    assert installation is not None
    await app.state.podium.update_linear_installation_health(
        installation,
        reconciliation_state="healthy",
        last_reconciliation_at=utc_now_iso(),
    )
    return user_id, enrolled_rows


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
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await register(client, "smoke-missing@example.com")

        response = await client.post("/api/v1/onboarding/smoke-check")
        progress = await client.get("/api/v1/onboarding/status")

    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "failed"
    assert result["error_code"] == "smoke_prerequisites_failed"
    assert any(check["name"] == "callback_acceptance" and check["passed"] is False for check in result["checks"])
    assert "Authorize a Linear application" in result["recommendations"]
    assert "smoke_check" not in progress.json()["completed_steps"]


@pytest.mark.asyncio
async def test_smoke_check_starts_once_and_queues_one_scoped_command_per_conductor() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        _user_id, enrolled_rows = await _ready_workspace(client, app, project_ids=("project-alpha", "project-beta"))

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
        commands = app.state.podium.store._load_map("runtime_commands.json")[enrolled["runtime_id"]]
        smoke_commands = [row["command"] for row in commands if row["command"].get("type") == "smoke.check"]
        assert len(smoke_commands) == 1
        command = smoke_commands[0]
        conductor = next(row for row in started["conductors"] if row["runtime_id"] == enrolled["runtime_id"])
        assert command["smoke_check_id"] == started["smoke_check_id"]
        assert command["binding_id"] == conductor["binding_id"]
        assert command["linear_project_id"] == conductor["linear_project_id"]
        assert command["expected_label"]["id"]
        assert command["expected_label"]["name"].startswith("symphony:conductor/")
        assert command["runtime_config_version"] > 0


@pytest.mark.asyncio
async def test_smoke_results_aggregate_all_conductors_before_completing_onboarding() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        _user_id, enrolled_rows = await _ready_workspace(client, app, project_ids=("project-alpha", "project-beta"))
        started = (await client.post("/api/v1/onboarding/smoke-check")).json()
        by_runtime = {row["runtime_id"]: row for row in started["conductors"]}

        first_payload = _runtime_result({**started, "conductors": [by_runtime[enrolled_rows[0]["runtime_id"]]]})
        first = await client.post(
            "/api/v1/runtime/smoke-check/result",
            headers={"Authorization": f"Bearer {enrolled_rows[0]['runtime_token']}"},
            json=first_payload,
        )
        second_payload = _runtime_result({**started, "conductors": [by_runtime[enrolled_rows[1]["runtime_id"]]]})
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
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        _user_id, enrolled_rows = await _ready_workspace(client, app, project_ids=("project-alpha", "project-beta"))
        started = (await client.post("/api/v1/onboarding/smoke-check")).json()
        expected = started["conductors"][0]
        payload = _runtime_result({**started, "conductors": [expected]})
        owner = next(row for row in enrolled_rows if row["runtime_id"] == expected["runtime_id"])
        other = next(row for row in enrolled_rows if row["runtime_id"] != expected["runtime_id"])

        unauthorized = await client.post("/api/v1/runtime/smoke-check/result", json=payload)
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
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        _user_id, enrolled_rows = await _ready_workspace(client, app)
        started = (await client.post("/api/v1/onboarding/smoke-check")).json()
        payload = _runtime_result(started, passed=False)
        payload["sanitized_reason"] = "label missing Authorization: Bearer super-secret token=second-secret"

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
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        _user_id, enrolled_rows = await _ready_workspace(client, app)
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
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        _user_id, enrolled_rows = await _ready_workspace(client, app, project_ids=("project-alpha", "project-beta"))
        for enrolled in enrolled_rows:
            await app.state.podium.store.save_runtime_config(enrolled["runtime_group_id"], {})

        failed = await client.post("/api/v1/onboarding/smoke-check")

    assert failed.status_code == 200
    result = failed.json()
    assert result["status"] == "failed"
    assert any(check["name"] == "runtime_config_validity" and not check["passed"] for check in result["checks"])
    assert all(not key.startswith("_") for row in result["conductors"] for key in row)
    for enrolled in enrolled_rows:
        commands = app.state.podium.store._load_map("runtime_commands.json")[enrolled["runtime_id"]]
        assert all(row["command"].get("type") != "smoke.check" for row in commands)


@pytest.mark.asyncio
async def test_running_smoke_check_times_out_durably_and_clears_completion(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level("INFO")
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id, _enrolled_rows = await _ready_workspace(client, app)
        started = (await client.post("/api/v1/onboarding/smoke-check")).json()
        started["expires_at"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat().replace("+00:00", "Z")
        await app.state.podium.store.save_smoke_result(user_id, started)

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
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        _user_id, enrolled_rows = await _ready_workspace(client, app, project_ids=("project-alpha", "project-beta"))

        starts = await asyncio.gather(
            client.post("/api/v1/onboarding/smoke-check"),
            client.post("/api/v1/onboarding/smoke-check"),
        )
        started = starts[0].json()
        assert starts[1].json()["smoke_check_id"] == started["smoke_check_id"]
        by_runtime = {row["runtime_id"]: row for row in started["conductors"]}
        submissions = []
        for enrolled in enrolled_rows:
            scoped = {**started, "conductors": [by_runtime[enrolled["runtime_id"]]]}
            submissions.append(
                client.post(
                    "/api/v1/runtime/smoke-check/result",
                    headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
                    json=_runtime_result(scoped),
                )
            )
        responses = await asyncio.gather(*submissions)
        stored = await client.get("/api/v1/onboarding/smoke-check/result")

    assert all(response.status_code in {200, 202} for response in responses)
    assert stored.json()["status"] == "passed"
    assert {row["status"] for row in stored.json()["conductors"]} == {"passed"}
    for enrolled in enrolled_rows:
        commands = app.state.podium.store._load_map("runtime_commands.json")[enrolled["runtime_id"]]
        smoke_commands = [row for row in commands if row["command"].get("type") == "smoke.check"]
        assert len(smoke_commands) == 1


@pytest.mark.asyncio
async def test_runtime_smoke_result_rejects_contradictory_error_fields_and_non_boolean_retryability() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        _user_id, enrolled_rows = await _ready_workspace(client, app)
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
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id, enrolled_rows = await _ready_workspace(client, app)
        installation = await app.state.podium.get_active_linear_installation(user_id)
        assert installation is not None
        await app.state.podium.update_linear_installation_health(
            installation,
            expires_at=(datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat().replace("+00:00", "Z"),
            scope=["read"],
        )

        failed = await client.post("/api/v1/onboarding/smoke-check")

    assert failed.status_code == 200
    result = failed.json()
    assert result["status"] == "failed"
    assert any(check["name"] == "installation_identity" and not check["passed"] for check in result["checks"])
    commands = app.state.podium.store._load_map("runtime_commands.json")[enrolled_rows[0]["runtime_id"]]
    assert all(row["command"].get("type") != "smoke.check" for row in commands)


@pytest.mark.asyncio
async def test_reconciliation_health_is_required_for_smoke_preflight() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id, _enrolled_rows = await _ready_workspace(client, app)
        installation = await app.state.podium.get_active_linear_installation(user_id)
        assert installation is not None
        await app.state.podium.update_linear_installation_health(
            installation,
            reconciliation_state="degraded",
            last_reconciliation_at=None,
        )

        started = await client.post("/api/v1/onboarding/smoke-check")

    assert started.status_code == 200
    assert started.json()["status"] == "failed"
    assert next(check for check in started.json()["checks"] if check["name"] == "intake_health")["passed"] is False
