from test_codex_client_support import *  # noqa: F401,F403

async def test_sdk_backend_retries_turn_overload_until_success(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    sleeps: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    monkeypatch.setattr(codex_client.asyncio, "sleep", fake_sleep)

    class OverloadedThread(FakeSdkThread):
        def __init__(self, thread_id: str) -> None:
            super().__init__(thread_id)
            self.calls = 0

        def turn(self, *args: Any, **kwargs: Any) -> FakeSdkTurn:
            self.calls += 1
            if self.calls < 3:
                raise server_busy()
            return super().turn(*args, **kwargs)

    class OverloadedSdk(FakeSdk):
        def __init__(self) -> None:
            super().__init__()
            self.thread = OverloadedThread("thread-overload")

        async def thread_start(self, **kwargs: Any) -> OverloadedThread:
            return self.thread

    fake_sdk = OverloadedSdk()
    events: list[dict[str, Any]] = []
    client = CodexSdkClient(
        CodexConfig(overload_max_attempts=3, overload_initial_delay_ms=100, overload_max_delay_ms=250),
        sdk_factory=lambda config: fake_sdk,
    )

    result = await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    assert result.thread_id == "thread-overload"
    assert fake_sdk.thread.calls == 3
    assert sleeps == [0.1, 0.2]
    retry_events = [event for event in events if event["event"] == "codex_overload_retrying"]
    assert [event["attempt"] for event in retry_events] == [2, 3]
    assert [event["delay_ms"] for event in retry_events] == [100, 200]
    assert all(event["http_status"] == 502 for event in retry_events)
    assert "upstream 502: server overloaded" in retry_events[0]["message"]


async def test_sdk_backend_retries_plain_502_bad_gateway_errors(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    sleeps: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    monkeypatch.setattr(codex_client.asyncio, "sleep", fake_sleep)

    class PlainBadGatewayThread(FakeSdkThread):
        def __init__(self, thread_id: str) -> None:
            super().__init__(thread_id)
            self.calls = 0

        def turn(self, *args: Any, **kwargs: Any) -> FakeSdkTurn:
            self.calls += 1
            if self.calls < 2:
                raise RuntimeError("unexpected status 502 Bad Gateway: Upstream request failed")
            return super().turn(*args, **kwargs)

    class PlainBadGatewaySdk(FakeSdk):
        def __init__(self) -> None:
            super().__init__()
            self.thread = PlainBadGatewayThread("thread-plain-502")

        async def thread_start(self, **kwargs: Any) -> PlainBadGatewayThread:
            return self.thread

    fake_sdk = PlainBadGatewaySdk()
    events: list[dict[str, Any]] = []
    client = CodexSdkClient(
        CodexConfig(overload_max_attempts=2, overload_initial_delay_ms=100, overload_max_delay_ms=250),
        sdk_factory=lambda config: fake_sdk,
    )

    result = await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    assert result.thread_id == "thread-plain-502"
    assert fake_sdk.thread.calls == 2
    assert sleeps == [0.1]
    retry_events = [event for event in events if event["event"] == "codex_overload_retrying"]
    assert retry_events[0]["http_status"] == 502
    assert "Upstream request failed" in retry_events[0]["message"]


async def test_sdk_backend_does_not_retry_terminal_bad_request(tmp_path: Path) -> None:
    class BadRequestThread(FakeSdkThread):
        def __init__(self, thread_id: str) -> None:
            super().__init__(thread_id)
            self.calls = 0

        def turn(self, *args: Any, **kwargs: Any) -> FakeSdkTurn:
            self.calls += 1
            raise invalid_params()

    class BadRequestSdk(FakeSdk):
        def __init__(self) -> None:
            super().__init__()
            self.thread = BadRequestThread("thread-bad-request")

        async def thread_start(self, **kwargs: Any) -> BadRequestThread:
            return self.thread

    fake_sdk = BadRequestSdk()
    events: list[dict[str, Any]] = []
    client = CodexSdkClient(CodexConfig(overload_max_attempts=3), sdk_factory=lambda config: fake_sdk)

    with pytest.raises(CodexError) as exc:
        await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    assert exc.value.code == "codex_bad_request"
    assert exc.value.http_status == 400
    assert fake_sdk.thread.calls == 1
    assert not [event for event in events if event["event"] == "codex_overload_retrying"]

async def test_sdk_backend_exhausts_turn_overload_with_distinct_code(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    sleeps: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    monkeypatch.setattr(codex_client.asyncio, "sleep", fake_sleep)

    class AlwaysOverloadedThread(FakeSdkThread):
        def __init__(self, thread_id: str) -> None:
            super().__init__(thread_id)
            self.calls = 0

        def turn(self, *args: Any, **kwargs: Any) -> FakeSdkTurn:
            self.calls += 1
            raise server_busy()

    class AlwaysOverloadedSdk(FakeSdk):
        def __init__(self) -> None:
            super().__init__()
            self.thread = AlwaysOverloadedThread("thread-overload")

        async def thread_start(self, **kwargs: Any) -> AlwaysOverloadedThread:
            return self.thread

    fake_sdk = AlwaysOverloadedSdk()
    events: list[dict[str, Any]] = []
    client = CodexSdkClient(
        CodexConfig(overload_max_attempts=3, overload_initial_delay_ms=100, overload_max_delay_ms=250),
        sdk_factory=lambda config: fake_sdk,
    )

    with pytest.raises(CodexError) as exc:
        await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    assert exc.value.code == "upstream_overloaded_exhausted"
    assert exc.value.http_status == 502
    assert fake_sdk.thread.calls == 3
    assert sleeps == [0.1, 0.2]
    assert events[-1]["event"] == "codex_overload_exhausted"
    assert events[-1]["attempts"] == 3
    assert events[-1]["http_status"] == 502

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

async def test_sdk_backend_runs_continuation_turns_on_same_thread(tmp_path: Path) -> None:
    class NumberedTurn:
        def __init__(self, turn_id: str) -> None:
            self.id = turn_id

        async def run(self) -> dict[str, Any]:
            return {
                "final_response": json.dumps(
                    {
                        "summary": self.id,
                        "test_commands": ["pytest -q"],
                        "changed_files": ["a.py"],
                        "remaining_risks": [],
                        "next_action": "ready_for_review",
                    }
                )
            }

    class MultiTurnThread(FakeSdkThread):
        def turn(self, *args: Any, **kwargs: Any) -> NumberedTurn:
            self.prompts.append((args, kwargs))
            return NumberedTurn(f"turn-{len(self.prompts)}")

    class MultiTurnSdk(FakeSdk):
        def __init__(self) -> None:
            super().__init__()
            self.thread = MultiTurnThread("thread-continuation")

        async def thread_start(self, **kwargs: Any) -> MultiTurnThread:
            self.started.append(kwargs)
            return self.thread

    fake_sdk = MultiTurnSdk()
    continuation_calls: list[int] = []

    def continuation_provider(turn_count: int) -> str | None:
        continuation_calls.append(turn_count)
        return f"Continue after turn {turn_count}"

    events: list[dict[str, Any]] = []
    client = CodexSdkClient(CodexConfig(), sdk_factory=lambda config: fake_sdk)

    result = await client.run_session(
        tmp_path,
        "Do work",
        "MT-1: Build",
        on_event=events.append,
        max_turns=3,
        continuation_provider=continuation_provider,
    )

    assert result.thread_id == "thread-continuation"
    assert result.turn_count == 1
    assert result.turn_id == "turn-1"
    assert result.session_id == "thread-continuation-turn-1"
    assert result.structured_result is not None
    assert result.structured_result["summary"] == "turn-1"
    assert continuation_calls == []
    assert [call[0][0] for call in fake_sdk.thread.prompts] == [
        "Do work",
    ]
    assert {event["thread_id"] for event in events if event["event"] == "turn_started"} == {"thread-continuation"}
    assert [event["turn_id"] for event in events if event["event"] == "turn_completed"] == [
        "turn-1",
    ]

async def test_sdk_backend_continues_until_structured_handoff(tmp_path: Path) -> None:
    class NumberedTurn:
        def __init__(self, turn_id: str) -> None:
            self.id = turn_id

        async def run(self) -> dict[str, Any]:
            if self.id == "turn-1":
                return {"final_response": "Implemented the first part, continuing."}
            return {
                "final_response": json.dumps(
                    {
                        "summary": self.id,
                        "test_commands": ["pytest -q"],
                        "changed_files": ["a.py"],
                        "remaining_risks": [],
                        "next_action": "ready_for_review",
                    }
                )
            }

    class MultiTurnThread(FakeSdkThread):
        def turn(self, *args: Any, **kwargs: Any) -> NumberedTurn:
            self.prompts.append((args, kwargs))
            return NumberedTurn(f"turn-{len(self.prompts)}")

    class MultiTurnSdk(FakeSdk):
        def __init__(self) -> None:
            super().__init__()
            self.thread = MultiTurnThread("thread-continuation")

        async def thread_start(self, **kwargs: Any) -> MultiTurnThread:
            self.started.append(kwargs)
            return self.thread

    fake_sdk = MultiTurnSdk()
    continuation_calls: list[int] = []

    def continuation_provider(turn_count: int) -> str | None:
        continuation_calls.append(turn_count)
        return f"Continue after turn {turn_count}"

    client = CodexSdkClient(CodexConfig(), sdk_factory=lambda config: fake_sdk)

    result = await client.run_session(
        tmp_path,
        "Do work",
        "MT-1: Build",
        max_turns=3,
        continuation_provider=continuation_provider,
    )

    assert result.turn_count == 2
    assert result.structured_result is not None
    assert result.structured_result["summary"] == "turn-2"
    assert continuation_calls == [1]
    assert [call[0][0] for call in fake_sdk.thread.prompts] == [
        "Do work",
        "Continue after turn 1",
    ]

async def test_sdk_backend_awaits_async_continuation_provider(tmp_path: Path) -> None:
    class NumberedTurn:
        def __init__(self, turn_id: str) -> None:
            self.id = turn_id

        async def run(self) -> dict[str, Any]:
            return {
                "final_response": json.dumps(
                    {
                        "summary": self.id,
                        "test_commands": [],
                        "changed_files": [],
                        "remaining_risks": [],
                        "next_action": "ready_for_review",
                    }
                )
            }

    class AsyncContinuationThread(FakeSdkThread):
        def turn(self, *args: Any, **kwargs: Any) -> NumberedTurn:
            self.prompts.append((args, kwargs))
            assert isinstance(args[0], str)
            return NumberedTurn(f"turn-{len(self.prompts)}")

    class AsyncContinuationSdk(FakeSdk):
        def __init__(self) -> None:
            super().__init__()
            self.thread = AsyncContinuationThread("thread-async-continuation")

        async def thread_start(self, **kwargs: Any) -> AsyncContinuationThread:
            self.started.append(kwargs)
            return self.thread

    fake_sdk = AsyncContinuationSdk()
    continuation_calls: list[int] = []

    async def continuation_provider(turn_count: int) -> str | None:
        continuation_calls.append(turn_count)
        if turn_count == 1:
            return "Continue from async provider"
        return None

    client = CodexSdkClient(CodexConfig(), sdk_factory=lambda config: fake_sdk)

    result = await client.run_session(
        tmp_path,
        "Do work",
        "MT-1: Build",
        max_turns=3,
        continuation_provider=continuation_provider,
    )

    assert result.turn_count == 1
    assert continuation_calls == []
    assert [call[0][0] for call in fake_sdk.thread.prompts] == [
        "Do work",
    ]

async def test_sdk_backend_resumes_existing_thread(tmp_path: Path) -> None:
    fake_sdk = FakeSdk()
    client = CodexSdkClient(CodexConfig(), sdk_factory=lambda config: fake_sdk)

    result = await client.run_session(tmp_path, "Continue", "MT-1: Build", existing_thread_id="thread-existing")

    assert result.thread_id == "thread-existing"
    assert fake_sdk.started == []
    assert fake_sdk.resumed == [("thread-existing", {"cwd": str(tmp_path)})]

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

async def test_sdk_backend_parses_custom_schema_final_response_without_default_shape(tmp_path: Path) -> None:
    class PlanTurn:
        id = "turn-1"

        async def run(self) -> dict[str, Any]:
            return {"final_response": '{"summary":"managed run","work_items":[],"approval_required":false}'}

    class PlanThread(FakeSdkThread):
        def turn(self, *args: Any, **kwargs: Any) -> PlanTurn:
            self.prompts.append((args, kwargs))
            return PlanTurn()

    class PlanSdk(FakeSdk):
        async def thread_start(self, **kwargs: Any) -> PlanThread:
            return PlanThread("thread-plan")

    client = CodexSdkClient(CodexConfig(), sdk_factory=lambda config: PlanSdk())

    result = await client.run_session(tmp_path, "Plan", "Managed Run", output_schema={"type": "object"})

    assert result.structured_result == {"summary": "managed run", "work_items": [], "approval_required": False}

async def test_sdk_backend_reasks_once_for_invalid_custom_schema_output(tmp_path: Path) -> None:
    class FlakyCustomThread(FakeSdkThread):
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

            class GoodTurn:
                id = "turn-good"

                async def run(self) -> dict[str, Any]:
                    return {"final_response": '{"score":4,"result":"pass"}'}

            return GoodTurn()

    class FlakyCustomSdk(FakeSdk):
        def __init__(self) -> None:
            super().__init__()
            self.thread = FlakyCustomThread("thread-custom")

        async def thread_start(self, **kwargs: Any) -> FlakyCustomThread:
            return self.thread

    fake_sdk = FlakyCustomSdk()
    events: list[dict[str, Any]] = []
    client = CodexSdkClient(CodexConfig(), sdk_factory=lambda config: fake_sdk)

    result = await client.run_session(tmp_path, "Gate", "Acceptance", on_event=events.append, output_schema={"type": "object"})

    assert result.structured_result == {"score": 4, "result": "pass"}
    assert fake_sdk.thread.calls == 2
    assert "previous response did not match" in fake_sdk.thread.prompts[1][0][0]
    assert [event["event"] for event in events if event["event"] == "turn_retrying"]

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

async def test_sdk_backend_retries_init_overload_with_http_status_event(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sleeps: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    monkeypatch.setattr(codex_client.asyncio, "sleep", fake_sleep)

    class OverloadedInitSdk(FakeSdk):
        def __init__(self) -> None:
            super().__init__()
            self.start_calls = 0

        async def thread_start(self, **kwargs: Any) -> FakeSdkThread:
            self.start_calls += 1
            if self.start_calls == 1:
                raise server_busy("upstream 503: provider overloaded")
            return FakeSdkThread("thread-recovered")

    fake_sdk = OverloadedInitSdk()
    events: list[dict[str, Any]] = []
    client = CodexSdkClient(
        CodexConfig(overload_max_attempts=2, overload_initial_delay_ms=100, overload_max_delay_ms=250),
        sdk_factory=lambda config: fake_sdk,
    )

    result = await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    assert result.thread_id == "thread-recovered"
    assert fake_sdk.start_calls == 2
    assert sleeps == [0.1]
    retry_events = [event for event in events if event["event"] == "codex_overload_retrying"]
    assert retry_events == [
        {
            "event": "codex_overload_retrying",
            "backend": "sdk",
            "attempt": 2,
            "delay_ms": 100,
            "http_status": 502,
            "message": "JSON-RPC error -32000: upstream 503: provider overloaded",
        }
    ]

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
