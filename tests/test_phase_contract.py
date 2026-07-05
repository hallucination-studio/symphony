from __future__ import annotations

from performer_api.phase import PhaseAdvanceRequest, PhaseAdvanceResult, RunPhase


def test_phase_advance_request_round_trips_json_ready_payload() -> None:
    request = PhaseAdvanceRequest(
        run_id="run-1",
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        current_phase=RunPhase.QUEUED,
        attempt=2,
        human_response="Use option B",
        workflow_profile="gated-task",
        workspace_context={"workspace_root": "/tmp/workspaces"},
    )

    payload = request.to_dict()
    loaded = PhaseAdvanceRequest.from_dict(payload)

    assert payload == {
        "run_id": "run-1",
        "instance_id": "inst-1",
        "issue_id": "issue-1",
        "issue_identifier": "ENG-1",
        "current_phase": "queued",
        "attempt": 2,
        "human_response": "Use option B",
        "workflow_profile": "gated-task",
        "workspace_context": {"workspace_root": "/tmp/workspaces"},
    }
    assert loaded == request


def test_phase_advance_result_round_trips_human_action_metadata() -> None:
    result = PhaseAdvanceResult(
        run_id="run-1",
        issue_id="issue-1",
        next_phase=RunPhase.AWAITING_HUMAN,
        status="awaiting_human",
        reason="needs clarification",
        retry_delay_seconds=30,
        human_action={
            "child_issue_id": "child-1",
            "child_identifier": "ENG-2",
            "child_url": "https://linear.test/ENG-2",
        },
        workspace_path="/tmp/workspace/ENG-1",
        ops_snapshot_path="/tmp/ops.json",
    )

    payload = result.to_dict()
    loaded = PhaseAdvanceResult.from_dict(payload)

    assert payload["next_phase"] == "awaiting_human"
    assert payload["human_action"]["child_identifier"] == "ENG-2"
    assert loaded == result


def test_phase_advance_result_round_trips_init_failed_status() -> None:
    result = PhaseAdvanceResult(
        run_id="run-1",
        issue_id="issue-1",
        next_phase=RunPhase.QUEUED,
        status="init_failed",
        reason="codex init failed repeatedly",
        retry_delay_seconds=15,
    )

    payload = result.to_dict()
    loaded = PhaseAdvanceResult.from_dict(payload)

    assert payload["status"] == "init_failed"
    assert loaded == result
