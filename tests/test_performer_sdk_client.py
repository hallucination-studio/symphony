from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from openai_codex.generated.v2_all import ItemCompletedNotification, ThreadItem
from openai_codex.models import Notification as SdkNotification, UnknownNotification

from performer.backend import runtime_wait_from_events
from performer.backend import TurnBackend, TurnBackendError
from performer.codex_client import CodexSdkClient
from performer.codex_config import CodexConfig
from performer.codex_client_helpers import CodexError


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

    async def turn(self, _prompt: str, *, output_schema: dict[str, Any]) -> FakeTurn:
        self.output_schema = output_schema
        return FakeTurn(self.notifications)


class FakeAsyncCodex:
    def __init__(self, thread: FakeThread) -> None:
        self.thread = thread
        self.closed = False

    async def thread_start(self, **_kwargs: Any) -> FakeThread:
        return self.thread

    async def close(self) -> None:
        self.closed = True


@pytest.mark.asyncio
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
    client = CodexSdkClient(CodexConfig(), sdk_factory=lambda _config: sdk)

    result = await client.run_session(tmp_path, "Plan the work", output_schema=schema)

    assert result.structured_result == structured
    assert thread.output_schema == schema
    assert sdk.closed is True
    wait = runtime_wait_from_events(result.events)
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
    client = CodexSdkClient(CodexConfig(), sdk_factory=lambda _config: sdk)

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
    client = CodexSdkClient(CodexConfig(), sdk_factory=lambda _config: sdk)

    with pytest.raises(CodexError) as exc_info:
        await client.run_session(tmp_path, "Return JSON", output_schema={"type": "object"})

    assert exc_info.value.code == "upstream_overloaded_exhausted"


@pytest.mark.parametrize("sandbox", ["workspace-write", "workspace_write"])
def test_sdk_client_converts_sandbox_profile_to_pinned_sdk_enum(tmp_path: Path, sandbox: str) -> None:
    client = CodexSdkClient(CodexConfig(sandbox=sandbox))

    kwargs = client._thread_kwargs(tmp_path)

    from openai_codex import Sandbox

    assert kwargs["sandbox"] is Sandbox.workspace_write


@pytest.mark.asyncio
async def test_turn_backend_preserves_codex_error_code() -> None:
    class FailingClient:
        async def run_session(self, *_args, **_kwargs):
            raise CodexError("upstream_overloaded_exhausted", "Codex upstream returned HTTP 502")

    with pytest.raises(TurnBackendError, match="upstream_overloaded_exhausted:Codex upstream returned HTTP 502") as exc_info:
        await TurnBackend(FailingClient()).plan(Path.cwd(), "Return a plan")

    assert exc_info.value.code == "upstream_overloaded_exhausted"
