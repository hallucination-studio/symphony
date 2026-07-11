from __future__ import annotations

from conductor.store import ConductorStore
from conductor.workflow import Workflow


def test_restart_reuses_parent_run_and_children(tmp_path, minimal_plan) -> None:
    db_path = tmp_path / "workflow.db"
    first = Workflow(ConductorStore(db_path))
    run = first.accept_parent("parent-1", "APP-1", instance_id="instance-1")
    first.commit_plan(run["run_id"], minimal_plan)

    restarted = Workflow(ConductorStore(db_path))
    same = restarted.accept_parent("parent-1", "APP-1", instance_id="instance-1")

    assert same["run_id"] == run["run_id"]
    assert [task["task_id"] for task in restarted.store.list_tasks(run["run_id"])] == ["task-1"]
