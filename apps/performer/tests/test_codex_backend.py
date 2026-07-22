from __future__ import annotations

import json
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest

from performer.backends.codex.codex_backend_impl import (
    STAGE_BASE_INSTRUCTIONS,
    CodexBackendImpl,
    _stage_outcome,
    _stage_output_schema,
)
from performer.backends.provider_backend_interface import ProviderBackendError


class FakeThread:
    def __init__(self, response="Root work yielded."):
        self.id = "thread-1"
        self.calls = []
        self.response = response

    def turn(self, prompt, **kwargs):
        self.calls.append((prompt, kwargs))
        result = SimpleNamespace(
            status="completed", error=None, final_response=self.response,
            usage=SimpleNamespace(total=SimpleNamespace(
                input_tokens=11, cached_input_tokens=2, output_tokens=7,
                reasoning_output_tokens=3, total_tokens=23,
            )),
        )
        return SimpleNamespace(run=lambda: result, interrupt=lambda: None)


class FailedRunThread(FakeThread):
    def turn(self, prompt, **kwargs):
        self.calls.append((prompt, kwargs))

        def fail():
            raise RuntimeError("schema rejected with Bearer sk-stage-private")

        return SimpleNamespace(run=fail, interrupt=lambda: None)


class FakeCodex:
    def __init__(self, thread=None):
        self.thread = thread or FakeThread()
        self.started = []
        self.resumed = []

    def thread_start(self, **kwargs):
        self.started.append(kwargs)
        return self.thread

    def account(self, refresh_token=False):
        return SimpleNamespace(account=SimpleNamespace(root=SimpleNamespace(type="chatgpt")))


def test_stage_starts_a_fresh_provider_context_and_never_resumes_a_thread(tmp_path: Path):
    fixture_path = Path(__file__).parents[3] / "packages/contracts/fixtures/cross-language/valid/stage-context.json"
    envelope = json.loads(fixture_path.read_text(encoding="utf-8"))["value"]
    outcome = {
        "kind": "plan_completed",
        "plan_contract": {
            "objective_summary": "Deliver the Stage.",
            "included_scope": ["apps/performer"],
            "excluded_scope": [],
            "acceptance_criteria": [{
                "criterion_key": "stage",
                "statement": "The Stage completes once.",
                "verification_method": "unit test",
            }],
            "work_nodes": [],
            "verify_node": {
                "title": "Verify Stage",
                "acceptance_criteria": [{
                    "criterion_key": "verify",
                    "statement": "The Stage result is closed.",
                    "verification_method": "unit test",
                }],
                "required_checks": [],
            },
        },
    }
    sdk = FakeCodex(thread=FakeThread(response=json.dumps({"outcome": outcome})))

    result = CodexBackendImpl(sdk).execute_stage(envelope, tmp_path, Event())

    assert result["outcome"] == outcome
    assert len(sdk.started) == 1
    assert sdk.resumed == []
    assert sdk.started[0]["base_instructions"] == STAGE_BASE_INSTRUCTIONS
    prompt, kwargs = sdk.thread.calls[0]
    assert envelope["workflow_context"]["root"]["objective"] in prompt
    assert str(tmp_path) not in prompt
    assert kwargs["cwd"] == str(tmp_path)
    assert "output_schema" not in kwargs
    assert json.dumps(_stage_output_schema("plan"), separators=(",", ":")) in prompt


def test_stage_outcome_accepts_the_direct_contract_shape():
    outcome = {"kind": "plan_completed", "plan_contract": {}}

    assert _stage_outcome(json.dumps(outcome)) == outcome


@pytest.mark.parametrize(
    "response",
    [
        "```json\n{\"outcome\":{\"kind\":\"plan_completed\"}}\n```",
        "Stage complete.\n{\"outcome\":{\"kind\":\"plan_completed\"}}",
    ],
)
def test_stage_outcome_accepts_one_unambiguous_embedded_json_object(response: str):
    assert _stage_outcome(response) == {"kind": "plan_completed"}


def test_stage_outcome_rejects_multiple_embedded_json_objects():
    with pytest.raises(ProviderBackendError):
        _stage_outcome('{"kind":"plan_completed"}\n{"kind":"plan_completed"}')


@pytest.mark.parametrize("response", ["", "not-json", json.dumps({"outcome": {}})])
def test_invalid_provider_stage_output_requests_a_fresh_context(response: str):
    with pytest.raises(ProviderBackendError) as raised:
        _stage_outcome(response)

    assert raised.value.code == "provider_stage_output_invalid"
    assert raised.value.retryable is True


@pytest.mark.parametrize(
    ("stage", "completed_kind"),
    [
        ("plan", "plan_completed"),
        ("work", "work_completed"),
        ("verify", "verify_completed"),
    ],
)
def test_stage_output_schema_is_closed_and_specific_to_the_stage(
    stage: str,
    completed_kind: str,
):
    schema = _stage_output_schema(stage)
    serialized = json.dumps(schema)

    assert schema["type"] == "object"
    assert schema["required"] == ["outcome"]
    assert schema["additionalProperties"] is False
    variants = schema["properties"]["outcome"]["oneOf"]
    assert variants[0]["properties"]["kind"] == {"const": completed_kind}
    assert variants[1]["properties"]["kind"] == {"const": "suspended"}
    assert variants[0]["additionalProperties"] is False
    assert variants[1]["additionalProperties"] is False
    assert "$ref" not in serialized
    assert "common.schema.json" not in serialized


def test_stage_start_failure_is_sanitized():
    class FailedStart(FakeCodex):
        def thread_start(self, **kwargs):
            raise RuntimeError("Bearer sk-stage-private")

    fixture_path = Path(__file__).parents[3] / "packages/contracts/fixtures/cross-language/valid/stage-context.json"
    envelope = json.loads(fixture_path.read_text(encoding="utf-8"))["value"]

    with pytest.raises(ProviderBackendError) as raised:
        CodexBackendImpl(FailedStart()).execute_stage(envelope, Path("/tmp/workspace"), Event())

    assert raised.value.code == "provider_stage_start_failed"
    assert raised.value.sanitized_reason == "The Provider could not start the Stage."
    assert "sk-stage-private" not in raised.value.sanitized_reason


def test_stage_run_failure_preserves_sanitized_provider_evidence(tmp_path: Path):
    fixture_path = Path(__file__).parents[3] / "packages/contracts/fixtures/cross-language/valid/stage-context.json"
    envelope = json.loads(fixture_path.read_text(encoding="utf-8"))["value"]

    with pytest.raises(ProviderBackendError) as raised:
        CodexBackendImpl(FakeCodex(FailedRunThread())).execute_stage(
            envelope, tmp_path, Event()
        )

    assert raised.value.code == "provider_stage_failed"
    assert raised.value.sanitized_reason == (
        "The Provider Stage failed: RuntimeError: schema rejected with Bearer [REDACTED]"
    )
    assert "sk-stage-private" not in raised.value.sanitized_reason
