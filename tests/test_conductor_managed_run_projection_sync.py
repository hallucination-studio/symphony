from __future__ import annotations

import json

import pytest

from conductor.conductor_api import ConductorApiServer
from conductor.conductor_models import InstanceRecord
from conductor.conductor_service import ConductorService
from conductor.conductor_store import ConductorStore
from performer_api.managed_runs import (
    ManagedRunPlan,
    ParallelizationPolicy,
    VerificationRubric,
    WorkItem,
    WorkItemSliceType,
    WorkItemVerification,
)


class FailingTracker:
    async def update_issue_description_marker_block(self, _issue_id: str, _marker_name: str, _block: str) -> dict[str, object]:
        raise RuntimeError("Authorization: Bearer linear-secret access_token=raw-token")


class SuccessfulTracker:
    def __init__(self) -> None:
        self.children: list[dict[str, object]] = []
        self.description_blocks: list[tuple[str, str, str]] = []

    async def fetch_child_issues(self, _parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
        return []

    async def create_child_issue_for(
        self,
        *,
        parent_issue_id: str,
        title: str,
        description: str,
        label_names: list[str],
        delegate_id: str | None = None,
    ) -> dict[str, object]:
        child = {
            "id": f"child-{len(self.children) + 1}",
            "parent_issue_id": parent_issue_id,
            "title": title,
            "description": description,
            "labels": list(label_names),
            "delegate_id": delegate_id,
        }
        self.children.append(child)
        return child

    async def update_issue_description_marker_block(self, _issue_id: str, _marker_name: str, _block: str) -> dict[str, object]:
        self.description_blocks.append((_issue_id, _marker_name, _block))
        return {"success": True}

    async def transition_issue_by_state_target(self, _issue_id: str, *, names: list[str], state_type: str) -> dict[str, object]:
        return {"success": True, "names": names, "state_type": state_type}


def _instance(tmp_path) -> InstanceRecord:
    instance_dir = tmp_path / "instances" / "inst-1"
    return InstanceRecord.create(
        id="inst-1",
        name="Managed Run Runtime",
        repo_source_type="local_path",
        repo_source_value=str(tmp_path / "repo"),
        resolved_repo_path=str(tmp_path / "repo"),
        instance_dir=str(instance_dir),
        workspace_root=str(instance_dir / "workspace" / "repo"),
        persistence_path=str(instance_dir / "state" / "performer.json"),
        log_path=str(instance_dir / "logs" / "performer.log"),
        http_port=8801,
        linear_project="AI",
        linear_filters={},
    )


def _plan() -> ManagedRunPlan:
    return ManagedRunPlan(
        summary="Managed run projection visibility",
        architecture_decisions=["Linear is projection"],
        work_items=[
            WorkItem(
                id="wi-1",
                title="Add projection failure visibility",
                objective="Make projection failures visible in managed-run state",
                slice_type=WorkItemSliceType.VERTICAL,
                acceptance_criteria=["API shows sanitized projection failure"],
                verification=WorkItemVerification(red_command="pytest -q", green_commands=["pytest -q"]),
                dependencies=[],
                estimated_scope="S",
                files_likely_touched=["packages/conductor/src/conductor/conductor_podium_sync_linear.py"],
                parallelization=ParallelizationPolicy(safe_to_parallelize=False, reason="single run payload writer"),
            )
        ],
        checkpoints=[],
        verification_rubric=VerificationRubric(
            correctness=["projection error is visible"],
            quality=["secret values are redacted"],
            integration=["conductor API exposes durable state"],
            documentation=["managed-run operator surface stays accurate"],
            ship_readiness=["retry action remains visible"],
        ),
        risks=[],
        open_questions=[],
        approval_required=False,
    )


@pytest.mark.asyncio
async def test_projection_sync_failure_is_visible_in_managed_run_state_and_api(tmp_path) -> None:
    data_root = tmp_path / "conductor"
    service = ConductorService(store=ConductorStore(data_root), data_root=data_root)
    instance = _instance(tmp_path)
    service.store.create_instance(instance)
    accepted = service.managed_run_coordinator.accept_dispatch(
        {"issue_id": "root-1", "issue_identifier": "AI-1"},
        instance_id=instance.id,
    )
    service.managed_run_coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    service.managed_run_tracker_factory = lambda _instance: FailingTracker()

    projected = await service.reconcile_linear_managed_run_projections_once()

    assert projected == 0
    run = service.managed_run_store.get_run(accepted.run_id)
    assert run is not None
    assert run["payload"]["projection_healthy"] is False
    assert run["payload"]["last_projection_error"]["event"] == "linear_managed_run_projection_failed"
    assert run["payload"]["last_projection_error"]["action_required"] == "retry_projection"
    assert "Authorization: [REDACTED]" in run["payload"]["last_projection_error"]["sanitized_reason"]
    assert "linear-secret" not in json.dumps(run["payload"])
    assert "raw-token" not in json.dumps(run["payload"])

    status, body = await ConductorApiServer(service)._route("GET", "/api/managed-runs", b"")

    assert status == 200
    assert body["managed_runs"]["runs"][0]["payload"]["projection_healthy"] is False
    assert body["managed_runs"]["runs"][0]["payload"]["last_projection_error"]["retryable"] is True


@pytest.mark.asyncio
async def test_projection_sync_success_marks_managed_run_projection_healthy(tmp_path) -> None:
    data_root = tmp_path / "conductor"
    service = ConductorService(store=ConductorStore(data_root), data_root=data_root)
    instance = _instance(tmp_path)
    service.store.create_instance(instance)
    accepted = service.managed_run_coordinator.accept_dispatch(
        {"issue_id": "root-1", "issue_identifier": "AI-1"},
        instance_id=instance.id,
    )
    service.managed_run_coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    tracker = SuccessfulTracker()
    service.managed_run_tracker_factory = lambda _instance: tracker

    projected = await service.reconcile_linear_managed_run_projections_once()

    assert projected == 4
    run = service.managed_run_store.get_run(accepted.run_id)
    assert run is not None
    assert run["payload"]["projection_healthy"] is True
    assert run["payload"]["last_projection_error"] is None
    assert "last_successful_projection_at" in run["payload"]
    assert any(
        marker == "SYMPHONY RUN SUMMARY" and "projection_healthy: true" in block and "last_successful_projection_at:" in block
        for _, marker, block in tracker.description_blocks
    )
