from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from threading import Event

import pytest

from performer.backends.provider_backend_interface import (
    ProviderBackendError,
    ProviderStageCanceled,
)
from performer.stage_execution.runtime import StageExecutionRuntime
from performer.stage_protocol.host import StageFileHost


FIXTURE = Path(__file__).parents[3] / "packages/contracts/fixtures/cross-language/valid/stage-context.json"


def plan_envelope() -> dict[str, object]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))["value"]


def work_envelope() -> dict[str, object]:
    value = plan_envelope()
    value["stage_execution"] = {
        "stage_execution_id": "execution-work-1",
        "stage": "work",
        "started_at": "2026-07-21T09:00:00Z",
        "deadline_at": "2026-07-21T10:00:00Z",
    }
    value["target"] = {
        "root_issue_id": "root-1",
        "cycle_issue_id": "cycle-1",
        "node_issue_id": "work-1",
        "plan_contract_digest": "plan-digest-1",
    }
    value["execution_policy"] = {
        **value["execution_policy"],
        "sandbox_mode": "workspace_write",
    }
    value["repository_context"] = {
        **value["repository_context"],
        "workspace_access": "read_write",
    }
    value["workflow_context"] = {
        "root_boundary": {
            "root_issue_id": "root-1",
            "objective_summary": "Implement the Stage runtime.",
            "included_scope": ["apps/performer"],
            "excluded_scope": [],
            "relevant_acceptance_criteria": [{
                "criterion_key": "stage",
                "statement": "One Stage executes once.",
                "verification_method": "runtime test",
            }],
        },
        "work_node": {
            "issue_id": "work-1",
            "work_key": "stage-runtime",
            "title": "Implement runtime",
            "description": "Implement one bounded Stage.",
            "acceptance_criteria": [{
                "criterion_key": "stage",
                "statement": "One Stage executes once.",
                "verification_method": "runtime test",
            }],
            "relevant_comments": [],
            "remote_version": "work-version-1",
        },
        "dependency_state": [],
        "resolved_human_input": [],
        "git_baseline": {
            "head_revision": "git-base-1",
            "status_summary": "clean",
        },
    }
    return value


def completed_plan() -> dict[str, object]:
    return {
        "kind": "plan_completed",
        "plan_contract": {
            "objective_summary": "Deliver the Stage runtime.",
            "included_scope": ["apps/performer"],
            "excluded_scope": [],
            "acceptance_criteria": [{
                "criterion_key": "stage",
                "statement": "One Stage executes once.",
                "verification_method": "runtime test",
            }],
            "work_nodes": [],
            "verify_node": {
                "title": "Verify the Stage runtime",
                "acceptance_criteria": [{
                    "criterion_key": "runtime",
                    "statement": "The runtime is bounded.",
                    "verification_method": "runtime test",
                }],
                "required_checks": [],
            },
        },
    }


class FakeStageBackend:
    def __init__(self, outcome: dict[str, object] | None = None, error: Exception | None = None):
        self.calls: list[tuple[dict[str, object], Path, Event]] = []
        self.outcome = outcome or {"outcome": completed_plan()}
        self.error = error

    def execute_stage(
        self,
        envelope: dict[str, object],
        workspace_root: Path,
        cancel_event: Event,
    ) -> dict[str, object]:
        self.calls.append((envelope, workspace_root, cancel_event))
        if self.error is not None:
            raise self.error
        return self.outcome


def test_stage_runtime_executes_one_fresh_plan_and_returns_one_terminal_result(tmp_path: Path):
    backend = FakeStageBackend()
    events: list[dict[str, object]] = []

    result = StageExecutionRuntime(backend).run(
        plan_envelope(), tmp_path, emit_event=events.append
    )

    assert len(backend.calls) == 1
    assert backend.calls[0][1] == tmp_path
    assert result["stage_execution_id"] == "execution-1"
    assert result["outcome"] == completed_plan()
    assert events[0]["body"] == {"kind": "started"}
    assert events[-1]["body"] == {"kind": "heartbeat"}


def test_stage_runtime_keeps_terminal_result_when_event_sink_fails(tmp_path: Path):
    def broken_sink(_: dict[str, object]) -> None:
        raise OSError("stdout closed")

    result = StageExecutionRuntime(FakeStageBackend()).run(
        plan_envelope(), tmp_path, emit_event=broken_sink
    )

    assert result["outcome"] == completed_plan()


def test_plan_rejects_write_capability_before_provider(tmp_path: Path):
    envelope = plan_envelope()
    envelope["execution_policy"] = {**envelope["execution_policy"], "sandbox_mode": "workspace_write"}
    envelope["repository_context"] = {**envelope["repository_context"], "workspace_access": "read_write"}
    backend = FakeStageBackend()

    result = StageExecutionRuntime(backend).run(envelope, tmp_path)

    assert backend.calls == []
    assert result["outcome"] == {
        "kind": "execution_failed",
        "error_code": "stage_capability_invalid",
        "sanitized_reason": "The Stage capability does not match its stage.",
        "retryable": False,
    }


def test_work_requires_and_receives_only_the_supplied_write_capability(tmp_path: Path):
    backend = FakeStageBackend({
        "outcome": {
            "kind": "work_completed",
            "summary": "Work completed.",
            "changed_paths": [],
            "checks": [],
            "observed_workspace_revision": "git-base-1",
        },
    })

    result = StageExecutionRuntime(backend).run(work_envelope(), tmp_path)

    assert len(backend.calls) == 1
    assert result["outcome"]["kind"] == "work_completed"


@pytest.mark.parametrize(
    ("error", "outcome"),
    [
        (
            ProviderStageCanceled(),
            {"kind": "canceled", "sanitized_reason": "The Stage was canceled."},
        ),
        (
            ProviderBackendError("provider unavailable", code="provider_unavailable"),
            {
                "kind": "execution_failed",
                "error_code": "provider_unavailable",
                "sanitized_reason": "provider unavailable",
                "retryable": True,
            },
        ),
    ],
)
def test_stage_runtime_maps_provider_failures_to_closed_outcomes(
    tmp_path: Path, error: Exception, outcome: dict[str, object]
):
    result = StageExecutionRuntime(FakeStageBackend(error=error)).run(plan_envelope(), tmp_path)

    assert result["outcome"] == outcome


def test_stage_file_host_writes_result_atomically_and_streams_events(tmp_path: Path):
    request_path = tmp_path / "request.json"
    result_path = tmp_path / "result.json"
    request_path.write_text(json.dumps(plan_envelope()), encoding="utf-8")
    events: list[dict[str, object]] = []

    result = StageFileHost(StageExecutionRuntime(FakeStageBackend())).run(
        request_path, result_path, tmp_path, emit_event=events.append
    )

    assert json.loads(result_path.read_text(encoding="utf-8")) == result
    assert [event["body"]["kind"] for event in events] == ["started", "heartbeat"]


def test_stage_file_host_rejects_a_second_stage_in_the_same_process(tmp_path: Path):
    request_path = tmp_path / "request.json"
    result_path = tmp_path / "result.json"
    request_path.write_text(json.dumps(plan_envelope()), encoding="utf-8")
    host = StageFileHost(StageExecutionRuntime(FakeStageBackend()))

    host.run(request_path, result_path, tmp_path)

    with pytest.raises(ValueError, match="stage_process_already_used"):
        host.run(request_path, result_path, tmp_path)


def test_stage_runtime_converts_an_expired_deadline_to_a_canceled_result(tmp_path: Path):
    envelope = plan_envelope()
    envelope["stage_execution"] = {
        **envelope["stage_execution"],
        "deadline_at": "2020-01-01T00:00:00Z",
    }
    backend = FakeStageBackend()

    result = StageExecutionRuntime(backend).run(envelope, tmp_path)

    assert backend.calls == []
    assert result["outcome"] == {
        "kind": "canceled",
        "sanitized_reason": "The Stage deadline expired.",
    }


def test_stage_runtime_rejects_provider_output_that_exceeds_result_limit(tmp_path: Path):
    envelope = plan_envelope()
    envelope["limits"] = {**envelope["limits"], "max_result_bytes": 450}

    result = StageExecutionRuntime(FakeStageBackend()).run(envelope, tmp_path)

    assert result["outcome"]["kind"] == "execution_failed"
    assert result["outcome"]["error_code"] == "stage_result_limit_exceeded"
    assert len(json.dumps(result, separators=(",", ":")).encode("utf-8")) <= 450
