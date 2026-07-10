from __future__ import annotations

import json
from pathlib import Path

import pytest

from performer.cli import _runtime_wait_from_events, run_managed_run_turn
from performer.codex_client_sdk_events import _sdk_event_to_dict
from performer_api.managed_runs import (
    ManagedRunPlan,
    ManagedRunTurnContext,
    ParallelizationPolicy,
    VerificationRubric,
    WorkItem,
    WorkItemSliceType,
    WorkItemVerification,
)


class FakeCodexClient:
    def __init__(self) -> None:
        self.calls = 0

    async def run_session(self, _workspace_path: Path, _prompt: str, _title: str, **_kwargs):
        self.calls += 1
        return type(
            "Result",
            (),
            {"thread_id": "thread-1", "structured_result": _plan().to_dict(), "events": [{"event": "turn_completed"}]},
        )()


class FakeWorkItemCodexClient:
    def __init__(self, events: list[dict]) -> None:
        self.events = events

    async def run_session(self, _workspace_path: Path, _prompt: str, _title: str, **_kwargs):
        return type(
            "Result",
            (),
            {"thread_id": "thread-1", "structured_result": _work_item_result(), "events": self.events},
        )()


async def test_performer_echoes_validated_fenced_turn_context(tmp_path: Path) -> None:
    request_path = tmp_path / "turn-request.json"
    result_path = tmp_path / "turn-result.json"
    context = ManagedRunTurnContext(
        run_id="run-1",
        work_item_id="",
        policy_revision=1,
        plan_version=0,
        lease_id="lease-1",
        fencing_token="fence-1",
        turn_id="turn-1",
    )
    request_path.write_text(
        json.dumps(
            {
                "turn_kind": "plan",
                "workspace_path": str(tmp_path),
                "issue_description": "Create a plan",
                "context": context.to_dict(),
            }
        ),
        encoding="utf-8",
    )

    result = await run_managed_run_turn(request_path, result_path, codex_client=FakeCodexClient())

    assert result["context"] == context.to_dict()
    assert json.loads(result_path.read_text(encoding="utf-8"))["context"] == context.to_dict()


async def test_performer_rejects_missing_fenced_turn_context(tmp_path: Path) -> None:
    request_path = tmp_path / "turn-request.json"
    result_path = tmp_path / "turn-result.json"
    request_path.write_text(
        json.dumps({"turn_kind": "plan", "workspace_path": str(tmp_path), "issue_description": "Create a plan"}),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="managed_run_turn_context_invalid:run_id_required"):
        await run_managed_run_turn(request_path, result_path, codex_client=FakeCodexClient())

    assert not result_path.exists()


async def test_performer_rejects_work_item_context_for_a_different_work_item(tmp_path: Path) -> None:
    request_path = tmp_path / "turn-request.json"
    result_path = tmp_path / "turn-result.json"
    context = ManagedRunTurnContext(
        run_id="run-1",
        work_item_id="wi-other",
        policy_revision=1,
        plan_version=1,
        lease_id="lease-1",
        fencing_token="fence-1",
        turn_id="turn-1",
    )
    request_path.write_text(
        json.dumps(
            {
                "turn_kind": "work_item",
                "workspace_path": str(tmp_path),
                "thread_id": "thread-1",
                "context": context.to_dict(),
                "work_item": _plan().work_items[0].to_dict(),
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="managed_run_turn_context_work_item_mismatch"):
        await run_managed_run_turn(request_path, result_path, codex_client=FakeCodexClient())

    assert not result_path.exists()


async def test_performer_emits_a_structured_runtime_wait_probe_once_requested(tmp_path: Path) -> None:
    request_path = tmp_path / "turn-request.json"
    result_path = tmp_path / "turn-result.json"
    context = ManagedRunTurnContext(
        run_id="run-1",
        work_item_id="wi-1",
        policy_revision=1,
        plan_version=1,
        lease_id="lease-1",
        fencing_token="fence-1",
        turn_id="turn-1",
    )
    request_path.write_text(
        json.dumps(
            {
                "turn_kind": "work_item",
                "workspace_path": str(tmp_path),
                "thread_id": "thread-1",
                "context": context.to_dict(),
                "work_item": _plan().work_items[0].to_dict(),
                "runtime_wait_probe": True,
            }
        ),
        encoding="utf-8",
    )
    client = FakeCodexClient()

    result = await run_managed_run_turn(request_path, result_path, codex_client=client)

    assert result["context"] == context.to_dict()
    assert result["runtime_wait"] == {
        "wait_kind": "approval_requested",
        "message": "Symphony runtime wait probe requires approval.",
    }
    assert client.calls == 0


@pytest.mark.parametrize(
    ("event", "expected"),
    [
        (
            {
                "event": "sdk_item_autoApprovalReview_started",
                "payload": {
                    "type": "item/autoApprovalReview/started",
                    "reviewId": "review-1",
                    "action": {"type": "requestPermissions", "reason": "Need workspace permission."},
                },
            },
            {"wait_kind": "permission_required", "message": "Need workspace permission."},
        ),
        (
            {
                "event": "sdk_item_commandExecution_terminalInteraction",
                "payload": {"type": "item/commandExecution/terminalInteraction", "stdin": "Enter value:"},
            },
            {"wait_kind": "tool_input_required", "message": "Enter value:"},
        ),
        (
            {"event": "sdk_guardianWarning", "payload": {"type": "guardianWarning", "message": "Network policy denied."}},
            {"wait_kind": "permission_required", "message": "Network policy denied."},
        ),
    ],
)
def test_performer_recognizes_explicit_codex_runtime_wait_events(event: dict, expected: dict) -> None:
    wait = _runtime_wait_from_events([event])

    assert wait is not None
    assert wait.to_dict() == expected


def test_performer_preserves_runtime_wait_data_from_sdk_jsonrpc_notification() -> None:
    event = _sdk_event_to_dict(
        {
            "method": "item/autoApprovalReview/started",
            "params": {
                "reviewId": "review-1",
                "action": {"type": "requestPermissions", "reason": "Need workspace permission."},
            },
        }
    )

    assert event is not None
    assert event["event"] == "sdk_item_autoApprovalReview_started"
    assert _runtime_wait_from_events([event]).to_dict() == {
        "wait_kind": "permission_required",
        "message": "Need workspace permission.",
    }


def test_performer_ignores_a_completed_codex_approval_review() -> None:
    wait = _runtime_wait_from_events(
        [
            {
                "event": "sdk_item_autoApprovalReview_started",
                "message": "Approval required.",
                "payload": {"type": "item/autoApprovalReview/started", "reviewId": "review-1"},
            },
            {
                "event": "sdk_item_autoApprovalReview_completed",
                "payload": {"type": "item/autoApprovalReview/completed", "reviewId": "review-1"},
            },
        ]
    )

    assert wait is None


async def test_performer_keeps_completed_work_item_result_after_approval_event(tmp_path: Path) -> None:
    request_path = tmp_path / "turn-request.json"
    result_path = tmp_path / "turn-result.json"
    context = ManagedRunTurnContext(
        run_id="run-1",
        work_item_id="wi-1",
        policy_revision=1,
        plan_version=1,
        lease_id="lease-1",
        fencing_token="fence-1",
        turn_id="turn-1",
    )
    request_path.write_text(
        json.dumps(
            {
                "turn_kind": "work_item",
                "workspace_path": str(tmp_path),
                "thread_id": "thread-1",
                "context": context.to_dict(),
                "work_item": _plan().work_items[0].to_dict(),
            }
        ),
        encoding="utf-8",
    )
    client = FakeWorkItemCodexClient(
        [
            {
                "event": "sdk_item_autoApprovalReview_started",
                "message": "Approval required.",
                "payload": {"type": "item/autoApprovalReview/started", "reviewId": "review-1"},
            }
        ]
    )

    result = await run_managed_run_turn(request_path, result_path, codex_client=client)

    assert result["result"] == _work_item_result()
    assert "runtime_wait" not in result


def _plan() -> ManagedRunPlan:
    return ManagedRunPlan(
        summary="Create a plan",
        architecture_decisions=["Use one work item"],
        work_items=[
            WorkItem(
                id="wi-1",
                title="Implement context",
                objective="Carry the fenced context",
                slice_type=WorkItemSliceType.CONTRACT_FIRST,
                acceptance_criteria=["context echoes"],
                verification=WorkItemVerification(red_command="pytest -q", green_commands=["pytest -q"]),
                dependencies=[],
                estimated_scope="S",
                files_likely_touched=["packages/performer/src/performer/cli.py"],
                parallelization=ParallelizationPolicy(safe_to_parallelize=False, reason="shared turn contract"),
            )
        ],
        checkpoints=[],
        verification_rubric=VerificationRubric(
            correctness=["context validates"],
            quality=["no implicit defaults"],
            integration=["Conductor can compare the result"],
            documentation=["turn contract is visible"],
            ship_readiness=["stale results reject"],
        ),
        risks=[],
        open_questions=[],
        approval_required=False,
    )


def _work_item_result() -> dict:
    return {
        "work_item_id": "wi-1",
        "status_claimed": "ready_for_review",
        "changed_files": [],
        "undeclared_files": [],
        "tests": {
            "red_command": "pytest -q",
            "red_observed": True,
            "green_commands_run": ["pytest -q"],
            "secret_scan_passed": True,
        },
        "acceptance_results": [{"criterion": "context echoes", "status": "passed", "evidence": "pytest passed"}],
        "blocked_reason": None,
        "plan_revision": None,
        "notes": "ready",
    }
