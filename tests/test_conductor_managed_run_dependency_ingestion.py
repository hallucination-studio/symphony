from __future__ import annotations

from conductor.conductor_managed_run_coordinator import ConductorManagedRunCoordinator
from conductor.conductor_managed_run_dependency_ingestion import ingest_linear_dependency_blocks
from conductor.conductor_managed_run_store import ConductorManagedRunStore
from performer_api.managed_runs import (
    ManagedRunPlan,
    ParallelizationPolicy,
    VerificationRubric,
    WorkItem,
    WorkItemSliceType,
    WorkItemState,
    WorkItemVerification,
)


def test_linear_dependency_ingestion_is_union_only_and_drops_canceled_edges(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    store.record_linear_projection(accepted.run_id, "wi-1", linear_issue_id="child-1", metadata={})
    store.record_linear_projection(accepted.run_id, "wi-2", linear_issue_id="child-2", metadata={})
    store.record_linear_projection(accepted.run_id, "wi-3", linear_issue_id="child-3", metadata={})

    added = ingest_linear_dependency_blocks(
        store,
        accepted.run_id,
        [{"type": "blocks", "issue_id": "child-2", "related_issue_id": "child-3"}],
    )

    dependencies = _dependencies(store, accepted.run_id)
    assert added == {"applied": True, "reason": "dependencies_updated"}
    assert dependencies["wi-2"] == ["wi-1"]
    assert dependencies["wi-3"] == ["wi-2"]

    lagging = ingest_linear_dependency_blocks(store, accepted.run_id, [])

    assert lagging == {"applied": False, "reason": "topology_unchanged"}
    assert _dependencies(store, accepted.run_id)["wi-3"] == ["wi-2"]

    store.update_work_item_state(accepted.run_id, "wi-2", WorkItemState.CANCELLED, gate_status="cancelled_by_plan_revision:2")
    dropped = ingest_linear_dependency_blocks(store, accepted.run_id, [])

    assert dropped == {"applied": True, "reason": "dependencies_updated"}
    assert _dependencies(store, accepted.run_id)["wi-3"] == []


def test_linear_dependency_ingestion_rejects_cycles_without_committing(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    store.record_linear_projection(accepted.run_id, "wi-1", linear_issue_id="child-1", metadata={})
    store.record_linear_projection(accepted.run_id, "wi-2", linear_issue_id="child-2", metadata={})

    rejected = ingest_linear_dependency_blocks(
        store,
        accepted.run_id,
        [{"type": "blocks", "issue_id": "child-2", "related_issue_id": "child-1"}],
    )

    assert rejected == {"applied": False, "reason": "dependency_cycle_rejected"}
    assert _dependencies(store, accepted.run_id)["wi-1"] == []
    assert _dependencies(store, accepted.run_id)["wi-2"] == ["wi-1"]


def _dependencies(store: ConductorManagedRunStore, run_id: str) -> dict[str, list[str]]:
    return {
        str(item["work_item_id"]): list((item.get("payload") or {}).get("dependencies") or [])
        for item in store.list_work_items(run_id)
    }


def _plan() -> ManagedRunPlan:
    items = [
        _item("wi-1", []),
        _item("wi-2", ["wi-1"]),
        _item("wi-3", []),
    ]
    return ManagedRunPlan(
        summary="Dependency plan",
        architecture_decisions=["Linear blocks are union-only"],
        work_items=items,
        checkpoints=[],
        verification_rubric=VerificationRubric(
            correctness=["dependencies valid"],
            quality=["idempotent"],
            integration=["Linear readable"],
            documentation=["projected"],
            ship_readiness=["safe"],
        ),
        risks=[],
        open_questions=[],
        approval_required=False,
    )


def _item(work_item_id: str, dependencies: list[str]) -> WorkItem:
    return WorkItem(
        id=work_item_id,
        title="Implement dependency",
        objective=f"Implement {work_item_id}",
        slice_type=WorkItemSliceType.VERTICAL,
        acceptance_criteria=["done"],
        verification=WorkItemVerification(red_command="pytest -q", green_commands=["pytest -q"]),
        dependencies=dependencies,
        estimated_scope="S",
        files_likely_touched=[f"src/{work_item_id}.py"],
        parallelization=ParallelizationPolicy(safe_to_parallelize=False, reason="ordered"),
    )
