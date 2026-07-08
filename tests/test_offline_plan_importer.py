from __future__ import annotations

from conductor.conductor_pipeline import ConductorPipelineStore
from conductor.offline_plan_importer import import_offline_plan
from performer_api.pipeline import RuntimeMode


def test_offline_importer_commits_valid_hand_written_plan_without_scheduling(tmp_path) -> None:
    store = ConductorPipelineStore(tmp_path)
    revision = import_offline_plan(
        store,
        {
            "graph_id": "offline-graph",
            "plan_attempt_id": "offline-plan-1",
            "root_node_id": "root",
            "nodes": [
                {
                    "node_id": "a",
                    "title": "Task A",
                    "verification_procedure": ["pytest tests/test_a.py"],
                },
                {
                    "node_id": "b",
                    "title": "Task B",
                    "verification_procedure": ["pytest tests/test_b.py"],
                    "blocks": ["a"],
                },
            ],
        },
    )

    assert revision.revision == 1
    assert store.blockers_for("b") == ["a"]
    gate = store.gate_for_node("a")
    assert gate is not None
    assert gate.content.verification_procedure[0].source.value == "issue_requirement"
    assert store.active_lease("a", RuntimeMode.EXECUTE) is None
