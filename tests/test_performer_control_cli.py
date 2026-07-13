from __future__ import annotations

import asyncio
import io
import json
import os
import struct
import threading
from typing import Any

import pytest

from performer.control_host import (
    MAX_CONTROL_METADATA_BYTES,
    encode_metadata_frame,
    encode_secret_frame,
    run_control_host,
)
from performer_api.performer_control import (
    PerformerAccountState,
    PerformerCapabilities,
    PerformerControlError,
    PerformerControlEvent,
    PerformerCheckOutcome,
    PerformerControlRequest,
    PerformerControlResult,
    PerformerLoginState,
    PerformerReadinessState,
    PerformerSecretInput,
)
from performer_api.runtime_policy import canonical_sha256


POLICY_HASH = "a" * 64


def _request(
    request_id: str,
    operation: str,
    arguments: dict[str, Any],
    *,
    secret_length: int | None = None,
) -> PerformerControlRequest:
    return PerformerControlRequest(
        protocol_version=1,
        request_id=request_id,
        operation=operation,
        performer_kind="codex",
        arguments=arguments,
        secret_input=(
            PerformerSecretInput(kind="api_key", length=secret_length)
            if secret_length is not None
            else None
        ),
    )


def _readiness() -> PerformerReadinessState:
    return PerformerReadinessState(
        performer_kind="codex",
        binding_generation=1,
        capability_version=1,
        execution_policy_sha256=POLICY_HASH,
        status="unchecked",
        last_check_status="none",
        error=None,
    )


def _capabilities() -> PerformerCapabilities:
    return PerformerCapabilities(
        protocol_version=1,
        capability_version=1,
        performer_kind="codex",
        display_name="Codex",
        turn_kinds=("plan", "execute", "gate"),
        login_methods=("device_code", "api_key"),
        supports_session_delete=True,
        editable_settings=("api_base_url",),
        config_source_visible=True,
        check_supported=True,
    )


class FakeDeviceBackend:
    kind = "codex"

    def __init__(self) -> None:
        self.login_status = "idle"

    def capabilities(self) -> PerformerCapabilities:
        return _capabilities()

    async def control(
        self,
        request: PerformerControlRequest,
        secret_input: bytes | None,
        *,
        emit_event: Any = None,
    ) -> PerformerControlResult:
        assert secret_input is None
        if request.operation == "performer.login":
            assert emit_event is not None
            self.login_status = "pending"
            return _success(request, login_status="pending")
        assert emit_event is None
        if request.operation == "performer.session.delete":
            self.login_status = "idle"
            return _success(request, login_status="idle", include_account=True)
        return _success(
            request,
            login_status=self.login_status,
            include_status_fields=True,
        )


def _success(
    request: PerformerControlRequest,
    *,
    login_status: str,
    include_status_fields: bool = False,
    include_account: bool = False,
) -> PerformerControlResult:
    return PerformerControlResult(
        protocol_version=1,
        request_id=request.request_id,
        operation=request.operation,
        status="succeeded",
        capabilities=_capabilities() if include_status_fields else None,
        readiness=_readiness(),
        account=(
            PerformerAccountState(status="logged_out", display_label=None)
            if include_status_fields or include_account
            else None
        ),
        login=PerformerLoginState(
            status=login_status,
            method="device_code" if login_status == "pending" else None,
        ),
        configuration=None,
        check=None,
        error=None,
    )


def _run(backend: Any, stdin_bytes: bytes) -> tuple[int, bytes, bytes]:
    stdout = io.BytesIO()
    stderr = io.BytesIO()
    exit_code = asyncio.run(
        run_control_host(
            backend,
            stdin=io.BytesIO(stdin_bytes),
            stdout=stdout,
            stderr=stderr,
        )
    )
    return exit_code, stdout.getvalue(), stderr.getvalue()


def _stdout_frames(stdout: bytes) -> list[dict[str, Any]]:
    return [json.loads(line) for line in stdout.splitlines()]


def test_device_login_can_be_started_inspected_and_cancelled_in_one_host() -> None:
    requests = (
        _request("login-1", "performer.login", {"method": "device_code"}),
        _request("status-1", "performer.status", {}),
        _request(
            "cancel-1",
            "performer.session.delete",
            {"action": "cancel_login"},
        ),
    )

    exit_code, stdout, stderr = _run(
        FakeDeviceBackend(),
        b"".join(encode_metadata_frame(request) for request in requests),
    )

    frames = _stdout_frames(stdout)
    assert exit_code == 0
    assert stderr == b""
    assert [frame["frame_kind"] for frame in frames] == ["control.result"] * 3
    assert [frame["payload"]["request_id"] for frame in frames] == [
        "login-1",
        "status-1",
        "cancel-1",
    ]
    assert frames[0]["payload"]["login"] == {
        "status": "pending",
        "method": "device_code",
    }
    assert frames[1]["payload"]["login"] == {
        "status": "pending",
        "method": "device_code",
    }
    assert frames[2]["payload"]["login"] == {"status": "idle", "method": None}


def test_api_key_secret_is_passed_only_in_separate_frame_and_never_echoed() -> None:
    sentinel = b"sk-control-sentinel-never-echo"
    request = _request(
        "login-secret",
        "performer.login",
        {"method": "api_key"},
        secret_length=len(sentinel),
    )

    class ExplodingBackend:
        kind = "codex"

        async def control(
            self,
            received: PerformerControlRequest,
            secret_input: bytes | None,
            *,
            emit_event: Any = None,
        ) -> PerformerControlResult:
            assert received == request
            assert secret_input == sentinel
            assert emit_event is not None
            raise RuntimeError(f"provider rejected {secret_input!r}")

    exit_code, stdout, stderr = _run(
        ExplodingBackend(),
        encode_metadata_frame(request) + encode_secret_frame(sentinel),
    )

    combined = stdout + stderr
    frames = _stdout_frames(stdout)
    assert exit_code == 0
    assert sentinel not in combined
    assert frames[0]["payload"]["status"] == "failed"
    assert frames[0]["payload"]["error"]["error_code"] == "performer_control_failed"
    assert frames[0]["payload"]["error"]["sanitized_reason"] == (
        "The Performer control operation failed."
    )


@pytest.mark.parametrize(
    "stdin_bytes",
    [
        struct.pack(">I", 1) + b"{",
        struct.pack(">I", MAX_CONTROL_METADATA_BYTES + 1),
        encode_metadata_frame(
            {
                "protocol_version": 1,
                "request_id": "unknown-1",
                "operation": "performer.provider.raw",
                "performer_kind": "codex",
                "arguments": {},
                "secret_input": None,
            }
        ),
    ],
    ids=["malformed-json", "oversized", "unknown-operation"],
)
def test_malformed_unknown_and_oversized_metadata_fail_closed(
    stdin_bytes: bytes,
) -> None:
    exit_code, stdout, stderr = _run(FakeDeviceBackend(), stdin_bytes)

    assert exit_code == 1
    assert stdout == b""
    assert b"performer_control_protocol_invalid" in stderr
    assert b"Traceback" not in stderr


def test_secret_frame_length_mismatch_fails_closed_without_backend_call() -> None:
    sentinel = b"secret-length-mismatch"
    request = _request(
        "login-mismatch",
        "performer.login",
        {"method": "api_key"},
        secret_length=len(sentinel) + 1,
    )
    backend = FakeDeviceBackend()

    exit_code, stdout, stderr = _run(
        backend,
        encode_metadata_frame(request) + encode_secret_frame(sentinel),
    )

    assert exit_code == 1
    assert stdout == b""
    assert sentinel not in stderr
    assert b"performer_control_protocol_invalid" in stderr


def test_backend_result_must_match_the_request_and_frozen_contract() -> None:
    request = _request("status-expected", "performer.status", {})

    class MismatchedBackend:
        kind = "codex"

        async def control(
            self,
            received: PerformerControlRequest,
            secret_input: bytes | None,
            *,
            emit_event: Any = None,
        ) -> PerformerControlResult:
            assert emit_event is None
            return _success(
                _request("status-wrong", "performer.status", {}),
                login_status="idle",
                include_status_fields=True,
            )

    exit_code, stdout, stderr = _run(
        MismatchedBackend(),
        encode_metadata_frame(request),
    )

    assert exit_code == 1
    assert stdout == b""
    assert b"performer_control_protocol_invalid" in stderr


def test_backend_cannot_emit_raw_unknown_fields_paths_or_base64() -> None:
    request = _request("status-raw", "performer.status", {})

    class RawBackend:
        kind = "codex"

        async def control(self, *_: Any, **__: Any) -> Any:
            return {
                **_success(
                    request,
                    login_status="idle",
                    include_status_fields=True,
                ).to_dict(),
                "sdk_response": {
                    "config_path": "/Users/private/.codex/auth.json",
                    "content_base64": "c2VjcmV0",
                },
            }

    exit_code, stdout, stderr = _run(
        RawBackend(),
        encode_metadata_frame(request),
    )

    assert exit_code == 1
    assert stdout == b""
    assert b"/Users/private" not in stderr
    assert b"c2VjcmV0" not in stderr
    assert b"performer_control_protocol_invalid" in stderr


def test_protocol_failure_stderr_is_closed_structured_json() -> None:
    exit_code, stdout, stderr = _run(
        FakeDeviceBackend(),
        struct.pack(">I", 1) + b"{",
    )

    log = json.loads(stderr)
    assert exit_code == 1
    assert stdout == b""
    assert log == {
        "action_required": True,
        "error_code": "performer_control_protocol_invalid",
        "error_type": "ControlProtocolError",
        "event": "performer_control_protocol_failed",
        "next_action": "Restart the Performer control host and retry the request.",
        "retryable": False,
        "sanitized_reason": "The Performer control protocol input was invalid.",
    }


def test_backend_events_are_emitted_as_validated_control_frames() -> None:
    request = _request("event-1", "performer.login", {"method": "device_code"})

    class EventBackend:
        kind = "codex"

        async def control(
            self,
            received: PerformerControlRequest,
            secret_input: bytes | None,
            *,
            emit_event: Any = None,
        ) -> PerformerControlResult:
            assert received == request
            assert secret_input is None
            assert emit_event is not None
            await emit_event(
                PerformerControlEvent(
                    protocol_version=1,
                    request_id=received.request_id,
                    operation=received.operation,
                    sequence=1,
                    event_kind="login.pending",
                    message="Open the verification URL",
                    verification_url="https://example.test/device",
                    user_code="ABCD-EFGH",
                    expires_at=None,
                )
            )
            return _success(received, login_status="pending")

    exit_code, stdout, stderr = _run(EventBackend(), encode_metadata_frame(request))

    frames = _stdout_frames(stdout)
    assert exit_code == 0
    assert stderr == b""
    assert [frame["frame_kind"] for frame in frames] == ["control.event", "control.result"]
    assert frames[0]["payload"]["event_kind"] == "login.pending"
    assert frames[1]["payload"]["request_id"] == "event-1"


def test_invalid_backend_event_is_a_protocol_failure_not_a_normal_failed_result() -> None:
    request = _request("event-invalid", "performer.login", {"method": "device_code"})

    class InvalidEventBackend:
        kind = "codex"

        async def control(
            self,
            received: PerformerControlRequest,
            secret_input: bytes | None,
            *,
            emit_event: Any = None,
        ) -> PerformerControlResult:
            assert received == request
            assert secret_input is None
            assert emit_event is not None
            await emit_event(object())
            raise AssertionError("invalid event must stop the host")

    exit_code, stdout, stderr = _run(
        InvalidEventBackend(),
        encode_metadata_frame(request),
    )

    assert exit_code == 1
    assert stdout == b""
    assert b"performer_control_protocol_invalid" in stderr


def test_backend_control_is_called_through_frozen_emit_event_protocol() -> None:
    request = _request("status-strict", "performer.status", {})

    class StrictBackend:
        kind = "codex"

        async def control(
            self,
            received: PerformerControlRequest,
            secret_input: bytes | None,
            **kwargs: Any,
        ) -> PerformerControlResult:
            assert received == request
            assert secret_input is None
            assert kwargs == {"emit_event": None}
            return _success(
                received,
                login_status="idle",
                include_status_fields=True,
            )

    exit_code, stdout, stderr = _run(
        StrictBackend(),
        encode_metadata_frame(request),
    )

    frames = _stdout_frames(stdout)
    assert exit_code == 0
    assert stderr == b""
    assert frames[0]["payload"]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_background_fatal_wakes_blocked_stdin_and_exits_closed() -> None:
    request = _request("status-fatal", "performer.status", {})

    class BlockingInput:
        def __init__(self, initial: bytes) -> None:
            self._buffer = bytearray(initial)
            self._condition = threading.Condition()
            self.closed = False
            self.close_calls = 0

        def read(self, size: int = -1) -> bytes:
            with self._condition:
                if self._buffer:
                    count = len(self._buffer) if size < 0 else min(size, len(self._buffer))
                    value = bytes(self._buffer[:count])
                    del self._buffer[:count]
                    return value
                while not self.closed:
                    self._condition.wait()
                raise ValueError("I/O operation on closed input")

        def close(self) -> None:
            with self._condition:
                self.close_calls += 1
                self.closed = True
                self._condition.notify_all()

    class MismatchedBackend:
        kind = "codex"

        async def control(
            self,
            received: PerformerControlRequest,
            secret_input: bytes | None,
            *,
            emit_event: Any = None,
        ) -> PerformerControlResult:
            assert secret_input is None
            assert emit_event is None
            return _success(
                _request("status-wrong", "performer.status", {}),
                login_status="idle",
                include_status_fields=True,
            )

    stdin = BlockingInput(encode_metadata_frame(request))
    stdout = io.BytesIO()
    stderr = io.BytesIO()
    host_task = asyncio.create_task(
        run_control_host(
            MismatchedBackend(),
            stdin=stdin,  # type: ignore[arg-type]
            stdout=stdout,
            stderr=stderr,
        )
    )
    try:
        exit_code = await asyncio.wait_for(asyncio.shield(host_task), timeout=0.2)
    except TimeoutError:
        stdin.close()
        await asyncio.wait_for(host_task, timeout=0.5)
        raise

    logs = [json.loads(line) for line in stderr.getvalue().splitlines()]
    assert exit_code == 1
    assert stdin.closed is True
    assert stdin.close_calls == 1
    assert stdout.getvalue() == b""
    assert logs == [
        {
            "action_required": True,
            "error_code": "performer_control_protocol_invalid",
            "error_type": "ControlProtocolError",
            "event": "performer_control_protocol_failed",
            "next_action": "Restart the Performer control host and retry the request.",
            "retryable": False,
            "sanitized_reason": "The Performer control protocol input was invalid.",
        }
    ]


def test_background_fatal_interrupts_a_real_buffered_pipe_read() -> None:
    request = _request("status-pipe-fatal", "performer.status", {})
    backend_returned = threading.Event()

    class MismatchedBackend:
        kind = "codex"

        async def control(
            self,
            received: PerformerControlRequest,
            secret_input: bytes | None,
            *,
            emit_event: Any = None,
        ) -> PerformerControlResult:
            assert secret_input is None
            assert emit_event is None
            backend_returned.set()
            return _success(
                _request("status-pipe-wrong", "performer.status", {}),
                login_status="idle",
                include_status_fields=True,
            )

    read_fd, write_fd = os.pipe()
    stdin = os.fdopen(read_fd, "rb")
    stdout = io.BytesIO()
    stderr = io.BytesIO()
    outcome: dict[str, Any] = {}

    def run_host() -> None:
        try:
            outcome["exit_code"] = asyncio.run(
                run_control_host(
                    MismatchedBackend(),
                    stdin=stdin,
                    stdout=stdout,
                    stderr=stderr,
                )
            )
        except BaseException as exc:
            outcome["exception"] = exc

    os.write(write_fd, encode_metadata_frame(request))
    thread = threading.Thread(target=run_host)
    thread.start()
    try:
        assert backend_returned.wait(timeout=0.5)
        thread.join(timeout=0.2)
        assert thread.is_alive() is False
    finally:
        os.close(write_fd)
        thread.join(timeout=0.5)
        try:
            stdin.close()
        except OSError:
            pass

    logs = [json.loads(line) for line in stderr.getvalue().splitlines()]
    assert outcome == {"exit_code": 1}
    assert stdout.getvalue() == b""
    assert len(logs) == 1
    assert logs[0]["event"] == "performer_control_protocol_failed"
    assert logs[0]["error_code"] == "performer_control_protocol_invalid"


def test_long_check_does_not_block_status_result() -> None:
    policy = {
        "version": 1,
        "model": "gpt-5.4",
        "model_provider": "openai",
        "approval_mode": "auto_review",
        "reasoning_effort": "high",
        "reasoning_summary": "auto",
        "sandbox": {"plan": "read_only", "execute": "workspace_write", "gate": "read_only"},
        "initialize_timeout_ms": 5000,
        "turn_timeout_ms": 3600000,
        "initialize_max_attempts": 4,
        "overload_max_attempts": 5,
    }
    check_request = _request("check-slow", "performer.check", {
        "binding_generation": 1,
        "execution_policy": policy,
        "execution_policy_sha256": canonical_sha256(policy),
    })

    class SlowBackend:
        kind = "codex"

        async def control(self, request: PerformerControlRequest, secret_input: bytes | None, *, emit_event: Any = None) -> PerformerControlResult:
            assert secret_input is None
            if request.operation == "performer.check":
                await asyncio.sleep(0.05)
                return PerformerControlResult(
                    protocol_version=1,
                    request_id=request.request_id,
                    operation=request.operation,
                    status="succeeded",
                    capabilities=None,
                    readiness=_readiness(),
                    account=None,
                    login=None,
                    configuration=None,
                    check=PerformerCheckOutcome(
                        status="passed",
                        started_at="2026-01-01T00:00:00Z",
                        finished_at="2026-01-01T00:00:01Z",
                        summary="ready",
                    ),
                    error=None,
                )
            return _success(request, login_status="idle", include_status_fields=True)

    status_request = _request("status-fast", "performer.status", {})
    exit_code, stdout, stderr = _run(
        SlowBackend(),
        encode_metadata_frame(check_request) + encode_metadata_frame(status_request),
    )
    frames = _stdout_frames(stdout)
    assert exit_code == 0
    assert stderr == b""
    assert [frame["payload"]["request_id"] for frame in frames] == ["status-fast", "check-slow"]


def test_check_forwards_control_heartbeats_through_the_host() -> None:
    policy = {
        "version": 1,
        "model": "gpt-5.4",
        "model_provider": "openai",
        "approval_mode": "auto_review",
        "reasoning_effort": "high",
        "reasoning_summary": "auto",
        "sandbox": {"plan": "read_only", "execute": "workspace_write", "gate": "read_only"},
        "initialize_timeout_ms": 5000,
        "turn_timeout_ms": 3600000,
        "initialize_max_attempts": 4,
        "overload_max_attempts": 5,
    }
    request = _request("check-heartbeat", "performer.check", {
        "binding_generation": 1,
        "execution_policy": policy,
        "execution_policy_sha256": canonical_sha256(policy),
    })

    class HeartbeatBackend:
        kind = "codex"

        async def control(
            self,
            received: PerformerControlRequest,
            secret_input: bytes | None,
            *,
            emit_event: Any = None,
        ) -> PerformerControlResult:
            assert received == request
            assert secret_input is None
            assert emit_event is not None
            await emit_event(
                PerformerControlEvent(
                    protocol_version=1,
                    request_id=received.request_id,
                    operation=received.operation,
                    sequence=1,
                    event_kind="control.heartbeat",
                    message="Check is running.",
                    verification_url=None,
                    user_code=None,
                    expires_at=None,
                )
            )
            return PerformerControlResult(
                protocol_version=1,
                request_id=received.request_id,
                operation=received.operation,
                status="succeeded",
                capabilities=None,
                readiness=_readiness(),
                account=None,
                login=None,
                configuration=None,
                check=PerformerCheckOutcome(
                    status="passed",
                    started_at="2026-01-01T00:00:00Z",
                    finished_at="2026-01-01T00:00:01Z",
                    summary="ready",
                ),
                error=None,
            )

    exit_code, stdout, stderr = _run(HeartbeatBackend(), encode_metadata_frame(request))

    frames = _stdout_frames(stdout)
    assert exit_code == 0
    assert stderr == b""
    assert [frame["frame_kind"] for frame in frames] == ["control.event", "control.result"]
    assert frames[0]["payload"]["event_kind"] == "control.heartbeat"


def test_status_does_not_replace_the_pending_login_event_sink() -> None:
    login_request = _request("login-owner", "performer.login", {"method": "device_code"})
    status_request = _request("status-observer", "performer.status", {})

    class LoginSinkBackend:
        kind = "codex"

        def __init__(self) -> None:
            self.login_sink: Any = None
            self.login_ready = asyncio.Event()

        async def control(
            self,
            request: PerformerControlRequest,
            secret_input: bytes | None,
            *,
            emit_event: Any = None,
        ) -> PerformerControlResult:
            assert secret_input is None
            if request.operation == "performer.login":
                assert emit_event is not None
                self.login_sink = emit_event
                self.login_ready.set()
                await emit_event(
                    PerformerControlEvent(
                        protocol_version=1,
                        request_id=request.request_id,
                        operation=request.operation,
                        sequence=1,
                        event_kind="login.pending",
                        message="Open the verification URL",
                        verification_url="https://example.test/device",
                        user_code="ABCD-EFGH",
                        expires_at=None,
                    )
                )
                return _success(request, login_status="pending")
            await self.login_ready.wait()
            assert emit_event is None
            await self.login_sink(
                PerformerControlEvent(
                    protocol_version=1,
                    request_id=login_request.request_id,
                    operation=login_request.operation,
                    sequence=2,
                    event_kind="login.succeeded",
                    message="Device login succeeded",
                    verification_url=None,
                    user_code=None,
                    expires_at=None,
                )
            )
            return _success(request, login_status="idle", include_status_fields=True)

    exit_code, stdout, stderr = _run(
        LoginSinkBackend(),
        encode_metadata_frame(login_request) + encode_metadata_frame(status_request),
    )

    frames = _stdout_frames(stdout)
    assert exit_code == 0
    assert stderr == b""
    assert [
        (frame["frame_kind"], frame["payload"]["request_id"])
        for frame in frames
    ] == [
        ("control.event", "login-owner"),
        ("control.result", "login-owner"),
        ("control.event", "login-owner"),
        ("control.result", "status-observer"),
    ]
