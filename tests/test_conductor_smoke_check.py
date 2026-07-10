from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from conductor.conductor_api import ConductorApiServer
from conductor.conductor_linear_direct import ProjectLabelLinearProxy
from conductor.conductor_models import ConductorSettings
from conductor.conductor_service import ConductorService
from conductor.conductor_store import ConductorStore


def _runtime_config(version: int = 3) -> dict[str, Any]:
    return {
        "runtime_group_id": "group-1",
        "version": version,
        "managed_run_policy": {
            "policy_id": "smoke-policy",
            "version": version,
            "effective_at": "2026-07-10T00:00:00Z",
            "capacity": {"global": 3, "by_role": {"plan": 1, "work_item": 1, "verify": 1}},
        },
        "profiles": {
            role: {"name": role, "backend": "codex", "role": role, "settings": {"model": "gpt-5.3-codex"}}
            for role in ("plan", "work_item", "verify")
        },
    }


def _project_command(repository: Path) -> dict[str, Any]:
    return {
        "type": "project.configure",
        "binding_id": "binding-1",
        "config_version": 7,
        "linear_project_id": "project-alpha",
        "project_slug": "ALPHA",
        "project_name": "Alpha",
        "agent_app_user_id": "linear-app-user-1",
        "repository": {"mode": "local_path", "value": str(repository)},
    }


def _smoke_command(repository: Path, *, check_id: str = "smoke-check-1") -> dict[str, Any]:
    return {
        "type": "smoke.check",
        "smoke_check_id": check_id,
        "binding_id": "binding-1",
        "config_version": 7,
        "linear_project_id": "project-alpha",
        "project_slug": "ALPHA",
        "repository": {"mode": "local_path", "value": str(repository)},
        "expected_label": {
            "id": "managed-label-1",
            "name": "symphony:conductor/Beethoven-k7m3p2",
        },
        "runtime_config_version": 3,
    }


async def _configured_service(
    tmp_path: Path,
    *,
    apply_runtime_config: bool = True,
    label_present: bool = True,
) -> tuple[ConductorService, Path, list[dict[str, Any]]]:
    repository = tmp_path / "repo"
    repository.mkdir()
    (repository / "README.md").write_text("fixture\n", encoding="utf-8")
    data_root = tmp_path / "conductor"
    store = ConductorStore(data_root)
    store.save_settings(
        ConductorSettings(
            podium_url="https://podium.test",
            podium_runtime_id="runtime-1",
            podium_runtime_token="runtime-secret",
            podium_proxy_token="proxy-secret",
            podium_ws_url="wss://podium.test/api/v1/runtime/ws",
            runtime_group_id="group-1",
            managed_mode=True,
            conductor_id="runtime-1",
        )
    )
    service = ConductorService(store=store, data_root=data_root)
    applied = await service.handle_podium_ws_command(_project_command(repository))
    assert applied["status"] == "applied"
    if apply_runtime_config:
        assert service._apply_runtime_config_payload(_runtime_config()) is True
    requests: list[dict[str, Any]] = []

    async def linear_proxy(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://podium.test/api/v1/linear/graphql"
        assert request.headers["Authorization"] == "proxy-secret"
        payload = json.loads(request.content)
        requests.append(payload)
        query = str(payload.get("query") or "")
        if "ProjectLabelFindProject" in query:
            data = {"projects": {"nodes": [{"id": "project-alpha", "slugId": "ALPHA", "name": "Alpha"}]}}
        elif "query ProjectLabels" in query:
            labels = [{"id": "managed-label-1", "name": "symphony:conductor/Beethoven-k7m3p2"}] if label_present else []
            data = {"project": {"id": "project-alpha", "labels": {"nodes": labels}}}
        else:
            raise AssertionError(f"unexpected query: {query}")
        return httpx.Response(200, json={"data": data}, request=request)

    transport = httpx.MockTransport(linear_proxy)
    service.project_label_proxy_factory = lambda _instance: ProjectLabelLinearProxy(
        endpoint="https://podium.test/api/v1/linear/graphql",
        api_key="proxy-secret",
        transport=transport,
    )
    return service, repository, requests


async def _accepted(_payload: dict[str, Any]) -> dict[str, Any]:
    return {"status": "accepted", "status_code": 200}


@pytest.mark.asyncio
async def test_smoke_command_checks_real_local_state_proxy_and_label_then_posts_once(tmp_path: Path) -> None:
    service, repository, linear_requests = await _configured_service(tmp_path)
    posted: list[dict[str, Any]] = []

    async def post_result(payload: dict[str, Any]) -> dict[str, Any]:
        posted.append(payload)
        return await _accepted(payload)

    first = await service.handle_podium_ws_command(
        _smoke_command(repository),
        post_smoke_result=post_result,
    )
    replayed = await service.handle_podium_ws_command(
        _smoke_command(repository),
        post_smoke_result=post_result,
    )

    assert first["delivery_status"] == "delivered"
    assert first["result"]["status"] == "passed"
    assert {
        key: first["result"][key]
        for key in ("error_code", "sanitized_reason", "action_required", "next_action")
    } == {
        "error_code": "",
        "sanitized_reason": "",
        "action_required": "",
        "next_action": "",
    }
    assert first["result"]["retryable"] is False
    assert {check["name"] for check in first["result"]["checks"]} == {
        "binding_identity",
        "repository_readiness",
        "linear_proxy_access",
        "runtime_config_validity",
        "project_label_state",
    }
    assert all(check["passed"] for check in first["result"]["checks"])
    assert replayed["status"] == "already_reported"
    assert len(linear_requests) == 2
    assert len(posted) == 1
    persisted = service.smoke_check_store.get("smoke-check-1")
    assert persisted is not None
    assert persisted["delivery_status"] == "delivered"
    assert "runtime-secret" not in str(persisted)
    assert "proxy-secret" not in str(persisted)


@pytest.mark.asyncio
async def test_smoke_command_reports_runtime_config_and_label_failures_without_false_pass(tmp_path: Path) -> None:
    service, repository, _requests = await _configured_service(
        tmp_path,
        apply_runtime_config=False,
        label_present=False,
    )
    posted: list[dict[str, Any]] = []

    async def post_result(payload: dict[str, Any]) -> dict[str, Any]:
        posted.append(payload)
        return await _accepted(payload)

    outcome = await service.handle_podium_ws_command(
        _smoke_command(repository),
        post_smoke_result=post_result,
    )

    assert outcome["delivery_status"] == "delivered"
    result = outcome["result"]
    assert result["status"] == "failed"
    assert result["error_code"] == "runtime_config_not_applied"
    checks = {check["name"]: check["passed"] for check in result["checks"]}
    assert checks["binding_identity"] is True
    assert checks["repository_readiness"] is True
    assert checks["linear_proxy_access"] is True
    assert checks["runtime_config_validity"] is False
    assert checks["project_label_state"] is False
    assert posted == [result]


@pytest.mark.asyncio
async def test_smoke_command_rejects_binding_or_repository_identity_mismatch_before_proxy(tmp_path: Path) -> None:
    service, repository, linear_requests = await _configured_service(tmp_path)
    command = _smoke_command(repository)
    command["linear_project_id"] = "project-other"
    command["repository"] = {"mode": "local_path", "value": str(tmp_path / "other")}

    outcome = await service.handle_podium_ws_command(command, post_smoke_result=_accepted)

    assert outcome["result"]["status"] == "failed"
    assert outcome["result"]["error_code"] == "smoke_binding_mismatch"
    checks = {check["name"]: check["passed"] for check in outcome["result"]["checks"]}
    assert checks["binding_identity"] is False
    assert checks["repository_readiness"] is False
    assert checks["linear_proxy_access"] is False
    assert linear_requests == []


@pytest.mark.asyncio
async def test_failed_smoke_result_delivery_is_durable_visible_and_retried_after_restart(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level("INFO")
    service, repository, _requests = await _configured_service(tmp_path)

    async def unavailable(_payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "status": "retryable_error",
            "status_code": 503,
            "error_code": "podium_unavailable",
            "sanitized_reason": "Authorization: Bearer leaked-secret token=second-secret",
            "retryable": True,
            "action_required": "retry_smoke_result",
            "next_action": "retry_smoke_result",
        }

    failed = await service.handle_podium_ws_command(
        _smoke_command(repository),
        post_smoke_result=unavailable,
    )
    status, local_view = await ConductorApiServer(service)._route("GET", "/api/smoke-checks", b"")

    assert failed["delivery_status"] == "retryable"
    assert failed["delivery_attempts"] == 1
    assert failed["delivery_error_code"] == "podium_unavailable"
    assert "leaked-secret" not in str(failed)
    assert "second-secret" not in str(failed)
    assert status == 200
    assert local_view["smoke_checks"][0]["delivery_status"] == "retryable"
    assert "event=conductor_smoke_result_delivery_failed" in caplog.text
    assert "runtime_group_id=group-1" in caplog.text
    assert "runtime_id=runtime-1" in caplog.text
    assert "leaked-secret" not in caplog.text
    instance_log = Path(service.list_instances()[0].log_path).read_text(encoding="utf-8")
    assert "event=conductor_smoke_result_delivery_failed" in instance_log
    assert "leaked-secret" not in instance_log

    restarted_store = ConductorStore(tmp_path / "conductor")
    restarted = ConductorService(store=restarted_store, data_root=tmp_path / "conductor")
    retried = await restarted.retry_pending_smoke_results(_accepted, force=True)

    assert retried == {"delivered": 1, "failed": 0, "pending": 0}
    persisted = restarted.smoke_check_store.get("smoke-check-1")
    assert persisted is not None
    assert persisted["delivery_status"] == "delivered"
    assert persisted["delivery_attempts"] == 2


@pytest.mark.asyncio
async def test_same_smoke_id_with_changed_command_is_rejected_without_overwriting_evidence(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level("INFO")
    service, repository, _requests = await _configured_service(tmp_path)
    original = _smoke_command(repository)
    await service.handle_podium_ws_command(original, post_smoke_result=_accepted)
    changed = {**original, "expected_label": {"id": "other", "name": original["expected_label"]["name"]}}

    conflict = await service.handle_podium_ws_command(changed, post_smoke_result=_accepted)
    persisted = service.smoke_check_store.get("smoke-check-1")

    assert conflict == {"status": "rejected", "reason": "smoke_command_conflict"}
    assert persisted is not None
    assert persisted["command"]["expected_label"]["id"] == "managed-label-1"
    assert "event=conductor_smoke_command_rejected" in caplog.text
    assert "runtime_group_id=group-1" in caplog.text
    assert "runtime_id=runtime-1" in caplog.text
    instance_log = Path(service.list_instances()[0].log_path).read_text(encoding="utf-8")
    assert "error_code=smoke_command_conflict" in instance_log


@pytest.mark.asyncio
async def test_concurrent_smoke_command_replay_checks_linear_and_posts_only_once(tmp_path: Path) -> None:
    service, repository, linear_requests = await _configured_service(tmp_path)
    posted: list[dict[str, Any]] = []

    async def post_result(payload: dict[str, Any]) -> dict[str, Any]:
        posted.append(payload)
        await asyncio.sleep(0)
        return await _accepted(payload)

    outcomes = await asyncio.gather(
        service.handle_podium_ws_command(_smoke_command(repository), post_smoke_result=post_result),
        service.handle_podium_ws_command(_smoke_command(repository), post_smoke_result=post_result),
    )

    assert len(linear_requests) == 2
    assert len(posted) == 1
    assert {outcome["status"] for outcome in outcomes} == {"reported", "already_reported"}
    assert {outcome["delivery_status"] for outcome in outcomes} == {"delivered"}


@pytest.mark.asyncio
async def test_terminal_smoke_result_rejection_is_not_retried_by_command_replay(tmp_path: Path) -> None:
    service, repository, linear_requests = await _configured_service(tmp_path)
    posted: list[dict[str, Any]] = []

    async def reject(payload: dict[str, Any]) -> dict[str, Any]:
        posted.append(payload)
        return {
            "status": "rejected",
            "status_code": 409,
            "error_code": "smoke_result_conflict",
            "sanitized_reason": "Podium rejected conflicting evidence",
            "retryable": False,
            "action_required": "inspect_smoke_result",
            "next_action": "rerun_smoke_check",
        }

    first = await service.handle_podium_ws_command(_smoke_command(repository), post_smoke_result=reject)
    replayed = await service.handle_podium_ws_command(_smoke_command(repository), post_smoke_result=reject)

    assert first["delivery_status"] == "rejected"
    assert replayed["status"] == "delivery_rejected"
    assert replayed["delivery_status"] == "rejected"
    assert len(posted) == 1
    assert len(linear_requests) == 2


@pytest.mark.asyncio
async def test_pending_flush_rechecks_terminal_state_after_stale_snapshot(tmp_path: Path) -> None:
    service, repository, _linear_requests = await _configured_service(tmp_path)
    pending = await service.handle_podium_ws_command(_smoke_command(repository))
    stale_row = service.smoke_check_store.get("smoke-check-1")
    assert pending["delivery_status"] == "pending"
    assert stale_row is not None
    posted = 0

    async def reject(_payload: dict[str, Any]) -> dict[str, Any]:
        nonlocal posted
        posted += 1
        return {
            "status": "rejected",
            "error_code": "smoke_result_conflict",
            "sanitized_reason": "Podium rejected conflicting evidence",
            "retryable": False,
            "action_required": "inspect_smoke_result",
            "next_action": "rerun_smoke_check",
        }

    rejected = await service.handle_podium_ws_command(_smoke_command(repository), post_smoke_result=reject)
    original_list_pending = service.smoke_check_store.list_pending
    list_calls = 0

    def stale_then_current(*, force: bool = False) -> list[dict[str, Any]]:
        nonlocal list_calls
        list_calls += 1
        return [stale_row] if list_calls == 1 else original_list_pending(force=force)

    service.smoke_check_store.list_pending = stale_then_current
    retried = await service.retry_pending_smoke_results(reject, force=True)

    assert rejected["delivery_status"] == "rejected"
    assert retried == {"delivered": 0, "failed": 0, "pending": 0}
    assert posted == 1
