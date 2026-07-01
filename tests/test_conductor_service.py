from __future__ import annotations

from pathlib import Path
from datetime import timedelta
import subprocess

import pytest

from symphony.conductor_models import ConductorSettings, InstanceCreateRequest, InstancePatchRequest, InstanceRecord
from symphony.conductor_service import ConductorService, ConductorServiceError
from symphony.conductor_store import ConductorStore
from symphony.models import RetryEntry, RuntimeTokens, utc_now
from symphony.ops_models import IssueRecord, OpsSnapshot, RetentionMetadata, RunRecord, TraceEvent
from symphony.ops_store import OpsStore
from symphony.persistence import PersistenceStore, PersistedSession, PersistedState


def make_service(tmp_path: Path) -> ConductorService:
    store = ConductorStore(tmp_path / "conductor-data")
    return ConductorService(store=store, data_root=tmp_path / "conductor-data")


def make_repo(tmp_path: Path, name: str = "repo") -> Path:
    repo = tmp_path / name
    repo.mkdir(parents=True)
    (repo / ".git").mkdir()
    (repo / "README.md").write_text("hello\n", encoding="utf-8")
    return repo


def make_request(repo: Path, *, name: str = "Alpha", port: int | None = None) -> InstanceCreateRequest:
    return InstanceCreateRequest(
        name=name,
        repo_source_type="local_path",
        repo_source_value=str(repo),
        linear_project="ENG",
        linear_filters={"labels": ["codex"], "active_states": ["Todo", "In Progress"]},
        workflow_profile="default",
        workflow_inputs={"goal": "Handle tasks"},
        http_port=port,
    )


def write_sample_ops_snapshot(instance: InstanceRecord) -> None:
    OpsStore(Path(instance.persistence_path).parent / "ops.json").save(
        OpsSnapshot(
            issues={
                "issue-1": IssueRecord(
                    issue_id="issue-1",
                    issue_identifier="ENG-1",
                    title="Trace UI",
                    state="stalled",
                    total_turn_count=7,
                    total_tokens=188240,
                    total_estimated_cost_usd=0.97,
                    failure_reason="no Codex output arrived for 14 minutes after a tool timeout",
                    last_activity_at="2026-06-30T00:10:00Z",
                )
            },
            runs={
                "run-1": RunRecord(
                    run_id="run-1",
                    issue_id="issue-1",
                    instance_id=instance.id,
                    status="stalled",
                    turn_count=7,
                    attempt_count=2,
                    total_tokens=188240,
                    estimated_cost_usd=0.97,
                    failure_summary="no Codex output arrived for 14 minutes after a tool timeout",
                    last_activity_at="2026-06-30T00:10:00Z",
                )
            },
            events=[
                TraceEvent(
                    event_id="evt-1",
                    event_type="issue_dispatched",
                    timestamp="2026-06-30T00:00:00Z",
                    issue_id="issue-1",
                    run_id="run-1",
                    retention_tier="summary",
                ),
                TraceEvent(
                    event_id="evt-2",
                    event_type="tool_call_failed",
                    timestamp="2026-06-30T00:09:00Z",
                    issue_id="issue-1",
                    run_id="run-1",
                    retention_tier="raw",
                ),
            ],
            retention=RetentionMetadata(),
        )
    )


class CapturingRuntime:
    def __init__(self) -> None:
        self.env: dict[str, str] | None = None

    async def start(self, instance, *, env: dict[str, str] | None = None):
        self.env = env
        return instance.with_updates(process_status="running", pid=4242)

    async def stop(self, instance):
        return instance.with_updates(process_status="stopped", pid=None)

    async def restart(self, instance, *, env: dict[str, str] | None = None):
        self.env = env
        return instance.with_updates(process_status="running", pid=4242)

    def runtime_snapshot(self, instance):
        return {"instance_id": instance.id, "process_status": instance.process_status}

    def read_logs(self, instance):
        return ""


def test_conductor_service_lists_issue_run_trace_and_retention(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    write_sample_ops_snapshot(instance)

    issues = service.list_issues()
    runs = service.list_runs()
    traces = service.list_trace_events(issue_id="issue-1", run_id=None)
    retention = service.retention_status()

    assert issues[0]["issue_identifier"] == "ENG-1"
    assert issues[0]["instance_id"] == instance.id
    assert "no Codex output" in service.get_issue("issue-1")["state_explanation"]
    assert runs[0]["turn_count"] == 7
    assert service.get_run("run-1")["run"]["run_id"] == "run-1"
    assert traces[0]["event_type"] == "issue_dispatched"
    assert retention["pinned_issue_count"] == 0


def test_conductor_service_pins_issue_and_collects_retention(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    write_sample_ops_snapshot(instance)

    service.pin_issue("issue-1")
    retention = service.retention_status()
    service.collect_retention()

    assert retention["pinned_issue_count"] == 1
    assert "issue-1" in retention["pinned_issue_ids"]
    snapshot = OpsStore(Path(instance.persistence_path).parent / "ops.json").load()
    assert "issue-1" in snapshot.retention.pinned_issue_ids


def test_create_instance_from_local_path_generates_valid_workflow(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    (repo / "src.txt").write_text("source\n", encoding="utf-8")
    for excluded in [".symphony", "conductor-data", ".venv", "workspaces", ".codex-runtime"]:
        (repo / excluded).mkdir()
        (repo / excluded / "excluded.txt").write_text("no\n", encoding="utf-8")

    instance = service.create_instance(make_request(repo))

    assert instance.repo_source_type == "local_path"
    assert instance.resolved_repo_path == str(repo.resolve())
    assert instance.workspace_root == str((Path(instance.instance_dir) / "workspace" / "repo").resolve())
    assert instance.workflow_generation_status == "valid"
    assert Path(instance.workflow_path).exists()
    assert Path(instance.log_path).parent.exists()
    assert (Path(instance.workspace_root) / "src.txt").read_text(encoding="utf-8") == "source\n"
    assert (Path(instance.workspace_root) / ".git").exists()
    for excluded in [".symphony", "conductor-data", ".venv", "workspaces", ".codex-runtime"]:
        assert not (Path(instance.workspace_root) / excluded).exists()
    assert "Handle tasks" in instance.workflow_content


def test_create_instance_reuses_existing_workspace_without_resyncing(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance_dir = tmp_path / "custom-instance"
    workspace_root = instance_dir / "workspace" / "repo"
    workspace_root.mkdir(parents=True)
    (workspace_root / "keep.txt").write_text("existing\n", encoding="utf-8")

    instance = service.create_instance(
        make_request(repo).with_overrides(
            instance_dir=str(instance_dir),
            workspace_root=str(workspace_root),
        )
    )

    assert instance.workspace_root == str(workspace_root)
    assert (workspace_root / "keep.txt").read_text(encoding="utf-8") == "existing\n"
    assert not (workspace_root / "README.md").exists()


def test_create_instance_clones_git_source_only_when_workspace_is_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = make_service(tmp_path)
    calls: list[list[str]] = []

    def fake_run(command, *, check, cwd=None):
        calls.append(list(command))
        target = Path(command[-1])
        target.mkdir(parents=True, exist_ok=True)
        (target / ".git").mkdir()
        (target / "README.md").write_text("cloned\n", encoding="utf-8")
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)

    instance = service.create_instance(
        InstanceCreateRequest(
            name="Git Source",
            repo_source_type="git",
            repo_source_value="https://example.com/acme/repo.git",
            linear_project="ENG",
            linear_filters={"labels": ["codex"]},
            workflow_profile="default",
            workflow_inputs={},
        )
    )

    assert instance.resolved_repo_path == "https://example.com/acme/repo.git"
    assert calls == [["git", "clone", "--", "https://example.com/acme/repo.git", instance.workspace_root]]
    assert (Path(instance.workspace_root) / "README.md").read_text(encoding="utf-8") == "cloned\n"


def test_create_instance_reuses_non_empty_git_workspace_without_cloning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = make_service(tmp_path)
    instance_dir = tmp_path / "custom-instance"
    workspace_root = instance_dir / "workspace" / "repo"
    workspace_root.mkdir(parents=True)
    (workspace_root / "keep.txt").write_text("existing\n", encoding="utf-8")
    calls: list[list[str]] = []

    def fake_run(command, *, check, cwd=None):
        calls.append(list(command))
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)

    instance = service.create_instance(
        InstanceCreateRequest(
            name="Git Source",
            repo_source_type="git",
            repo_source_value="https://example.com/acme/repo.git",
            linear_project="ENG",
            linear_filters={"labels": ["codex"]},
            workflow_profile="default",
            workflow_inputs={},
            instance_dir=str(instance_dir),
            workspace_root=str(workspace_root),
        )
    )

    assert instance.workspace_root == str(workspace_root)
    assert calls == []
    assert (workspace_root / "keep.txt").read_text(encoding="utf-8") == "existing\n"


def test_instance_runtime_includes_persisted_symphony_issue_details(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    store = PersistenceStore(Path(instance.persistence_path))
    started_at = utc_now() - timedelta(seconds=9)
    store.save(
        PersistedState(
            sessions=[
                PersistedSession(
                    issue_id="issue-1",
                    issue_identifier="ENG-1",
                    issue_url="https://linear.app/x/issue/ENG-1",
                    session_id="thread-turn",
                    thread_id="thread",
                    turn_id="turn",
                    worker_host="local",
                    started_at=started_at,
                    last_event="notification",
                    last_message="working",
                    last_raw_message="item/agentMessage/delta",
                    phase="running",
                    status_label="symphony:running",
                    workspace_path=str(Path(instance.workspace_root) / "ENG-1"),
                    recent_events=[
                        {
                            "at": "2026-06-30T00:00:00Z",
                            "event": "notification",
                            "message": "working",
                            "raw_method": "item/agentMessage/delta",
                            "raw_event": {
                                "event": "notification",
                                "raw_method": "item/agentMessage/delta",
                                "payload": {"delta": "working"},
                            },
                        }
                    ],
                    turn_count=3,
                    tokens=RuntimeTokens(input_tokens=20, output_tokens=8, cached_tokens=5, total_tokens=33),
                )
            ],
            retry_attempts=[
                RetryEntry(
                    issue_id="issue-2",
                    identifier="ENG-2",
                    attempt=2,
                    due_at=utc_now() + timedelta(seconds=60),
                    due_at_ms=123456,
                    error="worker exited: boom",
                    issue_url="https://linear.app/x/issue/ENG-2",
                    phase="retrying",
                    status_label="symphony:retrying",
                )
            ],
        )
    )

    runtime = service.instance_runtime(instance.id)

    assert runtime["workspace"]["root"] == instance.workspace_root
    assert runtime["workspace"]["strategy"] == "instance_repo_workspace"
    assert "reuses the prepared repository workspace" in runtime["workspace"]["description"]
    assert runtime["symphony"]["source"] == "persistence"
    assert runtime["symphony"]["counts"] == {"running": 1, "retrying": 1}
    assert runtime["symphony"]["running"][0]["issue_identifier"] == "ENG-1"
    assert runtime["symphony"]["running"][0]["phase"] == "running"
    assert runtime["symphony"]["running"][0]["status_label"] == "symphony:running"
    assert runtime["symphony"]["running"][0]["turn_count"] == 3
    assert runtime["symphony"]["running"][0]["tokens"]["cached_tokens"] == 5
    assert runtime["symphony"]["running"][0]["tokens"]["total_tokens"] == 33
    assert runtime["symphony"]["running"][0]["recent_events"][0]["raw_event"]["payload"]["delta"] == "working"
    assert runtime["symphony"]["retrying"][0]["issue_identifier"] == "ENG-2"
    assert runtime["symphony"]["retrying"][0]["error"] == "worker exited: boom"
    assert runtime["metrics"]["tokens"]["cached_tokens"] == 5
    assert runtime["metrics"]["tokens"]["total_tokens"] == 33
    assert runtime["metrics"]["turns"] == 3
    assert runtime["metrics"]["retrying"] == 1


def test_dashboard_aggregates_persisted_runtime_metrics(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    PersistenceStore(Path(instance.persistence_path)).save(
        PersistedState(
            sessions=[
                PersistedSession(
                    issue_id="issue-1",
                    issue_identifier="ENG-1",
                    issue_url=None,
                    session_id="thread-turn",
                    thread_id="thread",
                    turn_id="turn",
                    worker_host="local",
                    started_at=utc_now() - timedelta(seconds=20),
                    turn_count=2,
                    tokens=RuntimeTokens(input_tokens=30, output_tokens=12, total_tokens=42),
                )
            ],
            retry_attempts=[
                RetryEntry(
                    issue_id="issue-2",
                    identifier="ENG-2",
                    attempt=2,
                    due_at=utc_now() + timedelta(seconds=60),
                    due_at_ms=123456,
                    error="worker exited: boom",
                    issue_url=None,
                )
            ],
        )
    )

    dashboard = service.dashboard()

    assert dashboard["totals"]["tokens"] == 42
    assert dashboard["totals"]["runtime_seconds"] >= 19
    assert dashboard["totals"]["failures"] == 1
    assert dashboard["totals"]["retries"] == 1


def test_create_instance_rejects_duplicate_workspace_resources(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo_a = make_repo(tmp_path, "repo-a")
    repo_b = make_repo(tmp_path, "repo-b")
    first = service.create_instance(make_request(repo_a, name="Alpha", port=8801))

    with pytest.raises(ConductorServiceError) as exc:
        service.create_instance(
            make_request(repo_b, name="Beta", port=first.http_port).with_overrides(
                workspace_root=first.workspace_root
            )
        )

    assert exc.value.code == "resource_collision"


def test_create_instance_rejects_same_local_repo_binding(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    service.create_instance(make_request(repo, name="Alpha"))

    with pytest.raises(ConductorServiceError) as exc:
        service.create_instance(make_request(repo, name="Beta"))

    assert exc.value.code == "resource_collision"


def test_update_instance_revalidates_workflow_and_persists_raw_edits(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))

    updated = service.update_instance(
        instance.id,
        InstancePatchRequest(
            workflow_content=instance.workflow_content.replace("Handle tasks", "Updated goal"),
        ),
    )

    assert updated.workflow_generation_status == "valid"
    assert "Updated goal" in Path(updated.workflow_path).read_text(encoding="utf-8")


def test_update_instance_persists_replaced_workflow_content_in_metadata(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    replacement = instance.workflow_content.replace("https://api.linear.app/graphql", "http://127.0.0.1:9999/graphql")

    updated = service.update_instance(
        instance.id,
        InstancePatchRequest(workflow_content=replacement),
    )

    stored = service.get_instance(instance.id)
    assert stored is not None
    assert "http://127.0.0.1:9999/graphql" in updated.workflow_content
    assert "http://127.0.0.1:9999/graphql" in stored.workflow_content


def test_update_instance_rejects_invalid_raw_workflow(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))

    with pytest.raises(ConductorServiceError) as exc:
        service.update_instance(instance.id, InstancePatchRequest(workflow_content="---\ntracker: [\n---"))

    assert exc.value.code == "workflow_parse_error"


def test_validate_workflow_returns_diagnostics_without_saving(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))

    result = service.validate_workflow(instance.id, "---\ntracker: [\n---")

    assert result.ok is False
    reloaded = service.get_instance(instance.id)
    assert reloaded is not None
    assert reloaded.workflow_generation_status == "valid"


def test_delete_instance_removes_record_when_stopped(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))

    service.delete_instance(instance.id)

    assert service.get_instance(instance.id) is None


def test_inspect_repo_reports_local_directory_context(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)

    result = service.inspect_repo("local_path", str(repo))

    assert result["exists"] is True
    assert result["git"] is True
    assert result["resolved_path"] == str(repo.resolve())
    assert "README.md" in result["files"]


def test_service_initialization_marks_stale_running_instances_stopped(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    repo = make_repo(tmp_path)
    instance = InstanceRecord.create(
        id="inst-1",
        name="Alpha",
        repo_source_type="local_path",
        repo_source_value=str(repo),
        resolved_repo_path=str(repo),
        instance_dir=str(tmp_path / "conductor-data" / "instances" / "inst-1"),
        workflow_path=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "WORKFLOW.md"),
        workspace_root=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "workspace"),
        persistence_path=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "state" / "symphony.json"),
        log_path=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "logs" / "symphony.log"),
        http_port=8801,
        linear_project="ENG",
        linear_filters={"labels": ["codex"]},
        workflow_profile="default",
        workflow_inputs={},
    ).with_updates(process_status="running", pid=999999)
    store.save_instance(instance)

    ConductorService(store=store, data_root=tmp_path / "conductor-data")

    reloaded = store.get_instance("inst-1")
    assert reloaded is not None
    assert reloaded.process_status == "stopped"
    assert reloaded.pid is None


@pytest.mark.asyncio
async def test_start_instance_passes_conductor_linear_api_key_to_runtime_env(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    runtime = CapturingRuntime()
    service = ConductorService(store=store, data_root=tmp_path / "conductor-data", runtime_manager=runtime)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    service.update_settings(ConductorSettings(linear_api_key="conductor-token"))

    started = await service.start_instance(instance.id)

    assert started.process_status == "running"
    assert runtime.env == {"LINEAR_API_KEY": "conductor-token"}


@pytest.mark.asyncio
async def test_start_instance_requires_conductor_linear_api_key(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))

    with pytest.raises(ConductorServiceError) as exc:
        await service.start_instance(instance.id)

    assert exc.value.code == "missing_conductor_linear_api_key"
    assert runtime.env is None
