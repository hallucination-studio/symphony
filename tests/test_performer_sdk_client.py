from __future__ import annotations

import json
import ast
from pathlib import Path
from typing import Any

import pytest
from openai_codex import ApprovalMode, CodexConfig as SdkCodexConfig, Sandbox
from openai_codex.generated.v2_all import ErrorNotification, ItemCompletedNotification, ThreadItem
from openai_codex.models import Notification as SdkNotification, UnknownNotification
from openai_codex.types import ReasoningEffort, ReasoningSummary
from performer_api.runtime_policy import RuntimePolicy

from performer.backends.codex import _runtime_wait_from_events
from performer.codex_client import CodexSdkClient, _event_payload
from performer.codex_config import CodexConfig
from performer.codex_client_helpers import CodexError


EXECUTION_POLICY = {
    "version": 1,
    "model": "gpt-5.4",
    "model_provider": "openai",
    "approval_mode": "auto_review",
    "reasoning_effort": "high",
    "reasoning_summary": "auto",
    "sandbox": {
        "plan": "read_only",
        "execute": "workspace_write",
        "gate": "read_only",
    },
    "initialize_timeout_ms": 5_000,
    "turn_timeout_ms": 3_600_000,
    "initialize_max_attempts": 4,
    "overload_max_attempts": 5,
}


def test_provider_sdk_imports_are_confined_to_backend_implementation_modules() -> None:
    source_root = Path(__file__).parents[1] / "packages" / "performer" / "src" / "performer"
    offenders: list[str] = []
    for path in source_root.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        imports = [
            node.module
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module
        ]
        imports.extend(
            alias.name
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        )
        if any(name == "openai_codex" or name.startswith("openai_codex.") for name in imports):
            relative = path.relative_to(source_root).as_posix()
            if not relative.startswith("backends/"):
                offenders.append(relative)
    assert offenders == []


def _config(turn_kind: str, *, sdk_codex_bin: str | None = None) -> CodexConfig:
    return CodexConfig.from_runtime_policy(
        RuntimePolicy.from_dict(EXECUTION_POLICY),
        turn_kind,
        sdk_codex_bin=sdk_codex_bin,
    )


class FakeTurn:
    id = "turn-1"

    def __init__(self, notifications: list[Any]) -> None:
        self.notifications = notifications

    async def stream(self):
        for notification in self.notifications:
            yield notification


class FakeThread:
    id = "thread-1"

    def __init__(self, notifications: list[Any]) -> None:
        self.notifications = notifications
        self.output_schema: dict[str, Any] | None = None
        self.turn_kwargs: dict[str, Any] = {}

    async def turn(self, _prompt: str, **kwargs: Any) -> FakeTurn:
        output_schema = kwargs.get("output_schema")
        assert isinstance(output_schema, dict)
        self.output_schema = output_schema
        self.turn_kwargs = kwargs
        return FakeTurn(self.notifications)


class FakeAsyncCodex:
    def __init__(self, thread: FakeThread) -> None:
        self.thread = thread
        self.closed = False
        self.thread_start_kwargs: dict[str, Any] = {}

    async def thread_start(self, **kwargs: Any) -> FakeThread:
        self.thread_start_kwargs = kwargs
        return self.thread

    async def close(self) -> None:
        self.closed = True

async def test_sdk_client_reads_schema_json_and_notification_payload(tmp_path: Path) -> None:
    structured = {"summary": "Plan", "tasks": []}
    thread = FakeThread(
        [
            SdkNotification(
                "item/autoApprovalReview/started",
                UnknownNotification(
                    {
                        "reviewId": "review-1",
                        "action": {"type": "requestPermissions", "reason": "Need workspace permission."},
                    }
                ),
            ),
            SdkNotification(
                "item/completed",
                ItemCompletedNotification(
                    completedAtMs=1,
                    item=ThreadItem.model_validate(
                        {
                            "id": "item-1",
                            "type": "agentMessage",
                            "phase": "final_answer",
                            "text": json.dumps(structured),
                        }
                    ),
                    threadId="thread-1",
                    turnId="turn-1",
                ),
            ),
        ]
    )
    sdk = FakeAsyncCodex(thread)
    schema = {"type": "object", "required": ["summary", "tasks"]}
    client = CodexSdkClient(_config("plan"), sdk_factory=lambda _config: sdk)

    result = await client.run_session(tmp_path, "Plan the work", output_schema=schema)

    assert result.structured_result == structured
    assert thread.output_schema == schema
    assert sdk.closed is True
    wait = _runtime_wait_from_events(result.events)
    assert wait is not None
    assert wait.kind == "permission_required"
    assert wait.reason == "Need workspace permission."


@pytest.mark.asyncio
async def test_sdk_client_surfaces_terminal_upstream_error_after_stream_retries(tmp_path: Path) -> None:
    thread = FakeThread(
        [
            SdkNotification(
                "error",
                UnknownNotification(
                    {
                        "error": {
                            "codexErrorInfo": {"responseStreamDisconnected": {"httpStatusCode": 502}},
                            "message": "upstream request failed",
                        },
                        "willRetry": False,
                        "type": "error",
                    }
                ),
            )
        ]
    )
    sdk = FakeAsyncCodex(thread)
    client = CodexSdkClient(_config("plan"), sdk_factory=lambda _config: sdk)

    with pytest.raises(CodexError) as exc_info:
        await client.run_session(
            tmp_path,
            "Return JSON",
            output_schema={"type": "object"},
        )

    assert exc_info.value.code == "upstream_overloaded_exhausted"
    assert exc_info.value.http_status == 502
    assert sdk.closed is True


@pytest.mark.asyncio
async def test_sdk_client_classifies_terminal_bad_gateway_text(tmp_path: Path) -> None:
    thread = FakeThread(
        [
            SdkNotification(
                "error",
                UnknownNotification(
                    {
                        "error": {"message": "Bad Gateway from upstream"},
                        "willRetry": False,
                        "type": "error",
                    }
                ),
            )
        ]
    )
    sdk = FakeAsyncCodex(thread)
    client = CodexSdkClient(_config("plan"), sdk_factory=lambda _config: sdk)

    with pytest.raises(CodexError) as exc_info:
        await client.run_session(tmp_path, "Return JSON", output_schema={"type": "object"})

    assert exc_info.value.code == "upstream_overloaded_exhausted"


@pytest.mark.asyncio
async def test_sdk_init_failure_keeps_error_category_without_raw_exception_text() -> None:
    client = CodexSdkClient(_config("plan"))
    events: list[dict[str, Any]] = []

    with pytest.raises(CodexError) as exc_info:
        await client._handle_init_exception(
            RuntimeError("transport failed token=secret-value"),
            1,
            1,
            emit=events.append,
        )

    evidence = f"{exc_info.value}\n{json.dumps(events, sort_keys=True)}"
    assert "secret-value" not in evidence
    assert "sdk_transport_error" in evidence


def test_sdk_client_reads_generated_v2_notification_payload_directly() -> None:
    event = SdkNotification(
        "error",
        ErrorNotification.model_validate(
            {
                "error": {
                    "message": '{"error":{"code":"invalid_json_schema","type":"invalid_request_error"}}',
                    "codexErrorInfo": "other",
                },
                "threadId": "thread-1",
                "turnId": "turn-1",
                "willRetry": False,
            }
        ),
    )

    payload = _event_payload(event)

    assert payload["willRetry"] is False
    assert "invalid_json_schema" in payload["error"]["message"]


def test_all_performer_output_schemas_are_strict_at_every_object_boundary() -> None:
    from performer.schemas import EXECUTE_SCHEMA, GATE_SCHEMA, PLAN_SCHEMA

    def assert_strict(value: object) -> None:
        if isinstance(value, dict):
            if value.get("type") == "object":
                assert value.get("additionalProperties") is False
                assert isinstance(value.get("properties"), dict)
            for nested in value.values():
                assert_strict(nested)
        elif isinstance(value, list):
            for nested in value:
                assert_strict(nested)

    for schema in (PLAN_SCHEMA, EXECUTE_SCHEMA, GATE_SCHEMA):
        assert_strict(schema)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("turn_kind", "expected_sandbox"),
    [
        ("plan", Sandbox.read_only),
        ("execute", Sandbox.workspace_write),
        ("gate", Sandbox.read_only),
    ],
)
async def test_sdk_client_maps_every_runtime_policy_field_to_thread_and_turn(
    tmp_path: Path,
    turn_kind: str,
    expected_sandbox: Sandbox,
) -> None:
    structured = {"ok": True}
    schema = {"type": "object", "additionalProperties": False}
    thread = FakeThread(
        [
            SdkNotification(
                "item/completed",
                ItemCompletedNotification(
                    completedAtMs=1,
                    item=ThreadItem.model_validate(
                        {
                            "id": "item-1",
                            "type": "agentMessage",
                            "phase": "final_answer",
                            "text": json.dumps(structured),
                        }
                    ),
                    threadId="thread-1",
                    turnId="turn-1",
                ),
            )
        ]
    )
    sdk = FakeAsyncCodex(thread)
    client = CodexSdkClient(_config(turn_kind), sdk_factory=lambda _config: sdk)

    result = await client.run_session(tmp_path, "Return JSON", output_schema=schema)

    assert result.structured_result == structured
    assert sdk.thread_start_kwargs == {
        "approval_mode": ApprovalMode.auto_review,
        "cwd": str(tmp_path),
        "ephemeral": True,
        "model": "gpt-5.4",
        "model_provider": "openai",
        "sandbox": expected_sandbox,
    }
    assert thread.turn_kwargs["approval_mode"] is ApprovalMode.auto_review
    assert thread.turn_kwargs["effort"] is ReasoningEffort.high
    assert isinstance(thread.turn_kwargs["summary"], ReasoningSummary)
    summary = thread.turn_kwargs["summary"].root
    assert getattr(summary, "value", summary) == "auto"
    assert thread.turn_kwargs["sandbox"] is expected_sandbox
    assert thread.turn_kwargs["output_schema"] == schema


@pytest.mark.parametrize("codex_home", [None, "/tmp/codex-home"])
def test_sdk_launcher_uses_only_home_optional_codex_home_and_codex_bin(
    monkeypatch,
    codex_home: str | None,
) -> None:
    monkeypatch.setenv("HOME", "/tmp/conductor-home")
    monkeypatch.setenv("CODEX_CONFIG_OVERRIDES", '["api_key=must-not-be-used"]')
    if codex_home is None:
        monkeypatch.delenv("CODEX_HOME", raising=False)
    else:
        monkeypatch.setenv("CODEX_HOME", codex_home)
    client = CodexSdkClient(_config("plan", sdk_codex_bin="/tmp/codex"))

    sdk_config = client._sdk_config(SdkCodexConfig)

    expected_env = {"HOME": "/tmp/conductor-home"}
    if codex_home is not None:
        expected_env["CODEX_HOME"] = codex_home
    assert sdk_config.codex_bin == "/tmp/codex"
    assert sdk_config.env == expected_env
    assert sdk_config.config_overrides == ()
    assert sdk_config.launch_args_override is None
    assert not hasattr(client.config, "config_overrides")
