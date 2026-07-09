from __future__ import annotations

from conductor.conductor_managed_run_coordinator import ConductorManagedRunCoordinator
from conductor.conductor_managed_run_projection import ManagedRunLinearProjector
from conductor.conductor_managed_run_store import ConductorManagedRunStore
from performer_api.managed_runs import (
    ManagedRunState,
    ManagedRunPlan,
    ParallelizationPolicy,
    ThreadCompletionReport,
    VerificationRubric,
    WorkItem,
    WorkItemSliceType,
    WorkItemState,
    WorkItemVerification,
)


class Tracker:
    def __init__(self) -> None:
        self.children: list[dict[str, object]] = []
        self.description_blocks: list[tuple[str, str, str]] = []
        self.transitions: list[tuple[str, list[str], str]] = []
        self.comments: list[tuple[str, str]] = []
        self.updated_comments: list[tuple[str, str]] = []
        self.relations: list[tuple[str, str, str]] = []

    async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
        return [
            child
            for child in self.children
            if child.get("parent_issue_id") == parent_issue_id
            and (label_name is None or label_name in child.get("labels", []))
        ]

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
            "identifier": f"HELL-{len(self.children) + 10}",
            "parent_issue_id": parent_issue_id,
            "title": title,
            "description": description,
            "labels": list(label_names),
            "delegate_id": delegate_id,
        }
        self.children.append(child)
        return child

    async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
        self.description_blocks.append((issue_id, marker_name, block))
        return {"success": True}

    async def transition_issue_by_state_target(self, issue_id: str, *, names: list[str], state_type: str) -> dict[str, object]:
        self.transitions.append((issue_id, list(names), state_type))
        return {"success": True}

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, object]:
        self.comments.append((issue_id, body))
        return {"success": True, "comment_id": f"comment-{len(self.comments)}"}

    async def update_issue_comment(self, comment_id: str, body: str) -> dict[str, object]:
        self.updated_comments.append((comment_id, body))
        return {"success": True, "comment_id": comment_id, "body": body}

    async def ensure_issue_relation(self, *, issue_id: str, related_issue_id: str, relation_type: str) -> dict[str, object]:
        self.relations.append((issue_id, related_issue_id, relation_type))
        return {"success": True, "id": f"relation-{len(self.relations)}"}


def _plan() -> ManagedRunPlan:
    return ManagedRunPlan(
        summary="ManagedRun run",
        architecture_decisions=["Linear is projection"],
        work_items=[
            WorkItem(
                id="wi-1",
                title="Add projector",
                objective="Project one work item",
                slice_type=WorkItemSliceType.VERTICAL,
                acceptance_criteria=["child issue exists"],
                verification=WorkItemVerification(red_command="pytest tests/test_conductor_managed_run_projection.py -q", green_commands=["pytest tests/test_conductor_managed_run_projection.py -q"]),
                dependencies=[],
                estimated_scope="S",
                files_likely_touched=["packages/conductor/src/conductor/conductor_managed_run_projection.py"],
                parallelization=ParallelizationPolicy(safe_to_parallelize=False, reason="single writer"),
            )
        ],
        checkpoints=[],
        verification_rubric=VerificationRubric(
            correctness=["child issue exists"],
            quality=["managed block only"],
            integration=["projection records durable ids"],
            documentation=["Linear surfaces updated"],
            ship_readiness=["readable summary"],
        ),
        risks=[],
        open_questions=[],
        approval_required=False,
    )


async def test_managed_run_projector_creates_child_issue_and_parent_summary(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    tracker = Tracker()

    projected = await ManagedRunLinearProjector(store=store, tracker=tracker, root_issue_id="root-1").reconcile_once(accepted.run_id)

    assert projected == 3
    assert tracker.children[0]["parent_issue_id"] == "root-1"
    assert "Objective: Project one work item" in str(tracker.children[0]["description"])
    assert "Managed Run State:" in str(tracker.children[0]["description"])
    assert "ManagedRun State:" not in str(tracker.children[0]["description"])
    assert ("child-1", ["Todo"], "unstarted") in tracker.transitions
    assert any(issue_id == "root-1" and marker == "SYMPHONY RUN SUMMARY" for issue_id, marker, _ in tracker.description_blocks)
    assert store.list_linear_projections(accepted.run_id)[0]["linear_issue_id"] == "child-1"


async def test_managed_run_projector_maps_child_lifecycle_states(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    store.update_work_item_state(accepted.run_id, "wi-1", WorkItemState.IN_REVIEW, gate_status="checking")
    tracker = Tracker()

    await ManagedRunLinearProjector(store=store, tracker=tracker, root_issue_id="root-1").reconcile_once(accepted.run_id)

    assert ("child-1", ["In Review"], "started") in tracker.transitions


async def test_managed_run_projector_projects_blocked_reason_to_work_item_issue(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    store.update_work_item_state(accepted.run_id, "wi-1", WorkItemState.BLOCKED, gate_status="verification_failed:smoke")
    tracker = Tracker()

    await ManagedRunLinearProjector(store=store, tracker=tracker, root_issue_id="root-1").reconcile_once(accepted.run_id)

    assert ("child-1", ["Blocked", "Needs More"], "unstarted") in tracker.transitions
    assert any("verification_failed:smoke" in block for _, marker, block in tracker.description_blocks if marker == "SYMPHONY WORK ITEM")


async def test_managed_run_projector_parent_summary_includes_run_level_blocked_reason(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    store.update_run_state(accepted.run_id, ManagedRunState.BLOCKED, reason="plan_validation_retries_exhausted:work_item_too_large")
    tracker = Tracker()

    await ManagedRunLinearProjector(store=store, tracker=tracker, root_issue_id="root-1").reconcile_once(accepted.run_id)

    assert any(
        marker == "SYMPHONY RUN SUMMARY" and "plan_validation_retries_exhausted:work_item_too_large" in block
        for _, marker, block in tracker.description_blocks
    )


def test_managed_run_projector_renders_completion_report_summary_block() -> None:
    report = ThreadCompletionReport(
        status="verified",
        thread_id="thread-1",
        plan_version=1,
        what_this_thread_did=["executed wi-1"],
        files_changed=[{"path": "src/a.py", "action": "modified", "work_item_id": "wi-1", "reason": "acceptance"}],
        rubric_results=[{"area": "correctness", "status": "passed", "evidence": ["tests passed"]}],
        token_usage=[{"turn": "wi-1", "input_tokens": 1, "cached_input_tokens": 0, "output_tokens": 2, "reasoning_output_tokens": 0}],
        residual_risks=[],
    )

    block = ManagedRunLinearProjector.render_parent_summary(report)

    assert "<!-- symphony:run-summary:start -->" in block
    assert "`src/a.py`" in block
    assert "| wi-1 | 1 | 0 | 2 | 0 |" in block


def test_managed_run_projector_summary_uses_plan_rubric_and_residual_risks(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    plan = ManagedRunPlan.from_dict(
        {
            **_plan().to_dict(),
            "risks": [{"summary": "manual deployment remains"}],
        }
    )
    coordinator.apply_plan(accepted.run_id, plan, backend_session_id="thread-1")
    store.update_run_state(accepted.run_id, ManagedRunState.DONE)
    projector = ManagedRunLinearProjector(store=store, tracker=Tracker(), root_issue_id="root-1")

    report = projector._current_report(accepted.run_id, store.get_run(accepted.run_id) or {})

    assert [item["area"] for item in report.rubric_results] == [
        "correctness",
        "quality",
        "integration",
        "documentation",
        "ship_readiness",
    ]
    assert all(item["status"] == "passed" for item in report.rubric_results)
    assert report.residual_risks == ["manual deployment remains"]


def test_managed_run_projector_summary_includes_checkpoint_evidence(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    plan = ManagedRunPlan.from_dict(
        {
            **_plan().to_dict(),
            "checkpoints": [{"after": ["wi-1"], "verify": ["pytest -q"]}],
        }
    )
    coordinator.apply_plan(accepted.run_id, plan, backend_session_id="thread-1")
    store.record_checkpoint_result(
        accepted.run_id,
        after=["wi-1"],
        verify=["pytest -q"],
        passed=True,
        reason="pytest -q passed",
    )
    store.update_run_state(accepted.run_id, ManagedRunState.DONE)
    projector = ManagedRunLinearProjector(store=store, tracker=Tracker(), root_issue_id="root-1")

    report = projector._current_report(accepted.run_id, store.get_run(accepted.run_id) or {})

    assert any("checkpoint_passed:wi-1:pytest -q:pytest -q passed" in item["evidence"] for item in report.rubric_results)


async def test_managed_run_projector_finalizes_verified_run_after_parent_summary(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    store.update_work_item_state(accepted.run_id, "wi-1", WorkItemState.DONE, gate_status="verification passed")
    store.update_run_state(accepted.run_id, ManagedRunState.VERIFIED, reason="awaiting_final_projection")
    tracker = Tracker()

    await ManagedRunLinearProjector(store=store, tracker=tracker, root_issue_id="root-1").reconcile_once(accepted.run_id)

    finalized = store.get_run(accepted.run_id)
    assert finalized is not None
    assert finalized["state"] == ManagedRunState.DONE.value
    assert finalized["latest_reason"] == "final summary projected"
    report = finalized["payload"]["final_completion_report"]
    assert report["status"] == ManagedRunState.VERIFIED.value
    assert [item["area"] for item in report["rubric_results"]] == [
        "correctness",
        "quality",
        "integration",
        "documentation",
        "ship_readiness",
    ]
    assert {item["status"] for item in report["rubric_results"]} == {"passed"}
    assert "Run is not complete." not in report["residual_risks"]
    assert any(
        marker == "SYMPHONY RUN SUMMARY" and "| correctness | passed |" in block
        for _, marker, block in tracker.description_blocks
    )


async def test_managed_run_projector_projects_attempt_comment_by_durable_comment_id(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    store.merge_run_payload(
        accepted.run_id,
        {
            "completed_attempts": [
                {
                    "attempt_id": "attempt-wi-1",
                    "kind": "work_item",
                    "mode": "execute",
                    "work_item_id": "wi-1",
                    "state": "succeeded",
                    "thread_id": "thread-1",
                    "request_path": "/tmp/request.json",
                    "result_path": "/tmp/result.json",
                    "started_at": "2026-07-09T00:00:00Z",
                    "completed_at": "2026-07-09T00:01:00Z",
                    "events": [{"event": "turn_completed", "message": "ok"}],
                }
            ]
        },
    )
    tracker = Tracker()
    projector = ManagedRunLinearProjector(store=store, tracker=tracker, root_issue_id="root-1")

    await projector.reconcile_once(accepted.run_id)
    await projector.reconcile_once(accepted.run_id)

    assert len(tracker.comments) == 1
    assert tracker.comments[0][0] == "child-1"
    assert "attempt_id: attempt-wi-1" in tracker.comments[0][1]
    assert "attempt_state: succeeded" in tracker.comments[0][1]
    assert "backend_thread_id: thread-1" in tracker.comments[0][1]
    assert "result_path: `/tmp/result.json`" in tracker.comments[0][1]
    assert "<!--" not in tracker.comments[0][1]
    assert tracker.updated_comments and tracker.updated_comments[0][0] == "comment-1"
    run = store.get_run(accepted.run_id)
    assert run is not None
    mapping = run["payload"]["attempt_comment_projections"]["attempt-wi-1"]
    assert mapping["linear_comment_id"] == "comment-1"
    assert mapping["work_item_id"] == "wi-1"


async def test_managed_run_projector_projects_plan_execute_and_verify_attempt_comments(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    store.merge_run_payload(
        accepted.run_id,
        {
            "completed_attempts": [
                {"attempt_id": "attempt-plan", "kind": "plan", "state": "succeeded", "thread_id": "thread-1"},
                {"attempt_id": "attempt-execute", "kind": "work_item", "mode": "execute", "work_item_id": "wi-1", "state": "succeeded"},
                {"attempt_id": "attempt-verify", "kind": "verify", "mode": "verify", "work_item_id": "wi-1", "state": "succeeded", "verify_score": 3},
            ]
        },
    )
    tracker = Tracker()
    projector = ManagedRunLinearProjector(store=store, tracker=tracker, root_issue_id="root-1")

    await projector.reconcile_once(accepted.run_id)
    await projector.reconcile_once(accepted.run_id)

    assert len(tracker.comments) == 3
    assert tracker.comments[0][0] == "root-1"
    assert "attempt_id: attempt-plan" in tracker.comments[0][1]
    assert {issue_id for issue_id, body in tracker.comments if "attempt-execute" in body or "attempt-verify" in body} == {"child-1"}
    assert any("verify_score: 3" in body for _, body in tracker.comments)
    assert len(tracker.updated_comments) == 3
    mappings = (store.get_run(accepted.run_id) or {})["payload"]["attempt_comment_projections"]
    assert sorted(mappings) == ["attempt-execute", "attempt-plan", "attempt-verify"]


async def test_managed_run_projector_projects_dependency_blocks_and_operator_metadata(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    base = _plan()
    dependent = WorkItem.from_dict(
        {
            **base.work_items[0].to_dict(),
            "id": "wi-2",
            "title": "Add dependent projection",
            "dependencies": ["wi-1"],
            "files_likely_touched": ["packages/conductor/src/conductor/conductor_managed_run_projection.py"],
        }
    )
    plan = ManagedRunPlan.from_dict({**base.to_dict(), "work_items": [base.work_items[0].to_dict(), dependent.to_dict()]})
    coordinator.apply_plan(accepted.run_id, plan, backend_session_id="thread-1")
    store.merge_run_payload(
        accepted.run_id,
        {
            "active_attempts": [
                {
                    "attempt_id": "attempt-wi-2",
                    "kind": "work_item",
                    "work_item_id": "wi-2",
                    "state": "running",
                }
            ],
            "last_managed_run_policy_id": "policy-group-1",
            "last_managed_run_policy_version": 4,
        },
    )
    tracker = Tracker()

    await ManagedRunLinearProjector(store=store, tracker=tracker, root_issue_id="root-1").reconcile_once(accepted.run_id)

    assert ("child-1", "child-2", "blocks") in tracker.relations
    projection = {item["work_item_id"]: item for item in store.list_linear_projections(accepted.run_id)}["wi-2"]
    metadata = projection["metadata"]
    assert metadata["parent_issue_id"] == "root-1"
    assert metadata["plan_version"] == 1
    assert metadata["active_policy_id"] == "policy-group-1"
    assert metadata["active_policy_version"] == 4
    assert metadata["operator_status"] == "todo"
    assert metadata["work_item_attempt_ids"] == ["attempt-wi-2"]
    assert metadata["linear_projection_id"] == projection["projection_id"]
