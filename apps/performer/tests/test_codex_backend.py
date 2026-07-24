from __future__ import annotations

import json
import threading
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from performer.backends.codex.codex_backend_impl import CodexBackendImpl
from performer.backends.provider_backend_interface import ProviderBackendError, ProviderTurnDeadlineExpired


class FakeThread:
    id = "thread-1"

    def __init__(self, response: str = '{"kind":"wait"}') -> None:
        self.response = response
        self.calls: list[tuple[str, dict[str, object]]] = []

    def turn(self, prompt: str, **kwargs: object):
        self.calls.append((prompt, kwargs))
        result = SimpleNamespace(
            status="completed",
            error=None,
            final_response=self.response,
            usage=SimpleNamespace(total=SimpleNamespace(total_tokens=3)),
        )
        return SimpleNamespace(run=lambda: result, interrupt=lambda: None)


class FakeCodex:
    def __init__(self, thread: FakeThread | None = None) -> None:
        self.thread = thread or FakeThread()
        self.started: list[dict[str, object]] = []
        self.archived: list[str] = []

    def thread_start(self, **kwargs: object):
        self.started.append(kwargs)
        return self.thread

    def thread_archive(self, thread_id: str) -> None:
        self.archived.append(thread_id)

    def account(self, refresh_token: bool = False):
        return SimpleNamespace(account=SimpleNamespace(root=SimpleNamespace(type="chatgpt")))


class BlockingTurn:
    def __init__(self) -> None:
        self.interrupted = threading.Event()
        self.interrupt_calls = 0

    def run(self):
        self.interrupted.wait(timeout=1)
        return SimpleNamespace(
            status="completed",
            error=None,
            final_response='{"kind":"wait"}',
            usage=SimpleNamespace(total=SimpleNamespace(total_tokens=3)),
        )

    def interrupt(self) -> None:
        self.interrupt_calls += 1
        self.interrupted.set()


class BlockingThread(FakeThread):
    def __init__(self) -> None:
        super().__init__()
        self.turn_handle = BlockingTurn()

    def turn(self, prompt: str, **kwargs: object):
        self.calls.append((prompt, kwargs))
        return self.turn_handle


def test_role_session_uses_role_specific_instructions_and_returns_json():
    sdk = FakeCodex(FakeThread('{"action":{"kind":"wait"}}'))
    backend = CodexBackendImpl(sdk)
    session = backend.open_role_session("root_reconciler", {"model": "gpt"})

    result = backend.execute_role_turn(
        session,
        {
            "kind": "open_root_reconciler",
            "root_issue_id": "root-1",
            "bootstrap": {
                "root_digest": "tree-1",
                "root_snapshot": {
                    "root": {"issue": {"issue_id": "root-1"}},
                    "cycles": [{
                        "cycle_issue": {"issue_id": "cycle-1"},
                        "issues": [{"issue_id": "plan-1", "issue_kind": "plan"}],
                    }],
                },
            },
        },
        workspace_root=None,
        cancel_event=__import__("threading").Event(),
    )

    assert result["output"]["action"]["kind"] == "wait"
    assert "Root Reconciler" in sdk.started[0]["base_instructions"]
    assert "Do not use tools or inspect the workspace" in sdk.started[0]["base_instructions"]
    assert "root-1" in sdk.thread.calls[0][0]
    assert '"action":{"kind":"..."}' in sdk.thread.calls[0][0]
    assert '"execute_plan"' in sdk.thread.calls[0][0]
    assert "ROOT TARGET IDS:" in sdk.thread.calls[0][0]
    assert '"required_outputs":"array"' in sdk.thread.calls[0][0]
    assert "ROOT ACTION CLOSED VALUES:" in sdk.thread.calls[0][0]
    assert '"reason":["initial","root_contract_changed","repair_required","exhausted","user_requested_retry","unresolved_findings"]' in sdk.thread.calls[0][0]
    assert "required_outputs, prior_plan_result_ids and human_resolution_ids must each be JSON arrays" in sdk.started[0]["base_instructions"]
    assert "dependency_evidence_refs must be an array of EvidenceRef objects" in sdk.started[0]["base_instructions"]
    assert "EvidenceRef.source_kind must be exactly one of linear_issue" in sdk.started[0]["base_instructions"]
    assert "dependency_evidence_refs to []" in sdk.started[0]["base_instructions"]
    assert "plan-1" in sdk.thread.calls[0][0]
    assert sdk.thread.calls[0][1]["output_schema"]["required"] == [
        "rationale", "evidence_refs", "consumed_input_ids", "comment_replies", "human_action_resolutions", "action",
    ]
    assert set(sdk.thread.calls[0][1]["output_schema"]["properties"]) == {
        "rationale", "evidence_refs", "consumed_input_ids", "comment_replies", "human_action_resolutions", "action",
    }
    action_variants = sdk.thread.calls[0][1]["output_schema"]["properties"]["action"]["oneOf"]
    execute_plan_schema = next(schema for schema in action_variants if schema.get("properties", {}).get("kind", {}).get("const") == "execute_plan")
    assert execute_plan_schema["required"] == [
        "kind",
        "cycle_issue_id",
        "plan_issue_id",
        "plan_goal",
        "required_outputs",
        "prior_plan_result_ids",
        "human_resolution_ids",
    ]
    assert "RETURN ONLY THE JSON OBJECT." in sdk.thread.calls[0][0]
    assert "additionalProperties" not in sdk.thread.calls[0][0]


def test_work_role_receives_workspace_and_is_archived():
    sdk = FakeCodex()
    backend = CodexBackendImpl(sdk)
    session = backend.open_role_session("work", {"model": "gpt"})
    backend.execute_role_turn(
        session,
        {"role": "work", "target_issue_id": "work-1"},
        workspace_root=None,
        cancel_event=__import__("threading").Event(),
    )
    backend.close_role_session(session)

    assert sdk.started[0]["sandbox"].value == "workspace-write"
    assert sdk.archived == ["thread-1"]


@pytest.mark.parametrize("role", ["plan", "work", "verify"])
def test_stage_roles_use_the_complete_outcome_contract(role: str):
    sdk = FakeCodex()
    backend = CodexBackendImpl(sdk)
    session = backend.open_role_session(role, {"model": "gpt"})

    backend.execute_role_turn(
        session,
        {"role": role},
        workspace_root=None,
        cancel_event=__import__("threading").Event(),
    )

    schema = sdk.thread.calls[0][1]["output_schema"]
    assert len(schema["oneOf"]) >= 5
    assert all("kind" in variant["properties"] for variant in schema["oneOf"])
    assert all(len(variant["required"]) > 1 for variant in schema["oneOf"])
    assert "STAGE OUTCOME REQUIRED FIELDS:" in sdk.thread.calls[0][0]
    assert "STAGE OUTCOME FIELD SHAPES:" in sdk.thread.calls[0][0]
    assert "STAGE OUTCOME NESTED CONTRACT SHAPES:" in sdk.thread.calls[0][0]
    assert "plan_completed" in sdk.thread.calls[0][0] or role != "plan"
    assert "work_completed" in sdk.thread.calls[0][0] or role != "work"
    assert "verify_passed" in sdk.thread.calls[0][0] or role != "verify"
    assert "actual_changes" in sdk.thread.calls[0][0] or role != "work"
    assert "acceptance_results" in sdk.thread.calls[0][0] or role != "verify"


def test_invalid_provider_json_is_sanitized():
    sdk = FakeCodex(FakeThread("not-json"))
    backend = CodexBackendImpl(sdk)
    session = backend.open_role_session("plan", {"model": "gpt"})

    with pytest.raises(ProviderBackendError) as raised:
        backend.execute_role_turn(
            session,
            {},
            workspace_root=None,
            cancel_event=__import__("threading").Event(),
        )

    assert raised.value.code == "provider_output_invalid_json"
    assert "not-json" not in raised.value.sanitized_reason


def test_role_turn_interrupts_a_blocked_provider_at_its_deadline():
    thread = BlockingThread()
    backend = CodexBackendImpl(FakeCodex(thread))
    session = backend.open_role_session("plan", {"model": "gpt"})

    with pytest.raises(ProviderTurnDeadlineExpired):
        backend.execute_role_turn(
            session,
            {"limits": {"deadline_at": (datetime.now(UTC) + timedelta(milliseconds=50)).isoformat()}},
            workspace_root=None,
            cancel_event=threading.Event(),
        )

    assert thread.turn_handle.interrupted.is_set()
    assert thread.turn_handle.interrupt_calls == 1
