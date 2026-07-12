from __future__ import annotations

from types import SimpleNamespace

from conductor.store import ConductorStore
from conductor.conductor_service import ConductorService


def test_restart_reuses_parent_run_and_children(tmp_path, minimal_plan) -> None:
    first = ConductorStore(tmp_path)
    run = first.create_run("parent-1", "APP-1", instance_id="instance-1")
    first.save_plan(run["run_id"], minimal_plan)

    restarted = ConductorStore(tmp_path)
    same = restarted.create_run("parent-1", "APP-1", instance_id="instance-1")

    assert same["run_id"] == run["run_id"]
    assert [task["task_id"] for task in restarted.list_tasks(run["run_id"])] == ["task-1"]


def test_service_uses_one_fresh_workflow_database(tmp_path) -> None:
    store = ConductorStore(tmp_path)
    service = ConductorService(store=store, data_root=tmp_path)

    assert store.db_path == tmp_path / "workflow.db"
    assert service.store is store
    assert not (tmp_path / "conductor.db").exists()


def test_runtime_snapshot_uses_current_workflow_state_fields() -> None:
    class FakeWorkflowStore:
        def managed_run_view(self):
            return {
                "runs": [
                    {
                        "run_id": "run-1",
                        "parent_issue_id": "parent-1",
                        "issue_identifier": "APP-1",
                        "state": "executing",
                        "active_task_id": "task-1",
                        "runtime_waits": [{"state": "open"}],
                    }
                ]
            }

    service = type("SnapshotService", (), {"store": FakeWorkflowStore()})()

    snapshot = ConductorService._managed_run_runtime_snapshot(service)

    assert snapshot["running"] == [
        {"run_id": "run-1", "issue_id": "parent-1", "issue_identifier": "APP-1", "state": "executing", "active_work_item_id": "task-1"}
    ]
    assert snapshot["counts"]["runtime_waiting"] == 1


def test_instance_runtime_aggregates_performer_metrics(tmp_path) -> None:
    service = ConductorService(store=ConductorStore(tmp_path), data_root=tmp_path)
    service._require_instance = lambda instance_id: SimpleNamespace(
        id=instance_id,
        process_status="running",
        pid=123,
        http_port=8081,
        log_path=str(tmp_path / "performer.log"),
        workspace_root=str(tmp_path / "workspace"),
    )
    service._managed_run_runtime_snapshot = lambda: {
        "running": [
            {
                "tokens": {
                    "input_tokens": 12,
                    "output_tokens": 8,
                    "cached_tokens": 3,
                    "total_tokens": 20,
                },
                "turn_count": 2,
            },
            {
                "tokens": {"input_tokens": True, "output_tokens": "8"},
                "turn_count": False,
            },
        ],
        "retrying": ["run-2"],
        "continuing": ["run-3"],
        "blocked": ["run-4"],
        "human_interventions": ["wait-1"],
    }

    runtime = service.instance_runtime("instance-1")

    assert runtime["metrics"] == {
        "tokens": {
            "input_tokens": 12,
            "output_tokens": 8,
            "cached_tokens": 3,
            "total_tokens": 20,
        },
        "turns": 2,
        "running": 2,
        "retrying": 1,
        "continuing": 1,
        "blocked": 1,
        "pending_human": 1,
    }
