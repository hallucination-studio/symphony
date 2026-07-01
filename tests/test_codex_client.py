from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

import pytest

from symphony.codex_client import CodexAppServerClient, CodexError
from symphony.config import CodexConfig


class FakeStdin:
    def __init__(self, proc: "FakeProcess"):
        self.proc = proc

    def write(self, data: bytes) -> None:
        self.proc.sent.append(json.loads(data.decode()))

    async def drain(self) -> None:
        await asyncio.sleep(0)


class FakeStdout:
    def __init__(self, lines: list[dict[str, Any]]):
        self.lines = [json.dumps(line).encode() + b"\n" for line in lines]

    async def readline(self) -> bytes:
        await asyncio.sleep(0)
        if not self.lines:
            await asyncio.sleep(3600)
        return self.lines.pop(0)


class HangingStdout:
    async def readline(self) -> bytes:
        await asyncio.sleep(3600)
        return b""


class FakeByteStream:
    def __init__(self, lines: list[bytes]):
        self.lines = lines

    async def readline(self) -> bytes:
        await asyncio.sleep(0)
        if not self.lines:
            await asyncio.sleep(3600)
        return self.lines.pop(0)


class FakeProcess:
    def __init__(
        self,
        lines: list[dict[str, Any]],
        stderr_lines: list[bytes] | None = None,
        *,
        hang_stdout: bool = False,
    ):
        self.pid = 1234
        self.sent: list[dict[str, Any]] = []
        self.stdin = FakeStdin(self)
        self.stdout = HangingStdout() if hang_stdout else FakeStdout(lines)
        self.stderr = FakeByteStream(stderr_lines or [])
        self.returncode: int | None = None
        self.killed = False

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    async def wait(self) -> int:
        return self.returncode or 0


@pytest.mark.asyncio
async def test_run_turn_sends_initialize_thread_and_default_policy_payload(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
        ]
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        assert kwargs["cwd"] == str(tmp_path)
        assert kwargs["limit"] == 10 * 1024 * 1024
        return process

    events: list[dict[str, Any]] = []
    client = CodexAppServerClient(CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000), process_factory=factory)
    result = await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    assert result.success
    assert result.thread_id == "thr_1"
    assert result.turn_id == "turn_1"
    assert process.sent[0]["method"] == "initialize"
    assert process.sent[1] == {"method": "initialized", "params": {}}
    assert process.sent[2]["params"]["approvalPolicy"] is None
    assert process.sent[2]["params"]["sandbox"] is None
    turn = process.sent[3]
    assert turn["method"] == "turn/start"
    assert turn["params"]["cwd"] == str(tmp_path)
    assert turn["params"]["approvalPolicy"] is None
    assert turn["params"]["sandboxPolicy"] is None
    assert turn["params"]["input"] == [{"type": "text", "text": "Do work"}]
    session_events = [event for event in events if event["event"] == "session_started"]
    assert session_events[0]["thread_id"] == "thr_1"
    assert events[-1]["session_id"] == "thr_1-turn_1"


@pytest.mark.asyncio
async def test_run_session_launches_app_server_over_ssh_for_worker_host(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
        ]
    )
    captured: dict[str, Any] = {}

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        captured["args"] = args
        captured["kwargs"] = kwargs
        return process

    client = CodexAppServerClient(
        CodexConfig(command="codex app-server", read_timeout_ms=100, turn_timeout_ms=1000),
        process_factory=factory,
    )
    await client.run_session(tmp_path, "Do work", "MT-1: Build", worker_host="builder-1")

    assert captured["args"][0:2] == ("ssh", "builder-1")
    assert "cd " in captured["args"][2]
    assert "codex app-server" in captured["args"][2]
    assert captured["kwargs"]["cwd"] == str(tmp_path)


@pytest.mark.asyncio
async def test_run_session_uses_workspace_local_codex_home_and_copies_user_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": str(tmp_path / ".codex-home")}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
        ]
    )
    source_home = tmp_path / "source-codex-home"
    source_home.mkdir()
    (source_home / "config.toml").write_text('model = "gpt-5.4"\n', encoding="utf-8")
    (source_home / "auth.json").write_text('{"token":"x"}\n', encoding="utf-8")
    monkeypatch.setenv("CODEX_HOME", str(source_home))
    captured: dict[str, Any] = {}

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        captured["env"] = kwargs["env"]
        return process

    client = CodexAppServerClient(CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000), process_factory=factory)
    await client.run_session(tmp_path, "Do work", "MT-1: Build")

    expected_home = tmp_path / ".codex-home"
    assert captured["env"]["CODEX_HOME"] == str(expected_home)
    assert (expected_home / "config.toml").read_text(encoding="utf-8") == 'model = "gpt-5.4"\n'
    assert (expected_home / "auth.json").read_text(encoding="utf-8") == '{"token":"x"}\n'


@pytest.mark.asyncio
async def test_run_session_uses_workspace_pythonpath_instead_of_host_pythonpath(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": str(tmp_path / ".codex-home")}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
        ]
    )
    (tmp_path / "src").mkdir()
    monkeypatch.setenv("PYTHONPATH", "/Users/murphy/code/github/symphony/src")
    captured: dict[str, Any] = {}

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        captured["env"] = kwargs["env"]
        return process

    client = CodexAppServerClient(CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000), process_factory=factory)
    await client.run_session(tmp_path, "Do work", "MT-1: Build")

    assert captured["env"]["PYTHONPATH"] == str(tmp_path / "src")
    assert captured["env"]["PYTHONNOUSERSITE"] == "1"


@pytest.mark.asyncio
async def test_run_turn_passes_explicit_codex_policy_values(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
        ]
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    config = CodexConfig(
        read_timeout_ms=100,
        turn_timeout_ms=1000,
        approval_policy="never",
        thread_sandbox="danger-full-access",
        turn_sandbox_policy={"type": "dangerFullAccess"},
    )
    client = CodexAppServerClient(config, process_factory=factory)
    await client.run_session(tmp_path, "Do work", "MT-1: Build")

    assert process.sent[2]["params"]["approvalPolicy"] == "never"
    assert process.sent[2]["params"]["sandbox"] == "danger-full-access"
    assert process.sent[3]["params"]["approvalPolicy"] == "never"
    assert process.sent[3]["params"]["sandboxPolicy"] == {"type": "dangerFullAccess"}


@pytest.mark.asyncio
async def test_thread_start_advertises_dynamic_tool_specs_for_registered_tools(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
        ]
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    async def linear_graphql(arguments: Any) -> dict[str, Any]:
        return {"success": True, "arguments": arguments}

    client = CodexAppServerClient(
        CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000),
        process_factory=factory,
        tools={"linear_graphql": linear_graphql},
    )
    await client.run_session(tmp_path, "Do work", "MT-1: Build")

    thread_start = process.sent[2]
    assert thread_start["method"] == "thread/start"
    assert thread_start["params"]["dynamicTools"] == [
        {
            "type": "function",
            "name": "linear_graphql",
            "description": (
                "Call the configured Linear GraphQL API. Use this for reading or updating the current Linear "
                "workspace, including commenting on issues and moving issues between states."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "variables": {"type": "object", "additionalProperties": True},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        }
    ]


@pytest.mark.asyncio
async def test_thread_start_omits_dynamic_tools_when_no_tools_are_registered(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
        ]
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    client = CodexAppServerClient(CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000), process_factory=factory)
    await client.run_session(tmp_path, "Do work", "MT-1: Build")

    assert "dynamicTools" not in process.sent[2]["params"]


@pytest.mark.asyncio
async def test_run_turn_auto_approves_command_and_file_requests(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {"id": 77, "method": "exec_command/approval_request", "params": {}},
            {"id": 78, "method": "file_change/approval_request", "params": {}},
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
        ]
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    events: list[dict[str, Any]] = []
    client = CodexAppServerClient(CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000), process_factory=factory)
    await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    assert {"id": 77, "result": {"decision": "approved_for_session"}} in process.sent
    assert {"id": 78, "result": {"decision": "acceptForSession"}} in process.sent
    approvals = [event for event in events if event["event"] == "approval_auto_approved"]
    assert [event["method"] for event in approvals] == [
        "exec_command/approval_request",
        "file_change/approval_request",
    ]


@pytest.mark.asyncio
async def test_run_session_can_continue_multiple_turns_on_same_thread(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
            {"id": 3, "result": {"turn": {"id": "turn_2"}}},
            {"method": "turn/completed", "params": {"turn": {"id": "turn_2"}, "status": "completed"}},
        ]
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    async def continuation_provider(turn_count: int) -> str | None:
        assert turn_count == 1
        return "Continue work"

    client = CodexAppServerClient(CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000), process_factory=factory)
    result = await client.run_session(
        tmp_path,
        "First prompt",
        "MT-1: Build",
        max_turns=2,
        continuation_provider=continuation_provider,
    )

    turn_starts = [message for message in process.sent if message.get("method") == "turn/start"]
    assert result.turn_count == 2
    assert [message["params"]["threadId"] for message in turn_starts] == ["thr_1", "thr_1"]
    assert turn_starts[1]["params"]["input"] == [{"type": "text", "text": "Continue work"}]


@pytest.mark.asyncio
async def test_user_input_request_fails_without_stalling(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {"id": 88, "method": "tool/request_user_input", "params": {}},
        ]
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    client = CodexAppServerClient(CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000), process_factory=factory)

    with pytest.raises(CodexError) as exc:
        await client.run_session(tmp_path, "Do work", "MT-1: Build")

    assert exc.value.code == "turn_input_required"
    assert process.killed


@pytest.mark.asyncio
async def test_initialize_read_timeout_is_enforced(tmp_path: Path) -> None:
    process = FakeProcess([], hang_stdout=True)

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    client = CodexAppServerClient(CodexConfig(read_timeout_ms=1, turn_timeout_ms=1000), process_factory=factory)

    with pytest.raises(CodexError) as exc:
        await client.run_session(tmp_path, "Do work", "MT-1: Build")

    assert exc.value.code == "response_timeout"
    assert process.killed


@pytest.mark.asyncio
async def test_initialize_timeout_emits_launch_and_timeout_diagnostics(tmp_path: Path) -> None:
    process = FakeProcess([], hang_stdout=True)

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    events: list[dict[str, Any]] = []
    client = CodexAppServerClient(CodexConfig(command="codex app-server", read_timeout_ms=1, turn_timeout_ms=1000), process_factory=factory)

    with pytest.raises(CodexError):
        await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    launch_events = [event for event in events if event["event"] == "process_launch"]
    timeout_events = [event for event in events if event["event"] == "request_timeout"]
    assert launch_events
    assert launch_events[0]["command_argv"] == ["bash", "-lc", "codex app-server"]
    assert "command" not in launch_events[0]
    assert launch_events[0]["cwd"] == str(tmp_path)
    assert timeout_events
    assert timeout_events[0]["method"] == "initialize"


@pytest.mark.asyncio
async def test_run_session_rejects_missing_workspace_path(tmp_path: Path) -> None:
    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        raise AssertionError("process should not start")

    client = CodexAppServerClient(CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000), process_factory=factory)

    with pytest.raises(CodexError) as exc:
        await client.run_session(tmp_path / "missing", "Do work", "MT-1: Build")

    assert exc.value.code == "invalid_workspace_cwd"


@pytest.mark.asyncio
async def test_turn_timeout_is_enforced(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
        ]
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    client = CodexAppServerClient(CodexConfig(read_timeout_ms=100, turn_timeout_ms=1), process_factory=factory)

    with pytest.raises(CodexError) as exc:
        await client.run_session(tmp_path, "Do work", "MT-1: Build")

    assert exc.value.code == "turn_timeout"
    assert process.killed


@pytest.mark.asyncio
async def test_turn_failed_notification_raises_turn_failed(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {"method": "turn/failed", "params": {"turn": {"id": "turn_1"}, "error": "bad"}},
        ]
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    client = CodexAppServerClient(CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000), process_factory=factory)

    with pytest.raises(CodexError) as exc:
        await client.run_session(tmp_path, "Do work", "MT-1: Build")

    assert exc.value.code == "turn_failed"


@pytest.mark.asyncio
async def test_unsupported_dynamic_tool_call_is_rejected_and_emits_event(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {"id": 99, "method": "tool/unknown", "params": {}},
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
        ]
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    events: list[dict[str, Any]] = []
    client = CodexAppServerClient(CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000), process_factory=factory)
    await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    assert {
        "id": 99,
        "error": {"code": -32601, "message": "Unsupported client request: tool/unknown"},
    } in process.sent
    unsupported = [event for event in events if event["event"] == "unsupported_tool_call"]
    assert unsupported[0]["method"] == "tool/unknown"


@pytest.mark.asyncio
async def test_supported_dynamic_tool_call_returns_structured_result(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {
                "id": 99,
                "method": "tool/call",
                "params": {
                    "name": "linear_graphql",
                    "arguments": {"query": "query Viewer { viewer { id } }"},
                },
            },
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
        ]
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    async def linear_graphql(arguments: Any) -> dict[str, Any]:
        return {"success": True, "response": {"data": {"viewer": {"id": "user-1"}}}, "arguments": arguments}

    events: list[dict[str, Any]] = []
    client = CodexAppServerClient(
        CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000),
        process_factory=factory,
        tools={"linear_graphql": linear_graphql},
    )
    await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    assert {
        "id": 99,
        "result": {
            "success": True,
            "response": {"data": {"viewer": {"id": "user-1"}}},
            "arguments": {"query": "query Viewer { viewer { id } }"},
        },
    } in process.sent
    tool_events = [event for event in events if event["event"] == "tool_call_completed"]
    assert tool_events[0]["method"] == "tool/call"
    assert tool_events[0]["tool_name"] == "linear_graphql"


@pytest.mark.asyncio
async def test_codex_client_emits_tool_start_success_and_failure_events(tmp_path: Path) -> None:
    success_process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {
                "id": 99,
                "method": "tool/call",
                "params": {"name": "linear_graphql", "arguments": {"query": "query Viewer { viewer { id } }"}},
            },
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
        ]
    )

    async def success_factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return success_process

    async def linear_graphql(arguments: Any) -> dict[str, Any]:
        return {"success": True, "arguments": arguments}

    success_events: list[dict[str, Any]] = []
    success_client = CodexAppServerClient(
        CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000),
        process_factory=success_factory,
        tools={"linear_graphql": linear_graphql},
    )
    await success_client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=success_events.append)

    assert [event["event"] for event in success_events if str(event["event"]).startswith("tool_call_")] == [
        "tool_call_started",
        "tool_call_completed",
    ]
    started = next(event for event in success_events if event["event"] == "tool_call_started")
    assert started["tool_name"] == "linear_graphql"
    assert started["arguments"] == {"query": "query Viewer { viewer { id } }"}

    failure_process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {
                "id": 100,
                "method": "tool/call",
                "params": {"name": "linear_graphql", "arguments": {"query": "broken"}},
            },
        ]
    )

    async def failure_factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return failure_process

    async def failing_tool(arguments: Any) -> dict[str, Any]:
        raise RuntimeError("linear unavailable")

    failure_events: list[dict[str, Any]] = []
    failure_client = CodexAppServerClient(
        CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000),
        process_factory=failure_factory,
        tools={"linear_graphql": failing_tool},
    )

    with pytest.raises(CodexError) as exc:
        await failure_client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=failure_events.append)

    assert exc.value.code == "tool_call_failed"
    assert [event["event"] for event in failure_events if str(event["event"]).startswith("tool_call_")] == [
        "tool_call_started",
        "tool_call_failed",
    ]
    failed = next(event for event in failure_events if event["event"] == "tool_call_failed")
    assert failed["tool_name"] == "linear_graphql"
    assert failed["error"] == "linear unavailable"


@pytest.mark.asyncio
async def test_supported_item_tool_call_returns_current_protocol_content_items(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {
                "id": 0,
                "result": {
                    "userAgent": "codex",
                    "platformFamily": "unix",
                    "platformOs": "macos",
                    "codexHome": "/tmp",
                },
            },
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {
                "id": 99,
                "method": "item/tool/call",
                "params": {
                    "tool": "linear_graphql",
                    "arguments": {"query": "query Viewer { viewer { id } }"},
                    "callId": "call_1",
                    "threadId": "thr_1",
                    "turnId": "turn_1",
                },
            },
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
        ]
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    async def linear_graphql(arguments: Any) -> dict[str, Any]:
        return {"success": True, "response": {"data": {"viewer": {"id": "user-1"}}}, "arguments": arguments}

    events: list[dict[str, Any]] = []
    client = CodexAppServerClient(
        CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000),
        process_factory=factory,
        tools={"linear_graphql": linear_graphql},
    )
    await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    response = next(message for message in process.sent if message.get("id") == 99)
    assert response["result"]["success"] is True
    assert response["result"]["contentItems"] == [
        {
            "type": "inputText",
            "text": json.dumps(
                {
                    "success": True,
                    "response": {"data": {"viewer": {"id": "user-1"}}},
                    "arguments": {"query": "query Viewer { viewer { id } }"},
                },
                ensure_ascii=False,
            ),
        }
    ]
    tool_events = [event for event in events if event["event"] == "tool_call_completed"]
    assert tool_events[0]["method"] == "item/tool/call"
    assert tool_events[0]["tool_name"] == "linear_graphql"


@pytest.mark.asyncio
async def test_turn_start_emits_session_id_for_turn(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
        ]
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    events: list[dict[str, Any]] = []
    client = CodexAppServerClient(CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000), process_factory=factory)
    result = await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    turn_started = [event for event in events if event["event"] == "turn_started"]
    completed = [event for event in events if event["event"] == "turn_completed"]
    assert result.session_id == "thr_1-turn_1"
    assert turn_started[0]["session_id"] == "thr_1-turn_1"
    assert completed[0]["session_id"] == "thr_1-turn_1"


@pytest.mark.asyncio
async def test_token_usage_notification_is_normalized(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {
                "method": "thread/tokenUsage/updated",
                "params": {
                    "turnId": "turn_1",
                    "total_token_usage": {
                        "input_tokens": 5,
                        "output_tokens": 3,
                        "cached_tokens": 2,
                        "total_tokens": 8,
                    },
                    "rate_limits": {"primary": {"remaining": 10}},
                },
            },
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
        ]
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    events: list[dict[str, Any]] = []
    client = CodexAppServerClient(CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000), process_factory=factory)
    await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    token_events = [event for event in events if event["event"] == "thread_token_usage_updated"]
    assert token_events[0]["usage"] == {
        "input_tokens": 5,
        "output_tokens": 3,
        "cached_tokens": 2,
        "total_tokens": 8,
    }
    assert token_events[0]["cached_tokens"] == 2
    assert token_events[0]["rate_limits"] == {"primary": {"remaining": 10}}


@pytest.mark.asyncio
async def test_generic_notifications_are_emitted_without_affecting_turn_completion(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {"method": "agent/message", "params": {"turnId": "turn_1", "message": "working"}},
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
        ]
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    events: list[dict[str, Any]] = []
    client = CodexAppServerClient(CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000), process_factory=factory)
    await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    notifications = [event for event in events if event["event"] == "notification"]
    assert notifications[0]["raw_method"] == "agent/message"
    assert notifications[0]["message"] == "working"


@pytest.mark.asyncio
async def test_command_execution_notification_is_normalized(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {
                "method": "item/commandExecution/started",
                "params": {
                    "turnId": "turn_1",
                    "command": "pytest tests/test_target.py::test_fix -q",
                },
            },
            {
                "method": "item/completed",
                "params": {
                    "turnId": "turn_1",
                    "command": "pytest tests/test_target.py::test_fix -q",
                    "exit_code": 0,
                    "message": "1 passed",
                },
            },
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
        ]
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    events: list[dict[str, Any]] = []
    client = CodexAppServerClient(CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000), process_factory=factory)
    await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    command_events = [event for event in events if event.get("command")]
    assert command_events[0]["command"] == "pytest tests/test_target.py::test_fix -q"
    assert command_events[1]["exit_code"] == 0


@pytest.mark.asyncio
async def test_agent_message_delta_extracts_text_for_logs(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {"method": "item/agentMessage/delta", "params": {"turnId": "turn_1", "delta": "working"}},
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
        ]
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    events: list[dict[str, Any]] = []
    client = CodexAppServerClient(CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000), process_factory=factory)
    await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    delta_events = [event for event in events if event.get("raw_method") == "item/agentMessage/delta"]
    assert delta_events[0]["message"] == "working"


@pytest.mark.asyncio
async def test_turn_status_changed_completed_finishes_turn(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {"method": "turn/status/changed", "params": {"turnId": "turn_1", "status": "completed"}},
        ]
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    events: list[dict[str, Any]] = []
    client = CodexAppServerClient(CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000), process_factory=factory)
    result = await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    assert result.success
    assert result.turn_count == 1
    completed = [event for event in events if event["event"] == "turn_completed"]
    assert completed[0]["raw_method"] == "turn/status/changed"


@pytest.mark.asyncio
async def test_stderr_is_drained_as_diagnostic_events(tmp_path: Path) -> None:
    process = FakeProcess(
        [
            {"id": 0, "result": {"userAgent": "codex", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp"}},
            {"id": 1, "result": {"thread": {"id": "thr_1"}}},
            {"id": 2, "result": {"turn": {"id": "turn_1"}}},
            {"method": "turn/completed", "params": {"turn": {"id": "turn_1"}, "status": "completed"}},
        ],
        stderr_lines=[b"diagnostic line\n"],
    )

    async def factory(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    events: list[dict[str, Any]] = []
    client = CodexAppServerClient(CodexConfig(read_timeout_ms=100, turn_timeout_ms=1000), process_factory=factory)
    await client.run_session(tmp_path, "Do work", "MT-1: Build", on_event=events.append)

    stderr_events = [event for event in events if event["event"] == "stderr"]
    assert stderr_events[0]["message"] == "diagnostic line"
