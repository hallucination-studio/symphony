from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from conductor.conductor_podium_sync import ConductorPodiumSyncMixin, _smoke_runtime_fields
from conductor.conductor_smoke_protocol import SmokeCommandError, normalize_smoke_command
from conductor.conductor_api import ConductorApiServer
from conductor.conductor_service import ConductorService
from conductor.models import ConductorServiceError
from conductor.store import ConductorStore


class _SmokeProxy:
    def __init__(self, labels: list[dict[str, str]] | None = None) -> None:
        self.labels = labels or [{"id": "label-1", "name": "symphony:conductor/Bach-abc123"}]

    async def find_project_id(self, _slug: str) -> str:
        return "project-1"

    async def fetch_project_labels(self, _project_id: str) -> list[dict[str, str]]:
        return self.labels


def _smoke_command_payload(workspace: Path, label_name: str = "symphony:conductor/Bach-abc123") -> dict[str, object]:
    return {
        "type": "smoke.check",
        "smoke_check_id": "smoke-1",
        "binding_id": "binding-1",
        "config_version": 1,
        "linear_project_id": "project-1",
        "project_slug": "example",
        "repository": {"mode": "local_path", "value": str(workspace)},
        "expected_label": {"id": "label-1", "name": label_name},
        "runtime_config_version": 1,
    }


def test_smoke_logs_derive_runtime_group_from_conductor_identity() -> None:
    fields = _smoke_runtime_fields(
        SimpleNamespace(podium_runtime_id="runtime-1", conductor_id="conductor-1"),
        None,
    )

    assert fields.startswith("runtime_group_id=group_conductor-1 runtime_id=runtime-1 ")


@pytest.mark.anyio
async def test_smoke_check_accepts_and_matches_the_podium_project_label(tmp_path: Path) -> None:
    command = normalize_smoke_command(_smoke_command_payload(tmp_path))
    instance = SimpleNamespace(
        linear_filters={
            "binding_id": "binding-1",
            "binding_config_version": 1,
            "linear_project_id": "project-1",
        },
        linear_project="example",
        repo_source_type="local_path",
        repo_source_value=str(tmp_path),
        resolved_repo_path=str(tmp_path),
    )
    service = SimpleNamespace(project_label_proxy_factory=lambda _instance: _SmokeProxy())

    result = await ConductorPodiumSyncMixin._execute_smoke_check(service, command, instance)

    assert result["status"] == "passed"
    assert all(check["passed"] for check in result["checks"])


def test_smoke_command_rejects_a_noncanonical_podium_label(tmp_path: Path) -> None:
    for label_name in (
        "symphony:conductor/Bach-ABC123",
        " symphony:conductor/Bach-abc123 ",
    ):
        with pytest.raises(SmokeCommandError, match="project label"):
            normalize_smoke_command(_smoke_command_payload(tmp_path, label_name))


@pytest.mark.anyio
async def test_smoke_check_requires_one_label_matching_id_and_name(tmp_path: Path) -> None:
    command = normalize_smoke_command(_smoke_command_payload(tmp_path))
    instance = SimpleNamespace(
        linear_filters={
            "binding_id": "binding-1",
            "binding_config_version": 1,
            "linear_project_id": "project-1",
        },
        linear_project="example",
        repo_source_type="local_path",
        repo_source_value=str(tmp_path),
        resolved_repo_path=str(tmp_path),
    )
    service = SimpleNamespace(
        project_label_proxy_factory=lambda _instance: _SmokeProxy(
            [
                {"id": "label-1", "name": "symphony:conductor/Mozart-abc123"},
                {"id": "label-2", "name": "symphony:conductor/Bach-abc123"},
            ]
        )
    )

    result = await ConductorPodiumSyncMixin._execute_smoke_check(service, command, instance)

    assert result["status"] == "failed"
    assert next(check for check in result["checks"] if check["name"] == "project_label_state")["passed"] is False


@pytest.mark.anyio
async def test_podium_tick_reports_then_handles_command_dispatch_and_workflow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    class FakeService:
        async def post_podium_report(self) -> dict[str, str]:
            calls.append("report")
            return {"status": "ok"}

        async def poll_podium_dispatch_once(self) -> dict[str, str]:
            calls.append("dispatch")
            return {"status": "idle"}

        async def coordinate_background_once(self) -> dict[str, str]:
            calls.append("workflow")
            return {"status": "ok"}

    async def poll_command_once(_server: ConductorApiServer) -> dict[str, str]:
        calls.append("command")
        return {"status": "idle"}

    monkeypatch.setattr(ConductorApiServer, "_poll_command_once", poll_command_once, raising=False)

    await ConductorApiServer(FakeService())._poll_once()

    assert calls == ["report", "command", "dispatch", "workflow"]


def test_managed_run_linear_proxy_requires_podium_configuration(tmp_path: Path) -> None:
    service = ConductorService(store=ConductorStore(tmp_path), data_root=tmp_path)
    instance = SimpleNamespace(linear_project="example", linear_filters={})

    with pytest.raises(ConductorServiceError) as error:
        service._managed_run_tracker()
    assert error.value.code == "podium_proxy_not_configured"


def test_podium_report_projects_the_managed_run_shape_consumed_by_web() -> None:
    service = SimpleNamespace(
        store=SimpleNamespace(
            get_settings=lambda: SimpleNamespace(conductor_id="conductor-1"),
            list_instances=lambda: [],
        ),
        managed_run_view=lambda: {
            "runs": [
                {
                    "run_id": "run-1",
                    "parent_issue_id": "parent-1",
                    "issue_identifier": "APP-1",
                    "state": "executing",
                    "active_task_id": "task-1",
                    "latest_reason": "",
                    "plan_version": 2,
                    "payload": {"thread_id": "thread-1"},
                    "tasks": [
                        {
                            "task_id": "task-1",
                            "state": "in_progress",
                            "gate_status": "execute_started",
                            "task": {
                                "title": "Implement endpoint",
                                "objective": "Add the endpoint",
                                "files_likely_touched": ["src/api.py"],
                            },
                        }
                    ],
                }
            ]
        },
    )

    report = ConductorPodiumSyncMixin.build_podium_report(service)
    run = report["managed_runs"]["runs"][0]

    assert run["active_work_item_id"] == "task-1"
    assert run["backend_session_id"] == "thread-1"
    assert run["work_items"] == [
        {
            "work_item_id": "task-1",
            "state": "in_progress",
            "gate_status": "execute_started",
            "payload": {
                "title": "Implement endpoint",
                "objective": "Add the endpoint",
                "files_likely_touched": ["src/api.py"],
            },
        }
    ]
    assert "tasks" not in run
