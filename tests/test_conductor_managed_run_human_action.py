from __future__ import annotations

from typing import Any

from conductor.conductor_managed_run_coordinator import ConductorManagedRunCoordinator
from conductor.conductor_managed_run_human_action import ingest_managed_run_human_action_event
from conductor.conductor_managed_run_projection import ManagedRunLinearProjector
from conductor.conductor_managed_run_store import ConductorManagedRunStore
from performer_api.managed_runs import (
    ManagedRunState,
    ManagedRunPlan,
    ParallelizationPolicy,
    VerificationRubric,
    WorkItem,
    WorkItemResult,
    WorkItemResultStatus,
    WorkItemSliceType,
    WorkItemState,
    WorkItemVerification,
)


class Tracker:
    def __init__(self) -> None:
        self.children: list[dict[str, object]] = []
        self.comments: list[tuple[str, str]] = []
        self.updated_comments: list[tuple[str, str]] = []
        self.description_blocks: list[tuple[str, str, str]] = []
        self.transitions: list[tuple[str, list[str], str]] = []
        self.root_issue = {"id": "root-1", "state": "Todo", "state_type": "unstarted"}

    async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
        return [child for child in self.children if child.get("parent_issue_id") == parent_issue_id]

    async def fetch_issue(self, issue_id: str) -> dict[str, object]:
        if issue_id == self.root_issue["id"]:
            return dict(self.root_issue)
        for child in self.children:
            if child.get("id") == issue_id:
                return dict(child)
        return {}

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
            "state": "Todo",
            "state_type": "unstarted",
        }
        self.children.append(child)
        return child

    async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
        self.description_blocks.append((issue_id, marker_name, block))
        return {"success": True}

    async def transition_issue_by_state_target(self, issue_id: str, *, names: list[str], state_type: str) -> dict[str, object]:
        self.transitions.append((issue_id, list(names), state_type))
        target = names[0]
        if issue_id == self.root_issue["id"]:
            self.root_issue.update({"state": target, "state_type": state_type})
        else:
            for child in self.children:
                if child.get("id") == issue_id:
                    child.update({"state": target, "state_type": state_type})
        return {"success": True}

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, object]:
        self.comments.append((issue_id, body))
        return {"success": True, "comment_id": f"comment-{len(self.comments)}"}

    async def update_issue_comment(self, comment_id: str, body: str) -> dict[str, object]:
        self.updated_comments.append((comment_id, body))
        return {"success": True, "comment_id": comment_id}


async def test_managed_run_human_action_instruction_is_idempotent_and_state_flip_resumes(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _approval_plan(), backend_session_id="thread-1")
    coordinator.start_work_item(accepted.run_id, "wi-1")
    tracker = Tracker()
    projector = ManagedRunLinearProjector(store=store, tracker=tracker, root_issue_id="root-1")

    await projector.reconcile_once(accepted.run_id)
    await projector.reconcile_once(accepted.run_id)

    assert len(tracker.comments) == 1
    assert tracker.comments[0][0] == "child-1"
    assert "comments are context only" in tracker.comments[0][1]
    assert "resume requires flipping the issue out of the blocked state" in tracker.comments[0][1]
    assert tracker.updated_comments[0][0] == "comment-1"
    run = store.get_run(accepted.run_id) or {}
    wait = run["payload"]["human_action_instructions"]["managed-run:wi-1:human_approval_required"]
    assert wait["linear_comment_id"] == "comment-1"
    ignored = ingest_managed_run_human_action_event(
        coordinator,
        accepted.run_id,
        {"event_type": "comment_created", "work_item_id": "wi-1", "linear_comment_id": "comment-99"},
    )
    assert ignored["applied"] is False
    assert ignored["reason"] == "comment_only_does_not_resume"
    assert store.list_work_items(accepted.run_id)[0]["state"] == WorkItemState.BLOCKED.value

    resumed = ingest_managed_run_human_action_event(
        coordinator,
        accepted.run_id,
        {
            "event_type": "state_changed",
            "work_item_id": "wi-1",
            "from_blocked_style": True,
            "to_blocked_style": False,
            "event_id": "state-flip-1",
        },
    )

    item = store.list_work_items(accepted.run_id)[0]
    assert resumed == {"applied": True, "reason": "state_flip_resumed"}
    assert item["state"] == WorkItemState.TODO.value
    assert item["gate_status"] == "human_approval_approved:state-flip-1"


async def test_managed_run_plan_approval_projects_root_instruction_and_ingests_state_flip(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan_requiring_approval(), backend_session_id="thread-1")
    tracker = Tracker()
    projector = ManagedRunLinearProjector(store=store, tracker=tracker, root_issue_id="root-1")

    await projector.reconcile_once(accepted.run_id)

    assert len(tracker.comments) == 1
    assert "structured_reason: plan_approval_required" in tracker.comments[0][1]
    assert "work_item_id: parent" in tracker.comments[0][1]
    run = store.get_run(accepted.run_id) or {}
    wait = run["payload"]["human_action_instructions"]["managed-run:plan:plan_approval_required"]
    assert wait["linear_issue_id"] == "root-1"
    assert run["state"] == "awaiting_approval"

    tracker.root_issue.update({"state": "In Progress", "state_type": "started"})
    await projector.reconcile_once(accepted.run_id)

    not_resumed = store.get_run(accepted.run_id) or {}
    assert not_resumed["state"] == "awaiting_approval"
    assert wait["expected_blocked_style"] is False

    await projector.reconcile_once(accepted.run_id)
    observed = store.get_run(accepted.run_id) or {}
    observed_wait = observed["payload"]["human_action_instructions"]["managed-run:plan:plan_approval_required"]
    assert observed_wait["expected_blocked_style"] is True

    tracker.root_issue.update({"state": "In Progress", "state_type": "started"})
    await projector.reconcile_once(accepted.run_id)

    resumed = store.get_run(accepted.run_id) or {}
    assert resumed["state"] == "ready"
    assert resumed["latest_reason"].startswith("plan_approved:linear_state_flip:")
    assert len(tracker.comments) == 1


async def test_managed_run_generic_blocked_work_item_projects_instruction_and_reopens_only_on_state_flip(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan_without_work_item_approval(), backend_session_id="thread-1")
    store.update_run_state(
        accepted.run_id,
        ManagedRunState.BLOCKED,
        active_work_item_id="wi-1",
        reason="verification_failed:smoke",
    )
    store.update_work_item_state(accepted.run_id, "wi-1", WorkItemState.BLOCKED, gate_status="verification_failed:smoke")
    tracker = Tracker()
    projector = ManagedRunLinearProjector(store=store, tracker=tracker, root_issue_id="root-1")

    await projector.reconcile_once(accepted.run_id)

    assert len(tracker.comments) == 1
    assert tracker.comments[0][0] == "child-1"
    assert "structured_reason: verification_failed:smoke" in tracker.comments[0][1]
    assert "required_action: correct the blocked work item, then flip this issue out of the blocked state" in tracker.comments[0][1]
    waiting = store.list_work_items(accepted.run_id)[0]
    assert waiting["state"] == WorkItemState.BLOCKED.value

    await projector.reconcile_once(accepted.run_id)
    tracker.children[0].update({"state": "In Progress", "state_type": "started"})
    await projector.reconcile_once(accepted.run_id)

    reopened = store.list_work_items(accepted.run_id)[0]
    run = store.get_run(accepted.run_id) or {}
    assert reopened["state"] == WorkItemState.TODO.value
    assert reopened["gate_status"].startswith("operator_reopened:linear_state_flip:")
    assert run["state"] == "ready"
    assert run["latest_reason"].startswith("operator_reopened:linear_state_flip:")


async def test_managed_run_generic_parent_block_retries_only_after_root_state_flip(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    store.update_run_state(
        accepted.run_id,
        ManagedRunState.BLOCKED,
        reason="plan_validation_retries_exhausted:missing_green_commands",
    )
    tracker = Tracker()
    projector = ManagedRunLinearProjector(store=store, tracker=tracker, root_issue_id="root-1")

    await projector.reconcile_once(accepted.run_id)

    assert len(tracker.comments) == 1
    assert tracker.comments[0][0] == "root-1"
    assert "structured_reason: plan_validation_retries_exhausted:missing_green_commands" in tracker.comments[0][1]

    await projector.reconcile_once(accepted.run_id)
    tracker.root_issue.update({"state": "In Progress", "state_type": "started"})
    await projector.reconcile_once(accepted.run_id)

    reopened = store.get_run(accepted.run_id) or {}
    assert reopened["state"] == "planning"
    assert reopened["latest_reason"].startswith("operator_reopened:linear_state_flip:")


async def test_runtime_wait_projects_child_issue_and_resumes_only_after_child_completion(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan_without_work_item_approval(), backend_session_id="thread-1")
    wait_id = "runtime-wait-1"
    store.merge_run_payload(
        accepted.run_id,
        {
            "runtime_waits": [
                {
                    "wait_id": wait_id,
                    "run_id": accepted.run_id,
                    "work_item_id": "wi-1",
                    "attempt_id": "attempt-1",
                    "lease_id": "lease-1",
                    "turn_id": "turn-1",
                    "wait_kind": "approval_requested",
                    "sanitized_message": "Approve the requested runtime action.",
                    "status": "waiting",
                }
            ]
        },
    )
    store.update_run_state(accepted.run_id, ManagedRunState.BLOCKED, active_work_item_id="wi-1", reason=f"runtime_wait:{wait_id}")
    store.update_work_item_state(accepted.run_id, "wi-1", WorkItemState.BLOCKED, gate_status=f"runtime_wait:{wait_id}")
    tracker = Tracker()
    projector = ManagedRunLinearProjector(store=store, tracker=tracker, root_issue_id="root-1")

    await projector.reconcile_once(accepted.run_id)

    run = store.get_run(accepted.run_id) or {}
    projection = store.list_linear_projections(accepted.run_id)[0]["metadata"]
    wait = run["payload"]["runtime_waits"][0]
    assert len(tracker.children) == 2
    assert tracker.children[1]["title"] == "[Human Action] Runtime wait: approval_requested"
    assert any(marker == "SYMPHONY RUNTIME WAIT" and issue_id == "child-2" for issue_id, marker, _ in tracker.description_blocks)
    assert tracker.comments == []
    assert wait["child_issue_id"] == "child-2"
    assert projection["operator_status"] == "waiting_for_runtime_input"
    assert projection["operator_wait_kind"] == "approval_requested"
    assert projection["runtime_wait_id"] == wait_id

    tracker.children[1].update({"state": "Done", "state_type": "completed"})
    await projector.reconcile_once(accepted.run_id)

    resumed = store.get_run(accepted.run_id) or {}
    item = store.list_work_items(accepted.run_id)[0]
    resolved_wait = resumed["payload"]["runtime_waits"][0]
    assert resolved_wait["status"] == "resolved"
    assert resolved_wait["resolution"] == "child_completed"
    assert item["state"] == WorkItemState.TODO.value
    assert item["gate_status"] == f"runtime_wait_resolved:{wait_id}"
    assert resumed["state"] == ManagedRunState.READY.value


async def test_plan_revision_state_flip_starts_isolated_revision_planning(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan_without_work_item_approval(), backend_session_id="thread-1")
    coordinator.start_work_item(accepted.run_id, "wi-1")
    coordinator.submit_work_item_result(
        accepted.run_id,
        WorkItemResult(
            work_item_id="wi-1",
            status_claimed=WorkItemResultStatus.PLAN_REVISION_REQUESTED,
            changed_files=[],
            undeclared_files=[],
            tests={},
            acceptance_results=[],
            blocked_reason=None,
            plan_revision={"reason": "need a new work item"},
            notes="request revision",
        ),
    )
    tracker = Tracker()
    projector = ManagedRunLinearProjector(store=store, tracker=tracker, root_issue_id="root-1")

    await projector.reconcile_once(accepted.run_id)
    await projector.reconcile_once(accepted.run_id)
    tracker.children[0].update({"state": "In Progress", "state_type": "started"})
    await projector.reconcile_once(accepted.run_id)

    item = store.list_work_items(accepted.run_id)[0]
    run = store.get_run(accepted.run_id) or {}
    wait = run["payload"]["human_action_instructions"]["managed-run:wi-1:plan_revision_requested"]
    assert item["state"] == WorkItemState.BLOCKED.value
    assert item["gate_status"].startswith("plan_revision_planning:linear_state_flip:")
    assert run["state"] == ManagedRunState.PLANNING.value
    assert run["plan_version"] == 1
    assert wait["last_state_flip"]["applied"] is True
    assert wait["last_state_flip"]["reason"] == "state_flip_resumed"
    assert run["payload"]["approved_plan_revision"]["work_item_id"] == "wi-1"


def _plan_requiring_approval() -> ManagedRunPlan:
    return ManagedRunPlan.from_dict({**_approval_plan().to_dict(), "approval_required": True})


def _plan_without_work_item_approval() -> ManagedRunPlan:
    plan = _approval_plan().to_dict()
    item = {**plan["work_items"][0], "needs_human_approval": False}
    return ManagedRunPlan.from_dict({**plan, "work_items": [item]})


def _approval_plan() -> ManagedRunPlan:
    item = WorkItem(
        id="wi-1",
        title="Implement approval",
        objective="Wait for operator approval",
        slice_type=WorkItemSliceType.VERTICAL,
        acceptance_criteria=["operator approved"],
        verification=WorkItemVerification(red_command="pytest -q", green_commands=["pytest -q"]),
        dependencies=[],
        estimated_scope="S",
        files_likely_touched=["src/approval.py"],
        parallelization=ParallelizationPolicy(safe_to_parallelize=False, reason="human approval"),
        needs_human_approval=True,
    )
    return ManagedRunPlan(
        summary="Approval plan",
        architecture_decisions=["Wait for a state flip"],
        work_items=[item],
        checkpoints=[],
        verification_rubric=VerificationRubric(
            correctness=["approved"],
            quality=["visible"],
            integration=["resumable"],
            documentation=["projected"],
            ship_readiness=["operator clear"],
        ),
        risks=[],
        open_questions=[],
        approval_required=False,
    )
