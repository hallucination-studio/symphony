from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import stat
import sys
import textwrap

import pytest

from conductor.performer_control import (
    PerformerCoordinator,
    PerformerCoordinatorError,
    PerformerCoordinatorHooks,
)
from performer_api.performer_control import (
    CONTROL_PROTOCOL_VERSION,
    PerformerControlRequest,
    PerformerSecretInput,
)
from performer_api.runtime_policy import canonical_sha256


def _request(
    request_id: str,
    operation: str,
    arguments: dict[str, object] | None = None,
    *,
    secret_length: int | None = None,
) -> PerformerControlRequest:
    return PerformerControlRequest(
        protocol_version=CONTROL_PROTOCOL_VERSION,
        request_id=request_id,
        operation=operation,
        performer_kind="codex",
        arguments=arguments or {},
        secret_input=(
            PerformerSecretInput(kind="api_key", length=secret_length)
            if secret_length is not None
            else None
        ),
    )


def _check_request(request_id: str) -> PerformerControlRequest:
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
    return _request(
        request_id,
        "performer.check",
        {
            "binding_generation": 1,
            "execution_policy": policy,
            "execution_policy_sha256": canonical_sha256(policy),
        },
    )


def _install_fake_performer(tmp_path: Path) -> Path:
    path = tmp_path / "fake-performer"
    path.write_text(
        textwrap.dedent(
            """\
            #!__PYTHON__
            import asyncio
            import json
            import os
            import struct
            import sys

            async def read_frame():
                header = await asyncio.to_thread(sys.stdin.buffer.read, 4)
                if not header:
                    return None
                size = struct.unpack(">I", header)[0]
                return await asyncio.to_thread(sys.stdin.buffer.read, size)

            def readiness(status="unchecked", check="none"):
                return {
                    "performer_kind": "codex",
                    "binding_generation": 1,
                    "capability_version": 1,
                    "execution_policy_sha256": "a" * 64,
                    "status": status,
                    "last_check_status": check,
                    "error": None,
                }

            def result(req, **fields):
                payload = {
                    "protocol_version": 1,
                    "request_id": req["request_id"],
                    "operation": req["operation"],
                    "status": "succeeded",
                    "capabilities": None,
                    "readiness": None,
                    "account": None,
                    "login": None,
                    "configuration": None,
                    "check": None,
                    "error": None,
                }
                payload.update(fields)
                return payload

            def emit(kind, payload):
                line = json.dumps({"frame_kind": kind, "payload": payload}, separators=(",", ":"))
                stdout_snapshot = os.environ.get("FAKE_STDOUT_SNAPSHOT")
                if stdout_snapshot:
                    with open(stdout_snapshot, "a", encoding="utf-8") as handle:
                        handle.write(line + "\\n")
                print(line, flush=True)

            async def main():
                process_snapshot = os.environ.get("FAKE_PROCESS_SNAPSHOT")
                if process_snapshot:
                    with open(process_snapshot, "w", encoding="utf-8") as handle:
                        json.dump({"argv": sys.argv, "environment": dict(os.environ)}, handle)
                stderr_snapshot = os.environ.get("FAKE_STDERR_SNAPSHOT")
                if stderr_snapshot:
                    open(stderr_snapshot, "w", encoding="utf-8").close()
                pending_login = False
                pending_login_request = None
                pending_check = None
                while True:
                    raw = await read_frame()
                    if raw is None:
                        return
                    req = json.loads(raw)
                    secret = None
                    metadata = req.get("secret_input")
                    if metadata is not None:
                        secret = await read_frame()
                        marker = os.environ.get("FAKE_SECRET_MARKER")
                        if marker:
                            open(marker, "w", encoding="utf-8").write(str(len(secret)))

                    mode = os.environ.get("FAKE_MODE", "normal")
                    if mode == "crash":
                        os._exit(23)
                    if mode == "malformed":
                        print('{"frame_kind":"unknown","payload":{}}', flush=True)
                        continue
                    if mode == "stale":
                        stale = dict(req)
                        stale["request_id"] = "stale-request"
                        emit("control.result", result(stale, configuration={"settings": {}, "source_format": None, "source_text": None}))
                        continue
                    if mode == "failed_result":
                        failed = result(req)
                        failed["status"] = "failed"
                        failed["error"] = {
                            "error_code": "performer_backend_setup_failed",
                            "sanitized_reason": "Performer backend setup failed.",
                            "action_required": True,
                            "retryable": False,
                            "attempt_number": 1,
                            "next_action": "Correct the backend setup and retry.",
                        }
                        emit("control.result", failed)
                        continue

                    op = req["operation"]
                    if op == "performer.status":
                        terminal = os.environ.get("FAKE_LOGIN_TERMINAL")
                        if pending_login_request is not None and terminal in {"succeeded", "failed"}:
                            emit("control.event", {
                                "protocol_version": 1,
                                "request_id": pending_login_request["request_id"],
                                "operation": "performer.login",
                                "sequence": 2,
                                "event_kind": "login." + terminal,
                                "message": "Device login " + terminal,
                                "verification_url": None,
                                "user_code": None,
                                "expires_at": None,
                            })
                            pending_login = False
                            pending_login_request = None
                        emit("control.result", result(
                            req,
                            capabilities={
                                "protocol_version": 1,
                                "capability_version": 1,
                                "performer_kind": "codex",
                                "display_name": "Fake",
                                "turn_kinds": ["plan", "execute", "gate"],
                                "login_methods": ["device_code", "api_key"],
                                "supports_session_delete": True,
                                "editable_settings": ["api_base_url"],
                                "config_source_visible": True,
                                "check_supported": True,
                            },
                            readiness=readiness(),
                            account={"status": "unknown", "display_label": None},
                            login={"status": "pending" if pending_login else "idle", "method": "device_code" if pending_login else None},
                        ))
                        if pending_check is not None:
                            emit("control.result", result(
                                pending_check,
                                readiness=readiness("ready", "passed"),
                                check={"status": "passed", "started_at": "2026-01-01T00:00:00Z", "finished_at": "2026-01-01T00:00:01Z", "summary": "ready"},
                            ))
                            pending_check = None
                    elif op == "performer.login":
                        pending_login = req["arguments"]["method"] == "device_code"
                        pending_login_request = req if pending_login else None
                        if pending_login:
                            emit("control.event", {
                                "protocol_version": 1,
                                "request_id": req["request_id"],
                                "operation": op,
                                "sequence": 1,
                                "event_kind": "login.pending",
                                "message": "Open the verification URL",
                                "verification_url": "https://example.test/device",
                                "user_code": "ABCD-EFGH",
                                "expires_at": None,
                            })
                        emit("control.result", result(
                            req,
                            readiness=readiness(),
                            login={"status": "pending" if pending_login else "succeeded", "method": req["arguments"]["method"]},
                        ))
                    elif op == "performer.session.delete":
                        pending_login = False
                        emit("control.result", result(
                            req,
                            readiness=readiness(),
                            account={"status": "logged_out", "display_label": None},
                            login={"status": "idle", "method": None},
                        ))
                    elif op == "performer.config.read":
                        emit("control.result", result(req, configuration={"settings": {}, "source_format": None, "source_text": None}))
                    elif op == "performer.config.write":
                        emit("control.result", result(req, readiness=readiness(), configuration={"settings": {"api_base_url": req["arguments"]["value"]}, "source_format": None, "source_text": None}))
                    elif op == "performer.check":
                        pending_check = req

            asyncio.run(main())
            """
        ).replace("__PYTHON__", sys.executable),
        encoding="utf-8",
    )
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def _assert_sentinel_absent(sentinel: bytes, values: list[bytes]) -> None:
    for value in values:
        assert sentinel not in value


@pytest.mark.asyncio
async def test_status_and_cancel_remain_available_after_pending_device_login(tmp_path: Path) -> None:
    executable = _install_fake_performer(tmp_path)
    events = []
    coordinator = PerformerCoordinator(
        command=(str(executable),),
        process_env={"PATH": os.environ["PATH"]},
        hooks=PerformerCoordinatorHooks(on_event=events.append),
    )
    await coordinator.start()
    try:
        login = await coordinator.request(
            _request("login-1", "performer.login", {"method": "device_code"})
        )
        assert login.login is not None and login.login.status == "pending"
        assert [event.event_kind for event in events] == ["login.pending"]

        with pytest.raises(PerformerCoordinatorError) as busy:
            await coordinator.request(_request("read-while-login", "performer.config.read"))
        assert busy.value.error_code == "performer_control_busy"

        with pytest.raises(PerformerCoordinatorError) as turn_busy:
            async with coordinator.turn_exchange():
                raise AssertionError("pending device login must exclude turns")
        assert turn_busy.value.error_code == "performer_control_busy"

        status = await coordinator.request(_request("status-1", "performer.status"))
        assert status.login is not None and status.login.status == "pending"

        cancelled = await coordinator.request(
            _request("cancel-1", "performer.session.delete", {"action": "cancel_login"})
        )
        assert cancelled.login is not None and cancelled.login.status == "idle"
    finally:
        await coordinator.stop()


@pytest.mark.asyncio
async def test_cancel_login_obeys_turn_exclusivity_without_pending_login(
    tmp_path: Path,
) -> None:
    executable = _install_fake_performer(tmp_path)
    coordinator = PerformerCoordinator(
        command=(str(executable),),
        process_env={"PATH": os.environ["PATH"]},
    )
    await coordinator.start()
    try:
        async with coordinator.turn_exchange():
            with pytest.raises(PerformerCoordinatorError) as raised:
                await coordinator.request(
                    _request(
                        "cancel-without-login",
                        "performer.session.delete",
                        {"action": "cancel_login"},
                    )
                )

        assert raised.value.error_code == "performer_control_busy"
        assert raised.value.action_required is False
        assert raised.value.retryable is True
    finally:
        await coordinator.stop()


@pytest.mark.asyncio
async def test_request_event_collector_receives_initial_login_challenge(tmp_path: Path) -> None:
    executable = _install_fake_performer(tmp_path)
    global_events = []
    request_events = []
    coordinator = PerformerCoordinator(
        command=(str(executable),),
        process_env={"PATH": os.environ["PATH"]},
        hooks=PerformerCoordinatorHooks(on_event=global_events.append),
    )
    await coordinator.start()
    try:
        result = await coordinator.request(
            _request("login-collected", "performer.login", {"method": "device_code"}),
            event_collector=request_events.append,
        )

        assert result.login is not None and result.login.status == "pending"
        assert [event.event_kind for event in request_events] == ["login.pending"]
        assert request_events == global_events
    finally:
        await coordinator.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("terminal", ["succeeded", "failed"])
async def test_device_login_terminal_event_remains_correlated_after_pending_result(
    tmp_path: Path,
    terminal: str,
) -> None:
    executable = _install_fake_performer(tmp_path)
    events = []
    failures: list[PerformerCoordinatorError] = []
    coordinator = PerformerCoordinator(
        command=(str(executable),),
        process_env={
            "PATH": os.environ["PATH"],
            "FAKE_LOGIN_TERMINAL": terminal,
        },
        hooks=PerformerCoordinatorHooks(
            on_event=events.append,
            on_failure=failures.append,
        ),
    )
    await coordinator.start()
    try:
        login = await coordinator.request(
            _request("login-terminal", "performer.login", {"method": "device_code"})
        )
        assert login.login is not None and login.login.status == "pending"

        status = await coordinator.request(_request("status-terminal", "performer.status"))

        assert status.status == "succeeded"
        assert [event.event_kind for event in events] == ["login.pending", f"login.{terminal}"]
        assert failures == []
        assert coordinator.is_running is True
    finally:
        await coordinator.stop()


@pytest.mark.asyncio
async def test_config_read_and_write_use_only_closed_control_results(tmp_path: Path) -> None:
    executable = _install_fake_performer(tmp_path)
    invalidations: list[str] = []
    coordinator = PerformerCoordinator(
        command=(str(executable),),
        process_env={"PATH": os.environ["PATH"]},
        hooks=PerformerCoordinatorHooks(
            on_readiness_invalidated=lambda request: invalidations.append(request.operation)
        ),
    )
    await coordinator.start()
    try:
        initial = await coordinator.request(_request("config-read", "performer.config.read"))
        assert initial.configuration is not None
        assert initial.configuration.settings == {}

        updated = await coordinator.request(
            _request(
                "config-write",
                "performer.config.write",
                {"setting": "api_base_url", "value": "https://api.example.test/v1"},
            )
        )
        assert updated.configuration is not None
        assert updated.configuration.settings == {
            "api_base_url": "https://api.example.test/v1"
        }
        assert invalidations == ["performer.config.write"]
    finally:
        await coordinator.stop()


@pytest.mark.asyncio
async def test_secret_is_framed_separately_after_readiness_invalidation(tmp_path: Path) -> None:
    executable = _install_fake_performer(tmp_path)
    marker = tmp_path / "secret-read"
    invalidations: list[str] = []

    async def invalidate(request: PerformerControlRequest) -> None:
        assert not marker.exists()
        invalidations.append(request.request_id)

    coordinator = PerformerCoordinator(
        command=(str(executable),),
        process_env={"PATH": os.environ["PATH"], "FAKE_SECRET_MARKER": str(marker)},
        hooks=PerformerCoordinatorHooks(on_readiness_invalidated=invalidate),
    )
    await coordinator.start()
    try:
        secret = b"sentinel-api-key"
        result = await coordinator.request(
            _request(
                "login-secret",
                "performer.login",
                {"method": "api_key"},
                secret_length=len(secret),
            ),
            secret_input=secret,
        )
        assert result.status == "succeeded"
        assert invalidations == ["login-secret"]
        assert marker.read_text(encoding="utf-8") == str(len(secret))
    finally:
        await coordinator.stop()


@pytest.mark.asyncio
async def test_api_key_secret_is_absent_from_process_and_control_surfaces(
    tmp_path: Path,
) -> None:
    executable = _install_fake_performer(tmp_path)
    sentinel = b"sk-subprocess-sentinel-never-persist-or-echo-1234567890"
    process_snapshot = tmp_path / "process-snapshot.json"
    stdout_snapshot = tmp_path / "stdout-snapshot.jsonl"
    stderr_snapshot = tmp_path / "stderr-snapshot.log"
    secret_marker = tmp_path / "secret-read"
    stderr_messages: list[str] = []
    failures: list[PerformerCoordinatorError] = []

    with pytest.raises(AssertionError):
        _assert_sentinel_absent(sentinel, [b"argv=" + sentinel])

    coordinator = PerformerCoordinator(
        command=(str(executable), "control"),
        process_env={
            "PATH": os.environ["PATH"],
            "FAKE_PROCESS_SNAPSHOT": str(process_snapshot),
            "FAKE_STDOUT_SNAPSHOT": str(stdout_snapshot),
            "FAKE_STDERR_SNAPSHOT": str(stderr_snapshot),
            "FAKE_SECRET_MARKER": str(secret_marker),
        },
        hooks=PerformerCoordinatorHooks(
            on_failure=failures.append,
            on_stderr=stderr_messages.append,
        ),
    )
    await coordinator.start()
    try:
        result = await coordinator.request(
            _request(
                "login-secret-surfaces",
                "performer.login",
                {"method": "api_key"},
                secret_length=len(sentinel),
            ),
            secret_input=sentinel,
        )
    finally:
        await coordinator.stop()

    process = json.loads(process_snapshot.read_text(encoding="utf-8"))
    assert process["argv"] == [str(executable), "control"]
    expected_environment = {
        "FAKE_PROCESS_SNAPSHOT": str(process_snapshot),
        "FAKE_SECRET_MARKER": str(secret_marker),
        "FAKE_STDERR_SNAPSHOT": str(stderr_snapshot),
        "FAKE_STDOUT_SNAPSHOT": str(stdout_snapshot),
        "PATH": os.environ["PATH"],
    }
    assert {
        key: process["environment"][key]
        for key in expected_environment
    } == expected_environment
    assert result.status == "succeeded"
    assert secret_marker.read_text(encoding="utf-8") == str(len(sentinel))

    temp_file_contents = [
        path.read_bytes()
        for path in tmp_path.rglob("*")
        if path.is_file()
    ]
    _assert_sentinel_absent(
        sentinel,
        [
            json.dumps(result.to_dict(), sort_keys=True).encode(),
            repr(failures).encode(),
            "\n".join(stderr_messages).encode(),
            stdout_snapshot.read_bytes(),
            stderr_snapshot.read_bytes(),
            *temp_file_contents,
        ],
    )


@pytest.mark.asyncio
async def test_check_is_exclusive_but_status_keeps_event_loop_responsive(tmp_path: Path) -> None:
    executable = _install_fake_performer(tmp_path)
    coordinator = PerformerCoordinator(
        command=(str(executable),),
        process_env={"PATH": os.environ["PATH"], "FAKE_CHECK_DELAY": "0.15"},
    )
    await coordinator.start()
    check_request = _check_request("check-1")
    try:
        check_task = asyncio.create_task(coordinator.request(check_request))
        await asyncio.sleep(0.02)
        with pytest.raises(PerformerCoordinatorError, match="busy") as raised:
            await coordinator.request(_request("read-1", "performer.config.read"))
        assert raised.value.error_code == "performer_control_busy"

        status = await asyncio.wait_for(
            coordinator.request(_request("status-during-check", "performer.status")),
            timeout=1.0,
        )
        assert status.status == "succeeded"
        assert (await check_task).check is not None
    finally:
        await coordinator.stop()


@pytest.mark.asyncio
async def test_check_marks_its_start_without_treating_busy_contention_as_failure(
    tmp_path: Path,
) -> None:
    executable = _install_fake_performer(tmp_path)
    check_started: list[str] = []
    failures: list[PerformerCoordinatorError] = []
    coordinator = PerformerCoordinator(
        command=(str(executable),),
        process_env={"PATH": os.environ["PATH"]},
        hooks=PerformerCoordinatorHooks(
            on_check_started=lambda request: check_started.append(request.request_id),
            on_failure=failures.append,
        ),
    )
    await coordinator.start()
    try:
        check_task = asyncio.create_task(coordinator.request(_check_request("check-started")))
        await asyncio.sleep(0.02)

        assert check_started == ["check-started"]
        with pytest.raises(PerformerCoordinatorError) as busy:
            await coordinator.request(_request("read-busy", "performer.config.read"))
        assert busy.value.error_code == "performer_control_busy"
        assert failures == []

        await coordinator.request(_request("status-completes-check", "performer.status"))
        assert (await check_task).check is not None
    finally:
        await coordinator.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("mode", "timeout", "error_code", "action_required", "retryable"),
    [
        ("crash", 1.0, "performer_control_process_exited", True, True),
        ("malformed", 1.0, "performer_control_protocol_invalid", True, False),
        ("stale", 1.0, "performer_control_protocol_invalid", True, False),
        ("normal", 0.02, "performer_control_timeout", True, True),
    ],
)
async def test_failures_are_closed_and_reported(
    tmp_path: Path,
    mode: str,
    timeout: float,
    error_code: str,
    action_required: bool,
    retryable: bool,
) -> None:
    executable = _install_fake_performer(tmp_path)
    failures: list[PerformerCoordinatorError] = []
    env = {"PATH": os.environ["PATH"], "FAKE_MODE": mode}
    if error_code == "performer_control_timeout":
        env["FAKE_CHECK_DELAY"] = "0.2"
    coordinator = PerformerCoordinator(
        command=(str(executable),),
        process_env=env,
        request_timeout_seconds=timeout,
        hooks=PerformerCoordinatorHooks(on_failure=failures.append),
    )
    await coordinator.start()
    try:
        request = _request("read-failure", "performer.config.read")
        if error_code == "performer_control_timeout":
            # Any exclusive operation delayed by the fake host exercises timeout cleanup.
            request = _check_request("check-timeout")
        with pytest.raises(PerformerCoordinatorError) as raised:
            await coordinator.request(request)
        assert raised.value.error_code == error_code
        assert raised.value.action_required is action_required
        assert raised.value.retryable is retryable
        assert failures and failures[-1].error_code == error_code
    finally:
        await coordinator.stop()


@pytest.mark.asyncio
async def test_failed_control_result_is_reported_through_failure_hook(tmp_path: Path) -> None:
    executable = _install_fake_performer(tmp_path)
    failures: list[PerformerCoordinatorError] = []
    coordinator = PerformerCoordinator(
        command=(str(executable),),
        process_env={"PATH": os.environ["PATH"], "FAKE_MODE": "failed_result"},
        hooks=PerformerCoordinatorHooks(on_failure=failures.append),
    )
    await coordinator.start()
    try:
        result = await coordinator.request(
            _request("read-failed-result", "performer.config.read")
        )

        assert result.status == "failed"
        assert result.error is not None
        assert result.error.error_code == "performer_backend_setup_failed"
        assert [error.error_code for error in failures] == [
            "performer_backend_setup_failed"
        ]
    finally:
        await coordinator.stop()


@pytest.mark.asyncio
async def test_process_start_failure_is_closed_and_reported(tmp_path: Path) -> None:
    failures: list[PerformerCoordinatorError] = []
    coordinator = PerformerCoordinator(
        command=(str(tmp_path / "missing-performer"),),
        process_env={"PATH": os.environ["PATH"]},
        hooks=PerformerCoordinatorHooks(on_failure=failures.append),
    )

    with pytest.raises(PerformerCoordinatorError) as raised:
        await coordinator.start()

    assert raised.value.error_code == "performer_control_process_exited"
    assert raised.value.action_required is True
    assert raised.value.retryable is True
    assert failures == [raised.value]


@pytest.mark.asyncio
async def test_normal_stop_ends_pending_request_without_requiring_action(
    tmp_path: Path,
) -> None:
    executable = _install_fake_performer(tmp_path)
    coordinator = PerformerCoordinator(
        command=(str(executable),),
        process_env={
            "PATH": os.environ["PATH"],
            "FAKE_CHECK_DELAY": "0.2",
        },
    )
    await coordinator.start()
    pending = asyncio.create_task(coordinator.request(_check_request("check-stop")))
    await asyncio.sleep(0.02)

    await coordinator.stop()

    with pytest.raises(PerformerCoordinatorError) as raised:
        await pending
    assert raised.value.error_code == "performer_control_process_exited"
    assert raised.value.action_required is False
    assert raised.value.retryable is True


@pytest.mark.asyncio
async def test_cancelled_control_request_stops_host_without_stale_protocol_failure(
    tmp_path: Path,
) -> None:
    executable = _install_fake_performer(tmp_path)
    failures: list[PerformerCoordinatorError] = []
    coordinator = PerformerCoordinator(
        command=(str(executable),),
        process_env={
            "PATH": os.environ["PATH"],
            "FAKE_CHECK_DELAY": "0.2",
        },
        hooks=PerformerCoordinatorHooks(on_failure=failures.append),
    )
    await coordinator.start()
    pending = asyncio.create_task(
        coordinator.request(_check_request("check-cancelled"))
    )
    await asyncio.sleep(0.02)

    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    await asyncio.sleep(0.05)

    assert coordinator.is_running is False
    assert all(
        failure.error_code != "performer_control_protocol_invalid"
        for failure in failures
    )

    await coordinator.start()
    try:
        status = await coordinator.request(
            _request("status-after-cancel", "performer.status")
        )
        assert status.status == "succeeded"
    finally:
        await coordinator.stop()


@pytest.mark.asyncio
async def test_process_exit_projects_pending_device_login_as_lost(tmp_path: Path) -> None:
    executable = _install_fake_performer(tmp_path)
    lost: list[PerformerCoordinatorError | None] = []
    coordinator = PerformerCoordinator(
        command=(str(executable),),
        process_env={"PATH": os.environ["PATH"]},
        hooks=PerformerCoordinatorHooks(on_login_lost=lost.append),
    )
    await coordinator.start()
    await coordinator.request(
        _request("login-before-stop", "performer.login", {"method": "device_code"})
    )

    await coordinator.stop()

    assert lost == [None]


def test_conductor_coordinator_has_no_provider_or_performer_imports() -> None:
    source = (Path(__file__).parents[1] / "packages/conductor/src/conductor/performer_control.py").read_text(
        encoding="utf-8"
    )
    assert "openai_codex" not in source
    assert "from performer " not in source
    assert "import performer" not in source.replace("import performer_api", "")
