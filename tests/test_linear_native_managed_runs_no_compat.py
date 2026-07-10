from __future__ import annotations

import pytest

from conductor.conductor_api import ConductorApiServer
from conductor.conductor_service_runtime_view import managed_run_runtime_snapshot
from conductor.conductor_service import ConductorService
from conductor.conductor_store import ConductorStore


@pytest.mark.asyncio
async def test_conductor_exposes_managed_run_api_without_pipeline_compatibility(tmp_path) -> None:
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
    )
    server = ConductorApiServer(service)

    managed_status, managed_body = await server._route("GET", "/api/managed-runs", b"")
    managed_run_status, managed_run_body = await server._route("GET", "/api/managed_run", b"")
    pipeline_status, pipeline_body = await server._route("GET", "/api/pipeline", b"")

    assert not hasattr(service, "pipeline_store")
    assert not hasattr(service, "pipeline_coordinator")
    assert managed_status == 200
    assert managed_body == {
        "managed_runs": {
            "attempts": [],
            "runs": [],
            "runtime_waits": [],
            "attempt_integrity": {"passed": True, "errors": []},
        }
    }
    assert managed_run_status == 404
    assert managed_run_body["error"]["code"] == "not_found"
    assert pipeline_status == 404
    assert pipeline_body["error"]["code"] == "not_found"


@pytest.mark.asyncio
async def test_background_coordination_reports_managed_run_metrics_only(tmp_path) -> None:
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
    )

    result = await service.coordinate_background_once()

    assert "linear_managed_run_projections" in result
    assert "managed_run_turns_started" in result
    assert "pipeline_attempts_started" not in result
    assert "linear_pipeline_projections" not in result


def test_runtime_snapshot_uses_managed_run_source_name(tmp_path) -> None:
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
    )

    snapshot = managed_run_runtime_snapshot(service.managed_run_store)

    assert snapshot["source"] == "managed_run"


def test_runtime_snapshot_exposes_managed_run_runtime_waits(tmp_path) -> None:
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
    )
    run = service.managed_run_store.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    service.managed_run_store.merge_run_payload(
        run.run_id,
        {
            "runtime_waits": [
                {
                    "wait_id": "runtime-wait-1",
                    "work_item_id": "wi-1",
                    "wait_kind": "approval_requested",
                    "status": "waiting",
                }
            ]
        },
    )

    snapshot = managed_run_runtime_snapshot(service.managed_run_store)

    assert snapshot["counts"]["runtime_waiting"] == 1
    assert snapshot["runtime_waits"][0]["wait_id"] == "runtime-wait-1"


@pytest.mark.asyncio
async def test_runtime_human_answered_ignore_reason_uses_managed_run_language(tmp_path) -> None:
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
    )

    result = await service.handle_podium_ws_command({"type": "human.answered", "wait_id": "wait-1"})

    assert result == {"status": "ignored", "reason": "managed_runs_use_runtime_wait_state"}
