from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from performer.codex_client import CodexError, CodexSdkClient
from performer_api.config import CodexConfig


class FakeSdkTurn:
    id = "turn-1"

    async def run(self) -> dict[str, Any]:
        return {
            "final_response": json.dumps(
                {
                    "summary": "implemented",
                    "test_commands": ["pytest -q"],
                    "changed_files": ["a.py"],
                    "remaining_risks": [],
                    "next_action": "ready_for_review",
                }
            ),
            "usage": {
                "input_tokens": 12,
                "output_tokens": 4,
                "cached_tokens": 2,
                "total_tokens": 18,
            },
        }


class FakeSdkThread:
    def __init__(self, thread_id: str):
        self.id = thread_id
        self.prompts: list[Any] = []

    def turn(self, *args: Any, **kwargs: Any) -> FakeSdkTurn:
        self.prompts.append((args, kwargs))
        return FakeSdkTurn()


class FakeSdk:
    def __init__(self):
        self.started: list[dict[str, Any]] = []
        self.resumed: list[tuple[str, dict[str, Any]]] = []

    async def thread_start(self, **kwargs: Any) -> FakeSdkThread:
        self.started.append(kwargs)
        return FakeSdkThread("thread-new")

    async def thread_resume(self, thread_id: str, **kwargs: Any) -> FakeSdkThread:
        self.resumed.append((thread_id, kwargs))
        return FakeSdkThread(thread_id)


@pytest.mark.asyncio
async def test_sdk_backend_starts_new_thread_with_structured_result(tmp_path: Path) -> None:
    fake_sdk = FakeSdk()
    events: list[dict[str, Any]] = []
    client = CodexSdkClient(
        CodexConfig(model="gpt-5-codex", sandbox="workspace_write"),
        sdk_factory=lambda config: fake_sdk,
    )

    result = await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    assert result.backend == "sdk"
    assert result.thread_id == "thread-new"
    assert result.structured_result is not None
    assert result.structured_result["next_action"] == "ready_for_review"
    assert fake_sdk.started == [{"cwd": str(tmp_path), "model": "gpt-5-codex", "sandbox": "workspace_write"}]
    assert not fake_sdk.resumed
    assert [event["event"] for event in events if event["event"] in {"session_started", "turn_started", "turn_completed"}] == [
        "session_started",
        "turn_started",
        "turn_completed",
    ]


@pytest.mark.asyncio
async def test_sdk_backend_resumes_existing_thread(tmp_path: Path) -> None:
    fake_sdk = FakeSdk()
    client = CodexSdkClient(CodexConfig(), sdk_factory=lambda config: fake_sdk)

    result = await client.run_session(tmp_path, "Continue", "MT-1: Build", existing_thread_id="thread-existing")

    assert result.thread_id == "thread-existing"
    assert fake_sdk.started == []
    assert fake_sdk.resumed == [("thread-existing", {"cwd": str(tmp_path)})]


@pytest.mark.asyncio
async def test_sdk_backend_rebuilds_thread_when_resume_fails(tmp_path: Path) -> None:
    class ResumeFailingSdk(FakeSdk):
        async def thread_resume(self, thread_id: str, **kwargs: Any) -> FakeSdkThread:
            self.resumed.append((thread_id, kwargs))
            raise RuntimeError("thread gone")

    fake_sdk = ResumeFailingSdk()
    events: list[dict[str, Any]] = []
    client = CodexSdkClient(CodexConfig(), sdk_factory=lambda config: fake_sdk)

    result = await client.run_session(
        tmp_path,
        "Continue",
        "MT-1: Build",
        existing_thread_id="thread-existing",
        on_event=events.append,
    )

    assert result.thread_id == "thread-new"
    assert fake_sdk.resumed == [("thread-existing", {"cwd": str(tmp_path)})]
    assert fake_sdk.started == [{"cwd": str(tmp_path)}]
    assert any(event["event"] == "thread_resume_failed" and event["thread_id"] == "thread-existing" for event in events)


@pytest.mark.asyncio
async def test_sdk_backend_rejects_invalid_structured_output(tmp_path: Path) -> None:
    class BadTurn:
        id = "turn-1"

        async def run(self) -> dict[str, Any]:
            return {"final_response": "not json"}

    class BadThread(FakeSdkThread):
        def turn(self, *args: Any, **kwargs: Any) -> BadTurn:
            return BadTurn()

    class BadSdk(FakeSdk):
        async def thread_start(self, **kwargs: Any) -> BadThread:
            return BadThread("thread-bad")

    client = CodexSdkClient(CodexConfig(), sdk_factory=lambda config: BadSdk())

    with pytest.raises(CodexError) as exc:
        await client.run_session(tmp_path, "Do work", "MT-1: Build")

    assert exc.value.code == "invalid_structured_output"


@pytest.mark.asyncio
async def test_sdk_backend_reasks_once_for_invalid_structured_output(tmp_path: Path) -> None:
    class FlakyThread(FakeSdkThread):
        def __init__(self, thread_id: str):
            super().__init__(thread_id)
            self.calls = 0

        def turn(self, *args: Any, **kwargs: Any) -> Any:
            self.calls += 1
            self.prompts.append((args, kwargs))
            if self.calls == 1:
                class BadTurn:
                    id = "turn-bad"

                    async def run(self) -> dict[str, Any]:
                        return {"final_response": "not json"}

                return BadTurn()
            return FakeSdkTurn()

    class FlakySdk(FakeSdk):
        def __init__(self):
            super().__init__()
            self.thread = FlakyThread("thread-flaky")

        async def thread_start(self, **kwargs: Any) -> FlakyThread:
            return self.thread

    fake_sdk = FlakySdk()
    events: list[dict[str, Any]] = []
    client = CodexSdkClient(CodexConfig(), sdk_factory=lambda config: fake_sdk)

    result = await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    assert result.structured_result is not None
    assert fake_sdk.thread.calls == 2
    assert "previous response did not match" in fake_sdk.thread.prompts[1][0][0]
    assert [event["event"] for event in events if event["event"] == "turn_retrying"]


@pytest.mark.asyncio
async def test_sdk_backend_emits_token_usage_from_result(tmp_path: Path) -> None:
    events: list[dict[str, Any]] = []
    client = CodexSdkClient(CodexConfig(), sdk_factory=lambda config: FakeSdk())

    await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    usage_events = [event for event in events if event["event"] == "thread_token_usage_updated"]
    assert usage_events == [
        {
            "event": "thread_token_usage_updated",
            "backend": "sdk",
            "usage": {"input_tokens": 12, "output_tokens": 4, "cached_tokens": 2, "total_tokens": 18},
            "input_tokens": 12,
            "output_tokens": 4,
            "cached_tokens": 2,
            "total_tokens": 18,
        }
    ]


@pytest.mark.asyncio
async def test_sdk_backend_allows_non_handoff_output_schema(tmp_path: Path) -> None:
    class TextTurn:
        id = "turn-1"

        async def run(self) -> dict[str, Any]:
            return {"final_response": '{"score":4,"result":"pass"}', "output": {"score": 4, "result": "pass"}}

    class TextThread(FakeSdkThread):
        def turn(self, *args: Any, **kwargs: Any) -> TextTurn:
            self.prompts.append((args, kwargs))
            return TextTurn()

    class TextSdk(FakeSdk):
        async def thread_start(self, **kwargs: Any) -> TextThread:
            return TextThread("thread-text")

    client = CodexSdkClient(CodexConfig(), sdk_factory=lambda config: TextSdk())

    result = await client.run_session(tmp_path, "Gate", "Acceptance", output_schema={"type": "object"})

    assert result.final_response == '{"score":4,"result":"pass"}'
    assert result.structured_result == {"score": 4, "result": "pass"}
