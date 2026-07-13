from __future__ import annotations

import asyncio
from pathlib import Path
import stat
import subprocess
from types import SimpleNamespace
from typing import Any, cast

import pytest

import performer.backends.codex as codex_backend
from performer_api import (
    CONTROL_PROTOCOL_VERSION,
    PerformerCapabilities,
    PerformerAccountState,
    PerformerControlRequest,
    PerformerControlResult,
    PerformerSecretInput,
    PerformerLoginState,
    PerformerReadinessState,
    PerformerTurnRequest,
    PerformerTurnResult,
    Plan,
    RuntimePolicy,
    Task,
    TURN_PROTOCOL_VERSION,
    TurnContext,
    canonical_sha256,
)

from performer.backend_interface import PerformerBackend
from performer.backend_registry import (
    BackendRegistry,
    DEFAULT_BACKEND_REGISTRY,
    PerformerBackendRegistryError,
)
from performer.backends.codex import CodexBackend, _configuration_snapshot
from performer.backend_interface import PerformerBackendError


class FakeBackend:
    @property
    def kind(self) -> str:
        return "codex"

    def capabilities(self) -> PerformerCapabilities:
        return PerformerCapabilities(
            protocol_version=CONTROL_PROTOCOL_VERSION,
            capability_version=1,
            performer_kind="codex",
            display_name="Deterministic fake",
            turn_kinds=("plan", "execute", "gate"),
            login_methods=(),
            supports_session_delete=False,
            editable_settings=(),
            config_source_visible=False,
            check_supported=False,
        )

    async def control(
        self,
        request: PerformerControlRequest,
        secret_input: bytes | None,
        *,
        emit_event=None,
    ) -> PerformerControlResult:
        del secret_input, emit_event
        if request.operation == "performer.status":
            return PerformerControlResult(
                protocol_version=CONTROL_PROTOCOL_VERSION,
                request_id=request.request_id,
                operation=request.operation,
                status="succeeded",
                capabilities=self.capabilities(),
                readiness=PerformerReadinessState(
                    performer_kind="codex",
                    binding_generation=1,
                    capability_version=1,
                    execution_policy_sha256="0" * 64,
                    status="unchecked",
                    last_check_status="none",
                    error=None,
                ),
                account=PerformerAccountState(status="unknown", display_label=None),
                login=PerformerLoginState(status="idle", method=None),
                configuration=None,
                check=None,
                error=None,
            )
        raise AssertionError(f"No control fixture for {request.operation}")

    async def run_turn(self, request: PerformerTurnRequest) -> PerformerTurnResult:
        if request.context.turn_kind != "plan":
            raise AssertionError(f"No turn fixture for {request.context.turn_kind}")
        return PerformerTurnResult(
            protocol_version=request.protocol_version,
            context=request.context,
            thread_id="fake-thread",
            plan=Plan(
                summary="Fake plan",
                tasks=[
                    Task(
                        id="task-1",
                        title="Fake task",
                        objective="Exercise the shared turn contract",
                        acceptance_criteria=["The fake result validates"],
                        verification_commands=["pytest -q"],
                        files_likely_touched=["src/module.py"],
                    )
                ],
                risks=[],
                architecture_decisions=[],
                open_questions=[],
                approval_required=False,
            ),
            execute_result=None,
            gate_result=None,
            runtime_wait=None,
            events=(),
        )


def test_performer_backend_protocol_is_private_and_structural() -> None:
    backend: PerformerBackend = FakeBackend()

    assert backend.kind == "codex"
    assert backend.capabilities().performer_kind == "codex"


@pytest.mark.asyncio
async def test_fake_backend_completes_control_and_turn_through_same_contract(
    tmp_path: Path,
) -> None:
    backend: PerformerBackend = FakeBackend()
    control = await backend.control(
        PerformerControlRequest(
            protocol_version=CONTROL_PROTOCOL_VERSION,
            request_id="request-1",
            operation="performer.status",
            performer_kind="codex",
            arguments={},
            secret_input=None,
        ),
        None,
    )
    turn = await backend.run_turn(_plan_request(tmp_path))

    assert control.status == "succeeded"
    assert turn.plan is not None
    assert turn.plan.summary == "Fake plan"


def test_registry_creates_only_an_exact_injected_backend_kind() -> None:
    instance = FakeBackend()
    registry = BackendRegistry({"codex": lambda: instance})

    selected = registry.create("codex")

    assert selected is instance


def test_registry_rejects_unknown_kind_without_fallback() -> None:
    fallback_was_called = False

    def factory() -> PerformerBackend:
        nonlocal fallback_was_called
        fallback_was_called = True
        return cast(PerformerBackend, FakeBackend())

    registry = BackendRegistry({"codex": factory})

    with pytest.raises(PerformerBackendRegistryError) as exc_info:
        registry.create("claude")

    assert exc_info.value.code == "performer_backend_unsupported"
    assert str(exc_info.value) == "The requested Performer backend is not supported."
    assert fallback_was_called is False


def test_registry_rejects_factory_returning_a_different_kind() -> None:
    class WrongKindBackend(FakeBackend):
        @property
        def kind(self) -> str:
            return "claude"

    registry = BackendRegistry({"codex": WrongKindBackend})

    with pytest.raises(PerformerBackendRegistryError) as exc_info:
        registry.create("codex")

    assert exc_info.value.code == "performer_backend_kind_mismatch"


def test_production_registry_contains_only_codex() -> None:
    backend = DEFAULT_BACKEND_REGISTRY.create("codex")

    assert isinstance(backend, CodexBackend)
    with pytest.raises(PerformerBackendRegistryError):
        DEFAULT_BACKEND_REGISTRY.create("claude")


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


def _plan_request(workspace: Path) -> PerformerTurnRequest:
    workspace.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "init", "-q", str(workspace)],
        check=True,
        capture_output=True,
    )
    policy = RuntimePolicy.from_dict(EXECUTION_POLICY)
    policy_hash = canonical_sha256(policy.to_dict())
    return PerformerTurnRequest(
        protocol_version=TURN_PROTOCOL_VERSION,
        context=TurnContext(
            run_id="run-1",
            task_id="",
            attempt_id="attempt-1",
            fencing_token=1,
            turn_kind="plan",
        ),
        performer_kind="codex",
        performer_binding_id="binding-1",
        binding_generation=1,
        execution_policy=policy.to_dict(),
        execution_policy_sha256=policy_hash,
        turn_policy_sha256="a" * 64,
        workspace_path=str(workspace.resolve()),
        thread_id="",
        issue_description="Implement the bounded task.",
        task=None,
        evidence=None,
    )


@pytest.mark.asyncio
async def test_codex_backend_maps_policy_and_returns_only_shared_turn_contract(
    tmp_path: Path,
) -> None:
    captured: dict[str, Any] = {}

    class FakeClient:
        async def run_session(self, workspace: Path, prompt: str, **kwargs: Any) -> Any:
            captured.update(
                workspace=workspace,
                prompt=prompt,
                kwargs=kwargs,
            )
            return SimpleNamespace(
                thread_id="thread-1",
                structured_result={
                    "summary": "Bounded plan",
                    "tasks": [
                        {
                            "id": "task-1",
                            "title": "Implement",
                            "objective": "Implement the bounded task",
                            "acceptance_criteria": ["Focused tests pass"],
                            "verification_commands": ["pytest -q"],
                            "files_likely_touched": ["src/module.py"],
                        }
                    ],
                    "risks": [],
                    "architecture_decisions": [],
                    "open_questions": [],
                    "approval_required": False,
                },
                events=[
                    {
                        "event": "sdk_session_starting",
                        "cwd": "/private/provider/workspace",
                        "payload": {"raw": "must-not-cross"},
                    }
                ],
            )

    def client_factory(config):
        captured["config"] = config
        return FakeClient()

    backend = CodexBackend(client_factory=client_factory)

    result = await backend.run_turn(_plan_request(tmp_path))

    assert isinstance(result, PerformerTurnResult)
    assert result.plan is not None
    assert result.plan.tasks[0].id == "task-1"
    config = captured["config"]
    assert config.model == "gpt-5.4"
    assert config.model_provider == "openai"
    assert config.approval_mode == "auto_review"
    assert config.reasoning_effort == "high"
    assert config.reasoning_summary == "auto"
    assert config.sandbox == "read_only"
    assert config.initialize_timeout_ms == 5_000
    assert config.turn_timeout_ms == 3_600_000
    assert config.initialize_max_attempts == 4
    assert config.overload_max_attempts == 5
    serialized = result.to_dict()
    assert "/private/provider/workspace" not in str(serialized)
    assert "must-not-cross" not in str(serialized)


@pytest.mark.asyncio
async def test_codex_backend_normalizes_runtime_wait_without_raw_sdk_payload(
    tmp_path: Path,
) -> None:
    class FakeClient:
        async def run_session(self, *_args: Any, **_kwargs: Any) -> Any:
            return SimpleNamespace(
                thread_id="thread-1",
                structured_result={},
                events=[
                    {
                        "event": "sdk_item_autoApprovalReview_started",
                        "payload": {
                            "type": "item/autoApprovalReview/started",
                            "reviewId": "review-1",
                            "action": {
                                "type": "requestPermissions",
                                "reason": "Need workspace permission.",
                            },
                            "providerInternal": "must-not-cross",
                        },
                    }
                ],
            )

    backend = CodexBackend(client_factory=lambda _config: FakeClient())

    result = await backend.run_turn(_plan_request(tmp_path))

    assert result.runtime_wait is not None
    assert result.runtime_wait.kind == "permission_required"
    assert result.runtime_wait.reason == "Need workspace permission."
    assert "must-not-cross" not in str(result.to_dict())


@pytest.mark.asyncio
async def test_codex_backend_sanitizes_provider_exception_text(tmp_path: Path) -> None:
    class FailingClient:
        async def run_session(self, *_args: Any, **_kwargs: Any) -> Any:
            raise RuntimeError("provider failed token=secret-value /private/provider/path")

    backend = CodexBackend(client_factory=lambda _config: FailingClient())

    with pytest.raises(PerformerBackendError) as exc_info:
        await backend.run_turn(_plan_request(tmp_path))

    assert exc_info.value.code == "sdk_transport_error"
    assert "secret-value" not in str(exc_info.value)
    assert "/private/provider/path" not in str(exc_info.value)


def _control_request(
    request_id: str,
    operation: str,
    arguments: dict[str, Any],
) -> PerformerControlRequest:
    return PerformerControlRequest(
        protocol_version=CONTROL_PROTOCOL_VERSION,
        request_id=request_id,
        operation=operation,
        performer_kind="codex",
        arguments=arguments,
        secret_input=None,
    )


class _FakeDeviceHandle:
    verification_url = "https://example.test/device"
    user_code = "ABCD-EFGH"

    async def wait(self) -> Any:
        return SimpleNamespace(success=True)

    async def cancel(self) -> None:
        return None


class _FakeControlSdk:
    def __init__(self, *, api_key: str | None = None) -> None:
        self.api_key = api_key
        self.closed = False
        self.login_calls: list[str] = []

    async def __aenter__(self) -> "_FakeControlSdk":
        return self

    async def __aexit__(self, *_args: Any) -> None:
        self.closed = True

    async def account(self) -> Any:
        return SimpleNamespace(account=None)

    async def login_api_key(self, value: str) -> None:
        self.login_calls.append(value)

    async def login_chatgpt_device_code(self) -> _FakeDeviceHandle:
        return _FakeDeviceHandle()

    async def logout(self) -> None:
        return None


@pytest.mark.asyncio
async def test_codex_control_status_and_api_key_secret_stay_provider_neutral() -> None:
    sdk = _FakeControlSdk()
    backend = CodexBackend(sdk_factory=lambda _config: sdk)
    status = await backend.control(
        _control_request("status-1", "performer.status", {}),
        None,
    )
    assert status.status == "succeeded"
    assert status.capabilities is not None
    assert status.account is not None and status.account.status == "logged_out"

    secret = b"sk-control-secret-sentinel"
    login = await backend.control(
        PerformerControlRequest(
            protocol_version=CONTROL_PROTOCOL_VERSION,
            request_id="login-1",
            operation="performer.login",
            performer_kind="codex",
            arguments={"method": "api_key"},
            secret_input=PerformerSecretInput(kind="api_key", length=len(secret)),
        ),
        secret,
    )
    assert login.status == "succeeded"
    assert sdk.login_calls == [secret.decode()]
    assert secret.decode() not in str(login.to_dict())


@pytest.mark.asyncio
async def test_codex_control_device_login_emits_pending_and_terminal_events() -> None:
    sdk = _FakeControlSdk()
    backend = CodexBackend(sdk_factory=lambda _config: sdk)
    events: list[Any] = []
    result = await backend.control(
        _control_request("login-device", "performer.login", {"method": "device_code"}),
        None,
        emit_event=events.append,
    )
    assert result.login is not None and result.login.status == "pending"
    await asyncio.sleep(0)
    assert [event.event_kind for event in events] == ["login.pending", "login.succeeded"]


def _check_control_request(request_id: str = "check-1") -> PerformerControlRequest:
    policy = RuntimePolicy.from_dict(EXECUTION_POLICY)
    return _control_request(
        request_id,
        "performer.check",
        {
            "binding_generation": 1,
            "execution_policy": policy.to_dict(),
            "execution_policy_sha256": canonical_sha256(policy.to_dict()),
        },
    )


def _check_control_request_with_timeouts(
    *,
    initialize_timeout_ms: int = 5_000,
    turn_timeout_ms: int = 3_600_000,
) -> PerformerControlRequest:
    policy_payload = {
        **EXECUTION_POLICY,
        "initialize_timeout_ms": initialize_timeout_ms,
        "turn_timeout_ms": turn_timeout_ms,
    }
    policy = RuntimePolicy.from_dict(policy_payload)
    return _control_request(
        "check-timeout",
        "performer.check",
        {
            "binding_generation": 1,
            "execution_policy": policy.to_dict(),
            "execution_policy_sha256": canonical_sha256(policy.to_dict()),
        },
    )


@pytest.mark.asyncio
async def test_codex_check_consumes_async_turn_handle_before_reading_final_response() -> None:
    class Handle:
        def __init__(self) -> None:
            self.run_called = False

        async def run(self) -> Any:
            self.run_called = True
            return SimpleNamespace(final_response='{"ok":true}')

    class Thread:
        def __init__(self, handle: Handle) -> None:
            self.handle = handle

        async def turn(self, *_args: Any, **_kwargs: Any) -> Handle:
            return self.handle

    class Sdk:
        def __init__(self, handle: Handle) -> None:
            self.handle = handle

        async def thread_start(self, **_kwargs: Any) -> Thread:
            return Thread(self.handle)

        async def close(self) -> None:
            return None

    handle = Handle()
    backend = CodexBackend(sdk_factory=lambda _config: Sdk(handle))

    result = await backend.control(_check_control_request(), None)

    assert handle.run_called is True
    assert result.check is not None and result.check.status == "passed"
    assert result.readiness is not None and result.readiness.status == "ready"


@pytest.mark.asyncio
async def test_codex_check_emits_immediate_and_periodic_heartbeats_until_completion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(codex_backend, "_CONTROL_HEARTBEAT_INTERVAL_SECONDS", 0.01)
    release = asyncio.Event()

    class Handle:
        async def run(self) -> Any:
            await release.wait()
            return SimpleNamespace(final_response='{"ok":true}')

    class Thread:
        async def turn(self, *_args: Any, **_kwargs: Any) -> Handle:
            return Handle()

    class Sdk:
        async def thread_start(self, **_kwargs: Any) -> Thread:
            return Thread()

        async def close(self) -> None:
            return None

    events: list[Any] = []
    backend = CodexBackend(sdk_factory=lambda _config: Sdk())
    task = asyncio.create_task(
        backend.control(
            _check_control_request(),
            None,
            emit_event=events.append,
        )
    )

    for _ in range(20):
        if len(events) >= 2:
            break
        await asyncio.sleep(0.01)

    assert [event.event_kind for event in events[:2]] == [
        "control.heartbeat",
        "control.heartbeat",
    ]
    assert [event.sequence for event in events[:2]] == [1, 2]

    release.set()
    result = await task
    event_count = len(events)
    await asyncio.sleep(0.03)

    assert result.check is not None and result.check.status == "passed"
    assert len(events) == event_count


@pytest.mark.asyncio
@pytest.mark.parametrize("blocked_phase", ["sdk_enter", "thread_start"])
async def test_codex_check_applies_initialize_timeout_without_provider_details(
    blocked_phase: str,
) -> None:
    sentinel = "provider-initialize-secret-sentinel"

    class Sdk:
        async def __aenter__(self) -> "Sdk":
            if blocked_phase == "sdk_enter":
                await asyncio.Event().wait()
            return self

        async def thread_start(self, **_kwargs: Any) -> Any:
            if blocked_phase == "thread_start":
                await asyncio.Event().wait()
            raise RuntimeError(f"unexpected continuation {sentinel}")

        async def close(self) -> None:
            return None

    backend = CodexBackend(sdk_factory=lambda _config: Sdk())

    result = await asyncio.wait_for(
        backend.control(
            _check_control_request_with_timeouts(initialize_timeout_ms=10),
            None,
        ),
        timeout=0.5,
    )

    assert result.status == "succeeded"
    assert result.check is not None and result.check.status == "failed"
    assert result.readiness is not None and result.readiness.status == "failed"
    assert result.readiness.error is not None
    assert result.readiness.error.error_code == "performer_check_timeout"
    assert sentinel not in str(result.to_dict())


@pytest.mark.asyncio
async def test_codex_check_applies_turn_timeout_without_provider_details(
    caplog: pytest.LogCaptureFixture,
) -> None:
    sentinel = "provider-turn-secret-sentinel"

    class Handle:
        async def run(self) -> Any:
            await asyncio.Event().wait()
            raise RuntimeError(sentinel)

    class Thread:
        async def turn(self, *_args: Any, **_kwargs: Any) -> Handle:
            return Handle()

    class Sdk:
        async def thread_start(self, **_kwargs: Any) -> Thread:
            return Thread()

        async def close(self) -> None:
            return None

    backend = CodexBackend(sdk_factory=lambda _config: Sdk())

    result = await asyncio.wait_for(
        backend.control(
            _check_control_request_with_timeouts(turn_timeout_ms=10),
            None,
        ),
        timeout=0.5,
    )

    assert result.status == "succeeded"
    assert result.check is not None and result.check.status == "failed"
    assert result.readiness is not None and result.readiness.status == "failed"
    assert result.readiness.error is not None
    assert result.readiness.error.error_code == "performer_check_timeout"
    evidence = str(result.to_dict()) + caplog.text
    assert sentinel not in evidence
    assert "performer_check_timeout" in caplog.text


@pytest.mark.asyncio
async def test_codex_check_surfaces_sanitized_authentication_category(
    caplog: pytest.LogCaptureFixture,
) -> None:
    sentinel = "provider-check-secret-sentinel"

    class Sdk:
        async def thread_start(self, **_kwargs: Any) -> Any:
            raise RuntimeError(f"authentication failed token={sentinel}")

        async def close(self) -> None:
            return None

    backend = CodexBackend(sdk_factory=lambda _config: Sdk())

    result = await backend.control(_check_control_request(), None)

    assert result.check is not None and result.check.status == "failed"
    assert result.readiness is not None and result.readiness.status == "failed"
    assert result.readiness.error is not None
    assert result.readiness.error.error_code == "performer_check_failed"
    assert result.readiness.error.sanitized_reason == (
        "Codex Check failed: Codex authentication failed."
    )
    evidence = str(result.to_dict()) + caplog.text
    assert sentinel not in evidence
    assert "performer_check_failed" in caplog.text


def test_codex_config_snapshot_maps_only_openai_base_url() -> None:
    unrelated_provider = _configuration_snapshot(
        '[model_providers.other]\nbase_url = "https://other.example.test/v1"\n'
    )
    explicit_openai = _configuration_snapshot(
        'openai_base_url = "https://api.example.test/v1"\n'
        '[model_providers.other]\nbase_url = "https://other.example.test/v1"\n'
    )

    assert unrelated_provider.settings == {}
    assert explicit_openai.settings == {
        "api_base_url": "https://api.example.test/v1"
    }


@pytest.mark.parametrize(
    "source",
    [
        'http_headers = { "X-Api-Key" = "sentinel-secret-value" }\n',
        'env = { "OPENAI_API_KEY" = "sentinel-secret-value" }\n',
        '[provider]\n"Authorization" = "custom-secret-sentinel"\n',
    ],
)
def test_codex_config_snapshot_redacts_nested_and_quoted_secret_values(
    source: str,
) -> None:
    snapshot = _configuration_snapshot(source)

    assert snapshot.source_text is not None
    assert "sentinel" not in snapshot.source_text
    assert "[REDACTED" in snapshot.source_text


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", ["content", "mode", "untracked"])
async def test_plan_turn_detects_changes_to_preexisting_dirty_workspace_state(
    tmp_path: Path,
    mutation: str,
) -> None:
    subprocess.run(["git", "init", "--quiet", str(tmp_path)], check=True)
    tracked = tmp_path / "tracked.txt"
    tracked.write_text("tracked baseline\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(tmp_path), "add", "tracked.txt"], check=True)
    tracked.write_text("dirty before turn\n", encoding="utf-8")
    untracked = tmp_path / "untracked.txt"
    if mutation == "untracked":
        untracked.write_text("untracked before turn\n", encoding="utf-8")

    class MutatingClient:
        async def run_session(self, *_args: Any, **_kwargs: Any) -> Any:
            if mutation == "content":
                tracked.write_text("dirty changed during turn\n", encoding="utf-8")
            elif mutation == "mode":
                tracked.chmod(tracked.stat().st_mode | stat.S_IXUSR)
            else:
                untracked.write_text("untracked changed during turn\n", encoding="utf-8")
            return SimpleNamespace(
                thread_id="thread-1",
                structured_result={
                    "summary": "Bounded plan",
                    "tasks": [
                        {
                            "id": "task-1",
                            "title": "Implement",
                            "objective": "Implement the bounded task",
                            "acceptance_criteria": ["Focused tests pass"],
                            "verification_commands": ["pytest -q"],
                            "files_likely_touched": ["tracked.txt"],
                        }
                    ],
                    "risks": [],
                    "architecture_decisions": [],
                    "open_questions": [],
                    "approval_required": False,
                },
                events=[],
            )

    backend = CodexBackend(client_factory=lambda _config: MutatingClient())

    with pytest.raises(PerformerBackendError) as exc_info:
        await backend.run_turn(_plan_request(tmp_path))

    assert exc_info.value.code == "plan_turn_changed_files"


@pytest.mark.asyncio
async def test_plan_runtime_wait_cannot_bypass_the_read_only_workspace_fence(
    tmp_path: Path,
) -> None:
    subprocess.run(["git", "init", "--quiet", str(tmp_path)], check=True)
    tracked = tmp_path / "tracked.txt"
    tracked.write_text("baseline\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(tmp_path), "add", "tracked.txt"], check=True)

    class WaitingClient:
        async def run_session(self, *_args: Any, **_kwargs: Any) -> Any:
            tracked.write_text("modified before runtime wait\n", encoding="utf-8")
            return SimpleNamespace(
                thread_id="thread-1",
                structured_result={},
                events=[
                    {
                        "event": "sdk_item_autoApprovalReview_started",
                        "payload": {
                            "type": "item/autoApprovalReview/started",
                            "reviewId": "review-1",
                            "action": {"type": "requestPermissions"},
                        },
                    }
                ],
            )

    backend = CodexBackend(client_factory=lambda _config: WaitingClient())

    with pytest.raises(PerformerBackendError) as exc_info:
        await backend.run_turn(_plan_request(tmp_path))

    assert exc_info.value.code == "plan_turn_changed_files"


@pytest.mark.asyncio
async def test_codex_status_surfaces_account_failure_without_provider_details(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class FailingSdk(_FakeControlSdk):
        async def account(self) -> Any:
            raise RuntimeError("account failed token=provider-secret-sentinel")

    backend = CodexBackend(sdk_factory=lambda _config: FailingSdk())

    result = await backend.control(
        _control_request("status-failed", "performer.status", {}),
        None,
    )

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.error_code == "performer_backend_setup_failed"
    evidence = str(result.to_dict()) + caplog.text
    assert "provider-secret-sentinel" not in evidence
    assert "performer_backend_setup_failed" in caplog.text
    assert "action_required=true" in caplog.text


@pytest.mark.asyncio
async def test_device_login_terminal_event_keeps_original_request_sink() -> None:
    completion: asyncio.Future[Any] = asyncio.get_running_loop().create_future()

    class Handle(_FakeDeviceHandle):
        async def wait(self) -> Any:
            return await completion

    class Sdk(_FakeControlSdk):
        async def login_chatgpt_device_code(self) -> Handle:
            return Handle()

    backend = CodexBackend(sdk_factory=lambda _config: Sdk())
    login_events: list[Any] = []
    status_events: list[Any] = []
    login = await backend.control(
        _control_request("login-owned", "performer.login", {"method": "device_code"}),
        None,
        emit_event=login_events.append,
    )
    assert login.login is not None and login.login.status == "pending"

    await backend.control(
        _control_request("status-observer", "performer.status", {}),
        None,
        emit_event=status_events.append,
    )
    completion.set_result(SimpleNamespace(success=True))
    await asyncio.sleep(0)

    assert [event.event_kind for event in login_events] == [
        "login.pending",
        "login.succeeded",
    ]
    assert status_events == []


@pytest.mark.asyncio
async def test_device_login_failure_emits_terminal_event_and_clears_pending_state() -> None:
    class Handle(_FakeDeviceHandle):
        async def wait(self) -> Any:
            raise RuntimeError("provider detail must not cross")

    class Sdk(_FakeControlSdk):
        async def login_chatgpt_device_code(self) -> Handle:
            return Handle()

    backend = CodexBackend(sdk_factory=lambda _config: Sdk())
    events: list[Any] = []
    await backend.control(
        _control_request("login-failed", "performer.login", {"method": "device_code"}),
        None,
        emit_event=events.append,
    )
    await asyncio.sleep(0)
    status = await backend.control(
        _control_request("status-after-failure", "performer.status", {}),
        None,
    )

    assert [event.event_kind for event in events] == ["login.pending", "login.failed"]
    assert status.login is not None and status.login.status == "failed"
    assert status.readiness is not None
    assert status.readiness.status == "failed"
    assert status.readiness.last_check_status == "none"
    assert status.readiness.error is not None
    assert status.readiness.error.error_code == "performer_login_failed"
    assert status.readiness.error.sanitized_reason == "Performer device login failed."
    assert status.readiness.error.action_required is True
    assert status.readiness.error.retryable is True
    assert status.readiness.error.next_action == "Retry device login."
    assert "provider detail" not in str(status.to_dict())
