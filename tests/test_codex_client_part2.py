from test_codex_client_support import *  # noqa: F401,F403

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

async def test_sdk_backend_passes_config_overrides_to_sdk_config(tmp_path: Path, monkeypatch) -> None:
    captured: dict[str, Any] = {}

    class FakeSdkConfig:
        def __init__(self, *, codex_bin: str | None = None, env: dict[str, str] | None = None, config_overrides: tuple[str, ...] = ()) -> None:
            captured["config_kwargs"] = {
                "codex_bin": codex_bin,
                "env": env,
                "config_overrides": config_overrides,
            }

    class FakeAsyncCodex:
        def __init__(self, *, config: Any | None = None) -> None:
            captured["sdk_config"] = config

    monkeypatch.setitem(
        sys.modules,
        "openai_codex",
        SimpleNamespace(AsyncCodex=FakeAsyncCodex, CodexConfig=FakeSdkConfig),
    )

    client = CodexSdkClient(
        CodexConfig(
            sdk_codex_bin="/bin/sh",
            config_overrides=("model_provider=openai", "model_providers.openai.api_key=$OPENAI_API_KEY"),
        )
    )
    await client._client()

    assert captured["config_kwargs"]["config_overrides"] == (
        "model_provider=openai",
        "model_providers.openai.api_key=$OPENAI_API_KEY",
    )

async def test_sdk_backend_omits_config_overrides_for_older_sdk_config(tmp_path: Path, monkeypatch) -> None:
    captured: dict[str, Any] = {}

    class FakeSdkConfig:
        def __init__(self, *, codex_bin: str | None = None) -> None:
            captured["config_kwargs"] = {"codex_bin": codex_bin}

    class FakeAsyncCodex:
        def __init__(self, *, config: Any | None = None) -> None:
            captured["sdk_config"] = config

    monkeypatch.setitem(
        sys.modules,
        "openai_codex",
        SimpleNamespace(AsyncCodex=FakeAsyncCodex, CodexConfig=FakeSdkConfig),
    )

    client = CodexSdkClient(CodexConfig(sdk_codex_bin="/bin/sh", config_overrides=("model_provider=openai",)))
    await client._client()

    assert captured["config_kwargs"] == {"codex_bin": "/bin/sh"}

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
