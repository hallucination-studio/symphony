from __future__ import annotations

from conductor.store import ConductorStore
from conductor.workflow import Workflow
from conductor.conductor_service import ConductorService


def test_restart_reuses_parent_run_and_children(tmp_path, minimal_plan) -> None:
    first = Workflow(ConductorStore(tmp_path))
    run = first.accept_parent("parent-1", "APP-1", instance_id="instance-1")
    first.commit_plan(run["run_id"], minimal_plan)

    restarted = Workflow(ConductorStore(tmp_path))
    same = restarted.accept_parent("parent-1", "APP-1", instance_id="instance-1")

    assert same["run_id"] == run["run_id"]
    assert [task["task_id"] for task in restarted.store.list_tasks(run["run_id"])] == ["task-1"]


def test_service_uses_one_fresh_workflow_database(tmp_path) -> None:
    store = ConductorStore(tmp_path)
    service = ConductorService(store=store, data_root=tmp_path)

    assert store.db_path == tmp_path / "workflow.db"
    assert service.store is store
    assert service.workflow.store is store
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
