from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from performer_api.codex_runtime import PerformerProfileConfig

from conductor.conductor_podium_sync import (
    ConductorPodiumSyncMixin,
    _managed_runs_report_view,
    _sanitize_managed_runs_view,
    _smoke_runtime_fields,
)
from conductor.conductor_smoke_protocol import SmokeCommandError, normalize_smoke_command
from conductor.conductor_api import ConductorApiServer
from conductor.conductor_service import ConductorService
from conductor.models import ConductorServiceError, InstanceRecord
from conductor.store import ConductorStore
from podium.podium_routes_runtime_ops import _normalize_managed_run_report


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


def _bound_instance(workspace: Path) -> InstanceRecord:
    return InstanceRecord.create(
        name="App",
        repo_source_type="local_path",
        repo_source_value=str(workspace),
        resolved_repo_path=str(workspace),
        instance_dir=str(workspace / "instance"),
        workspace_root=str(workspace),
        persistence_path=str(workspace / "workflow.db"),
        log_path=str(workspace / "instance.log"),
        http_port=8081,
        linear_project="APP",
        linear_filters={
            "binding_id": "binding-old",
            "binding_config_version": 1,
            "linear_project_id": "project-old",
        },
    )


def test_smoke_logs_derive_runtime_group_from_conductor_identity() -> None:
    fields = _smoke_runtime_fields(
        SimpleNamespace(podium_runtime_id="runtime-1", conductor_id="conductor-1"),
        None,
    )

    assert fields.startswith("runtime_group_id=group_conductor-1 runtime_id=runtime-1 ")


def test_managed_run_snapshot_redacts_bare_token_shapes() -> None:
    token_shaped_value = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

    snapshot = _sanitize_managed_runs_view(
        {"runs": [{"latest_reason": f"failed: {token_shaped_value}"}]}
    )

    assert token_shaped_value not in str(snapshot)
    assert snapshot["runs"][0]["latest_reason"] == "failed: [REDACTED]"


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
async def test_podium_tick_applies_command_before_reporting_dispatch_and_workflow(
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

    assert calls == ["command", "report", "dispatch", "workflow"]


def test_managed_run_linear_proxy_requires_podium_configuration(tmp_path: Path) -> None:
    service = ConductorService(store=ConductorStore(tmp_path), data_root=tmp_path)
    instance = SimpleNamespace(linear_project="example", linear_filters={})

    with pytest.raises(ConductorServiceError) as error:
        service._managed_run_tracker()
    assert error.value.code == "podium_proxy_not_configured"


def test_unbind_and_rebind_hard_cut_old_managed_runs(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path)
    instance = _bound_instance(tmp_path)
    store.create_instance(instance)
    store.create_run("parent-old", "OLD-1", instance_id=instance.id)
    service = ConductorService(store=store, data_root=tmp_path)

    unbound = service._handle_project_unconfigure({"binding_id": "binding-old", "config_version": 2})

    assert unbound["status"] == "unbound"
    assert store.list_runs() == []

    store.create_run("parent-stale", "STALE-1", instance_id=instance.id)
    profile = PerformerProfileConfig.create(
        binding_id="binding-new",
        binding_config_version=3,
        performer_binding_id="performer-binding:binding-new",
        performer_profile_id="performer-profile:user-1:default",
        runtime_profile_id="runtime-profile:user-1:default",
        performer_kind="codex",
        runtime_kind="codex",
        turn_policy={"max_turns": 4},
        config_document='model = "managed"\napproval_policy = "never"\n',
        credential_id="credential:user-1:chatgpt-main",
        credential_ref="slot:chatgpt-main",
    )
    rebound = service._handle_project_configure(
        {
            **profile.to_dict(),
            "linear_project_id": "project-new",
            "project_slug": "NEW",
            "project_name": "New",
            "binding_id": "binding-new",
            "config_version": 3,
            "auth_method": "chatgpt_oauth",
            "account_hint": "main",
            "performer_binding_generation": 1,
            "repository": {"mode": "local_path", "value": str(tmp_path)},
        }
    )

    assert rebound["status"] == "applied"
    assert store.managed_run_view() == {"runs": []}
    current = store.get_instance(instance.id)
    assert current is not None
    assert current.linear_filters["performer_profile_id"] == "performer-profile:user-1:default"
    assert current.linear_filters["runtime_profile_id"] == "runtime-profile:user-1:default"
    assert current.linear_filters["config_sha256"] == profile.config_sha256
    assert current.linear_filters["policy_sha256"] == profile.policy_sha256
    report = service.build_podium_report()
    reported = report["bindings"][0]
    assert reported["config_sha256"] == profile.config_sha256
    assert "config_document" not in reported
    assert "credential_ref" not in reported


def test_project_configure_rejects_removed_profile_revision_fields(tmp_path: Path) -> None:
    profile = PerformerProfileConfig.create(
        binding_id="binding-1",
        binding_config_version=1,
        performer_binding_id="performer-binding:binding-1",
        performer_profile_id="performer-profile:user-1:default",
        runtime_profile_id="runtime-profile:user-1:default",
        performer_kind="codex",
        runtime_kind="codex",
        turn_policy={},
        config_document='model = "managed"\n',
        credential_id="credential:user-1:chatgpt-main",
        credential_ref="slot:chatgpt-main",
    )
    service = ConductorService(store=ConductorStore(tmp_path), data_root=tmp_path)

    result = service._handle_project_configure(
        {
            **profile.to_dict(),
            "performer_profile_revision_id": "legacy",
            "linear_project_id": "project-1",
            "project_slug": "project",
            "project_name": "Project",
            "config_version": 1,
            "repository": {"mode": "local_path", "value": str(tmp_path)},
        }
    )

    assert result == {"status": "rejected", "reason": "profile_revision_field_rejected"}


def test_binding_hard_cut_keeps_old_state_when_instance_write_fails(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path)
    instance = _bound_instance(tmp_path)
    store.create_instance(instance)
    run = store.create_run("parent-old", "OLD-1", instance_id=instance.id)

    with pytest.raises(FileNotFoundError):
        store.replace_instance_and_clear_managed_runs(
            instance.with_updates(id="missing-instance", linear_project="NEW", linear_filters={"binding_id": "binding-new"})
        )

    current = store.get_instance(instance.id)
    assert current is not None
    assert current.linear_project == "APP"
    assert current.linear_filters == instance.linear_filters
    assert store.list_runs() == [run]


def test_podium_report_projects_the_managed_run_shape_consumed_by_web() -> None:
    instance = SimpleNamespace(
        id="instance-1",
        name="App",
        linear_project="APP",
        linear_filters={
            "binding_id": "binding-1",
            "binding_config_version": 2,
            "linear_project_id": "project-1",
        },
        process_status="running",
        repo_source_type="local_path",
        repo_source_value="/repo",
    )
    service = SimpleNamespace(
        store=SimpleNamespace(
            get_settings=lambda: SimpleNamespace(conductor_id="conductor-1"),
            list_instances=lambda: [instance],
        ),
        query_instance_logs=lambda *_args, **_kwargs: {"generation": 1, "offset_end": 0, "lines": []},
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
                    "acceptance": {"raw_manifest_ref": "manifest://run-1/secret-path"},
                    "tasks": [
                        {
                            "task_id": "task-1",
                            "state": "in_progress",
                            "gate_status": "execute_started",
                            "gate": {
                                "passed": True,
                                "score": 4,
                                "threshold": 3,
                                "plan_version": 2,
                                "catalog": {
                                    "id": "catalog-1",
                                    "rubric": [{"id": "correctness", "weight": 2, "threshold": 3}],
                                },
                                "manifest_count": 1,
                                "commands": {"passed": 1, "total": 1},
                                "rubric": [{"id": "correctness", "score": 4, "weight": 2}],
                                "provenance": [{"source": "codex", "attempt_id": "attempt-1"}],
                                "artifact_count": 1,
                                "failure_code": "",
                                "output": "output-secret",
                            },
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

    assert report["managed_runs"]["binding_id"] == "binding-1"
    assert report["managed_runs"]["binding_config_version"] == 2
    assert run["active_work_item_id"] == "task-1"
    assert run["backend_session_id"] == "thread-1"
    assert "acceptance" not in run
    assert run["work_items"] == [
        {
            "work_item_id": "task-1",
            "state": "in_progress",
            "gate_status": "execute_started",
            "gate": {
                "passed": True,
                "score": 4,
                "threshold": 3,
                "plan_version": 2,
                "catalog": {
                    "id": "catalog-1",
                    "rubric": [{"id": "correctness", "weight": 2, "threshold": 3}],
                },
                "manifest_count": 1,
                "commands": {"passed": 1, "total": 1},
                "rubric": [{"id": "correctness", "score": 4, "weight": 2}],
                "provenance": [{"source": "codex", "attempt_id": "attempt-1"}],
                "artifact_count": 1,
                "failure_code": "",
            },
            "payload": {
                "title": "Implement endpoint",
                "objective": "Add the endpoint",
                "files_likely_touched": ["src/api.py"],
            },
        }
    ]
    assert "tasks" not in run


def test_podium_report_drops_an_out_of_range_gate_summary_before_podium_validation() -> None:
    report = _managed_runs_report_view(
        {
            "runs": [
                {
                    "run_id": "run-1",
                    "parent_issue_id": "parent-1",
                    "issue_identifier": "APP-1",
                    "state": "executing",
                    "active_task_id": "task-1",
                    "latest_reason": "",
                    "plan_version": 1,
                    "payload": {},
                    "tasks": [
                        {
                            "task_id": "task-1",
                            "state": "in_progress",
                            "gate_status": "gate_started",
                            "gate": {
                                "passed": True,
                                "score": 1_000_001,
                                "threshold": 3,
                                "plan_version": 1,
                                "manifest_count": 0,
                                "commands": {"passed": 1, "total": 1},
                                "rubric": [],
                                "provenance": [],
                                "artifact_count": 0,
                                "failure_code": "",
                            },
                            "task": {
                                "title": "Implement endpoint",
                                "objective": "Add the endpoint",
                                "files_likely_touched": [],
                            },
                        }
                    ],
                }
            ]
        }
    )

    accepted = _normalize_managed_run_report(
        {"binding_id": "binding-1", "binding_config_version": 1, **report},
        binding_id="binding-1",
        binding_config_version=1,
    )

    assert "gate" not in report["runs"][0]["work_items"][0]
    assert accepted["runs"] == report["runs"]


def test_podium_report_bounds_history_and_file_hints_to_its_snapshot_contract() -> None:
    def stored_run(index: int) -> dict[str, object]:
        return {
            "run_id": f"run-{index}",
            "parent_issue_id": f"parent-{index}",
            "issue_identifier": f"APP-{index}",
            "state": "blocked" if index == 1 else "done",
            "active_task_id": "",
            "latest_reason": "",
            "plan_version": 1,
            "payload": {"thread_id": f"thread-{index}"},
            "tasks": [
                {
                    "task_id": "task-1",
                    "state": "done",
                    "gate_status": "passed:4",
                    "task": {
                        "title": "Implement endpoint",
                        "objective": "Add the endpoint",
                        "files_likely_touched": [f"src/{number}.py" for number in range(17)],
                    },
                }
            ],
        }

    report = _managed_runs_report_view({"runs": [stored_run(index) for index in range(1, 66)]})
    accepted = _normalize_managed_run_report(
        {"binding_id": "binding-1", "binding_config_version": 1, **report},
        binding_id="binding-1",
        binding_config_version=1,
    )

    assert report["active_runs_total"] == 1
    assert [run["run_id"] for run in report["runs"]] == ["run-1", *[f"run-{index}" for index in range(3, 66)]]
    assert accepted["runs"] == report["runs"]
    assert report["runs"][-1]["work_items"][0]["payload"]["files_likely_touched"] == [
        "src/0.py",
        "src/1.py",
        "src/2.py",
    ]
