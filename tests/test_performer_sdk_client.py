from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from openai_codex.generated.v2_all import ItemCompletedNotification, ThreadItem
from openai_codex.models import Notification as SdkNotification

from performer.backend import runtime_wait_from_events
from performer.codex_client import CodexSdkClient
from performer.codex_config import CodexConfig


@dataclass
class FakeNotification:
    method: str
    payload: dict[str, Any]


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
            FakeNotification(
                "item/autoApprovalReview/started",
                {
                    "reviewId": "review-1",
                    "action": {"type": "requestPermissions", "reason": "Need workspace permission."},
                },
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
