from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import performer.codex_client as codex_client
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


@pytest.mark.asyncio
async def test_sdk_backend_retries_transient_init_until_thread_succeeds(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sleeps: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    monkeypatch.setattr(codex_client.asyncio, "sleep", fake_sleep)

    class FlakyInitSdk(FakeSdk):
        def __init__(self) -> None:
            super().__init__()
            self.start_calls = 0

        async def thread_start(self, **kwargs: Any) -> FakeSdkThread:
            self.start_calls += 1
            self.started.append(kwargs)
            if self.start_calls < 3:
                raise CodexError("connection_error", "socket dropped")
            return FakeSdkThread("thread-recovered")

    fake_sdk = FlakyInitSdk()
    events: list[dict[str, Any]] = []
    client = CodexSdkClient(
        CodexConfig(init_max_attempts=4, init_backoff_ms=100, init_backoff_max_ms=150),
        sdk_factory=lambda config: fake_sdk,
    )

    result = await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    assert result.thread_id == "thread-recovered"
    assert fake_sdk.start_calls == 3
    assert sleeps == [0.1, 0.15]
    assert [event["event"] for event in events if event["event"].startswith("codex_init_")] == [
        "codex_init_starting",
        "codex_init_retrying",
        "codex_init_starting",
        "codex_init_retrying",
        "codex_init_starting",
        "codex_init_succeeded",
    ]
    retry_events = [event for event in events if event["event"] == "codex_init_retrying"]
    assert [event["attempt"] for event in retry_events] == [2, 3]
    assert [event["delay_ms"] for event in retry_events] == [100, 150]
    assert all("secret" not in json.dumps(event).lower() for event in events)


@pytest.mark.asyncio
async def test_sdk_backend_does_not_retry_terminal_init_error(tmp_path: Path) -> None:
    class TerminalSdk(FakeSdk):
        def __init__(self) -> None:
            super().__init__()
            self.start_calls = 0

        async def thread_start(self, **kwargs: Any) -> FakeSdkThread:
            self.start_calls += 1
            raise CodexError("sdk_missing_thread_start", "missing start")

    fake_sdk = TerminalSdk()
    events: list[dict[str, Any]] = []
    client = CodexSdkClient(CodexConfig(init_max_attempts=4), sdk_factory=lambda config: fake_sdk)

    with pytest.raises(CodexError) as exc:
        await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    assert exc.value.code == "sdk_missing_thread_start"
    assert fake_sdk.start_calls == 1
    assert [event["event"] for event in events if event["event"].startswith("codex_init_")] == [
        "codex_init_starting",
        "codex_init_failed",
    ]
    assert events[-1]["attempts"] == 1


@pytest.mark.asyncio
async def test_sdk_backend_invalid_codex_bin_is_terminal_init_error(tmp_path: Path) -> None:
    events: list[dict[str, Any]] = []
    client = CodexSdkClient(
        CodexConfig(init_max_attempts=4, sdk_codex_bin=str(tmp_path / "missing-codex")),
    )

    with pytest.raises(CodexError) as exc:
        await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    assert exc.value.code == "invalid_sdk_codex_bin"
    assert [event["event"] for event in events if event["event"].startswith("codex_init_")] == [
        "codex_init_starting",
        "codex_init_failed",
    ]
    assert events[-1]["attempts"] == 1


@pytest.mark.asyncio
async def test_sdk_backend_exhausts_transient_init_as_codex_init_failed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sleeps: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    monkeypatch.setattr(codex_client.asyncio, "sleep", fake_sleep)

    class AlwaysFlakySdk(FakeSdk):
        def __init__(self) -> None:
            super().__init__()
            self.start_calls = 0

        async def thread_start(self, **kwargs: Any) -> FakeSdkThread:
            self.start_calls += 1
            raise RuntimeError("temporary spawn failure")

    fake_sdk = AlwaysFlakySdk()
    events: list[dict[str, Any]] = []
    client = CodexSdkClient(
        CodexConfig(init_max_attempts=3, init_backoff_ms=100, init_backoff_max_ms=150),
        sdk_factory=lambda config: fake_sdk,
    )

    with pytest.raises(CodexError) as exc:
        await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    assert exc.value.code == "codex_init_failed"
    assert "sdk_transport_error" in str(exc.value)
    assert fake_sdk.start_calls == 3
    assert sleeps == [0.1, 0.15]
    assert events[-1]["event"] == "codex_init_failed"
    assert events[-1]["attempts"] == 3
    assert events[-1]["message"] == "sdk_transport_error"


@pytest.mark.asyncio
async def test_sdk_backend_passes_codex_state_env_to_sdk_config(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    (home / ".codex").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("CODEX_HOME", raising=False)
    captured: dict[str, Any] = {}

    class FakeSdkConfig:
        def __init__(self, **kwargs: Any) -> None:
            captured["config_kwargs"] = kwargs

    class FakeAsyncCodex:
        def __init__(self, *, config: Any | None = None) -> None:
            captured["sdk_config"] = config

    monkeypatch.setitem(
        sys.modules,
        "openai_codex",
        SimpleNamespace(AsyncCodex=FakeAsyncCodex, CodexConfig=FakeSdkConfig),
    )

    client = CodexSdkClient(CodexConfig(sdk_codex_bin="/bin/sh"))
    await client._client()

    kwargs = captured["config_kwargs"]
    assert kwargs["codex_bin"] == "/bin/sh"
    assert kwargs["env"]["HOME"] == str(home)
    assert kwargs["env"]["CODEX_HOME"] == str(home / ".codex")


@pytest.mark.asyncio
async def test_sdk_backend_bounds_hung_init_attempts_with_read_timeout(
    tmp_path: Path,
) -> None:
    class HungInitSdk(FakeSdk):
        def __init__(self) -> None:
            super().__init__()
            self.start_calls = 0

        async def thread_start(self, **kwargs: Any) -> FakeSdkThread:
            self.start_calls += 1
            await asyncio.Event().wait()
            return FakeSdkThread("unreachable")

    fake_sdk = HungInitSdk()
    events: list[dict[str, Any]] = []
    client = CodexSdkClient(
        CodexConfig(
            init_max_attempts=2,
            init_backoff_ms=1,
            init_backoff_max_ms=1,
            read_timeout_ms=1,
        ),
        sdk_factory=lambda config: fake_sdk,
    )

    with pytest.raises(CodexError) as exc:
        await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    assert exc.value.code == "codex_init_failed"
    assert fake_sdk.start_calls == 2
    assert [event["event"] for event in events if event["event"].startswith("codex_init_")] == [
        "codex_init_starting",
        "codex_init_retrying",
        "codex_init_starting",
        "codex_init_failed",
    ]
    assert events[-1]["attempts"] == 2
    assert events[-1]["message"] == "timeout"


@pytest.mark.asyncio
async def test_sdk_backend_bounds_hung_turn_with_hard_turn_timeout(tmp_path: Path) -> None:
    class HungTurn:
        id = "turn-hung"

        async def run(self) -> dict[str, Any]:
            await asyncio.Event().wait()
            return {}

    class HungTurnThread(FakeSdkThread):
        def turn(self, *args: Any, **kwargs: Any) -> HungTurn:
            return HungTurn()

    class HungTurnSdk(FakeSdk):
        async def thread_start(self, **kwargs: Any) -> FakeSdkThread:
            self.started.append(kwargs)
            return HungTurnThread("thread-hung")

    events: list[dict[str, Any]] = []
    client = CodexSdkClient(
        CodexConfig(hard_turn_timeout_ms=1),
        sdk_factory=lambda config: HungTurnSdk(),
    )

    with pytest.raises(CodexError) as exc:
        await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    assert exc.value.code == "timeout"
    timeout_events = [event for event in events if event["event"] == "request_timeout"]
    assert timeout_events == [
        {
            "event": "request_timeout",
            "backend": "sdk",
            "thread_id": "thread-hung",
            "turn_id": "turn-hung",
            "session_id": "thread-hung-turn-hung",
            "timeout_ms": 1,
        }
    ]


@pytest.mark.asyncio
async def test_sdk_backend_does_not_wait_for_client_close_after_turn_timeout(tmp_path: Path) -> None:
    class ClosableHungSdk(FakeSdk):
        def __init__(self) -> None:
            super().__init__()
            self.closed = False

        async def thread_start(self, **kwargs: Any) -> FakeSdkThread:
            self.started.append(kwargs)

            class HungTurn:
                id = "turn-hung"

                async def run(self) -> dict[str, Any]:
                    await asyncio.Event().wait()
                    return {}

            class HungThread(FakeSdkThread):
                def turn(self, *args: Any, **kwargs: Any) -> HungTurn:
                    return HungTurn()

            return HungThread("thread-hung")

        async def close(self) -> None:
            await asyncio.Event().wait()
            self.closed = True

    fake_sdk = ClosableHungSdk()
    client = CodexSdkClient(
        CodexConfig(hard_turn_timeout_ms=1),
        sdk_factory=lambda config: fake_sdk,
    )

    with pytest.raises(CodexError):
        await client.run_session(tmp_path, "Do work", "MT-1: Build")

    assert fake_sdk.closed is False
