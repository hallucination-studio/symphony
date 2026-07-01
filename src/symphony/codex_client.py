from __future__ import annotations

import asyncio
import json
import os
import shlex
import shutil
from dataclasses import dataclass
from datetime import timezone
from pathlib import Path
from typing import Any, Awaitable, Callable
import logging

from .config import CodexConfig
from .models import utc_now

logger = logging.getLogger(__name__)


class CodexError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class CodexTurnResult:
    success: bool
    thread_id: str
    turn_id: str
    session_id: str
    turn_count: int = 1


ProcessFactory = Callable[..., Awaitable[Any]]
EventCallback = Callable[[dict[str, Any]], None]
ContinuationProvider = Callable[[int], Awaitable[str | None]]
ToolHandler = Callable[[Any], Awaitable[dict[str, Any]]]


_DYNAMIC_TOOL_SPECS: dict[str, dict[str, Any]] = {
    "linear_graphql": {
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
}


class CodexAppServerClient:
    def __init__(
        self,
        config: CodexConfig,
        *,
        process_factory: ProcessFactory | None = None,
        tools: dict[str, ToolHandler] | None = None,
    ):
        self.config = config
        self.process_factory = process_factory or asyncio.create_subprocess_exec
        self.tools = tools or {}
        self._next_id = 0
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._orphan_responses: dict[int, dict[str, Any]] = {}
        self._event_queue: asyncio.Queue[dict[str, Any]] | None = None
        self._fatal_error: asyncio.Future[CodexError] | None = None
        self._active_thread_id: str | None = None
        self._turn_sessions: dict[str, str] = {}
        self._on_event: EventCallback | None = None

    async def run_session(
        self,
        workspace_path: Path,
        prompt: str,
        title: str,
        *,
        on_event: EventCallback | None = None,
        max_turns: int = 1,
        continuation_provider: ContinuationProvider | None = None,
        worker_host: str | None = None,
    ) -> CodexTurnResult:
        self._on_event = on_event
        launch_meta = self._build_process_launch(workspace_path, worker_host=worker_host)
        self._emit(
            on_event,
            {
                "event": "process_launch",
                "command_argv": launch_meta["parts"],
                "cwd": str(workspace_path),
                "worker_host": worker_host or "local",
            },
        )
        logger.info(
            "symphony_codex_launch command=%s cwd=%s worker_host=%s",
            launch_meta["parts"],
            workspace_path,
            worker_host or "local",
        )
        proc = await self._start_process(workspace_path, worker_host=worker_host)
        self._event_queue = asyncio.Queue()
        self._fatal_error = asyncio.get_running_loop().create_future()
        reader_task = asyncio.create_task(self._read_loop(proc, on_event))
        stderr_task = asyncio.create_task(self._stderr_loop(proc, on_event))
        try:
            await self._request(
                proc,
                "initialize",
                {
                    "clientInfo": {
                        "name": "symphony_linear_codex",
                        "title": "Symphony Linear Codex",
                        "version": "0.1.0",
                    },
                    "capabilities": {"experimentalApi": True},
                },
                timeout_ms=self.config.read_timeout_ms,
            )
            await self._notify(proc, "initialized", {})
            thread_response = await self._request(
                proc,
                "thread/start",
                self._thread_start_params(workspace_path),
                timeout_ms=self.config.read_timeout_ms,
            )
            thread_id = (((thread_response.get("result") or {}).get("thread") or {}).get("id"))
            if not thread_id:
                raise CodexError("response_error", "thread/start response did not include thread.id")
            self._active_thread_id = thread_id
            self._emit(
                on_event,
                {
                    "event": "session_started",
                    "thread_id": thread_id,
                    "session_id": f"{thread_id}-",
                    "codex_app_server_pid": getattr(proc, "pid", None),
                },
            )
            turn_count = 0
            next_prompt: str | None = prompt
            last_turn_id: str | None = None
            while next_prompt is not None and turn_count < max_turns:
                turn_response = await self._start_turn(proc, thread_id, workspace_path, next_prompt, title)
                turn_id = (((turn_response.get("result") or {}).get("turn") or {}).get("id"))
                if not turn_id:
                    raise CodexError("response_error", "turn/start response did not include turn.id")
                session_id = f"{thread_id}-{turn_id}"
                self._turn_sessions[turn_id] = session_id
                self._emit(
                    on_event,
                    {
                        "event": "turn_started",
                        "thread_id": thread_id,
                        "turn_id": turn_id,
                        "session_id": session_id,
                        "codex_app_server_pid": getattr(proc, "pid", None),
                    },
                )
                turn_outcome = await self._wait_for_turn(proc, turn_id, on_event)
                if turn_outcome != "completed":
                    code = "turn_cancelled" if turn_outcome == "cancelled" else "turn_failed"
                    raise CodexError(code, f"Turn ended with status: {turn_outcome}")
                turn_count += 1
                last_turn_id = turn_id
                if continuation_provider is None or turn_count >= max_turns:
                    break
                next_prompt = await continuation_provider(turn_count)
            if last_turn_id is None:
                raise CodexError("response_error", "No Codex turns were started")
            return CodexTurnResult(True, thread_id, last_turn_id, f"{thread_id}-{last_turn_id}", turn_count)
        except Exception:
            if getattr(proc, "returncode", None) is None:
                proc.kill()
            raise
        finally:
            self._event_queue = None
            self._fatal_error = None
            self._active_thread_id = None
            self._turn_sessions = {}
            self._on_event = None
            reader_task.cancel()
            stderr_task.cancel()
            try:
                await reader_task
            except asyncio.CancelledError:
                pass
            try:
                await stderr_task
            except asyncio.CancelledError:
                pass
            if getattr(proc, "returncode", None) is None:
                proc.kill()
            wait = getattr(proc, "wait", None)
            if wait:
                try:
                    await wait()
                except Exception:
                    pass

    def _build_process_launch(self, workspace_path: Path, *, worker_host: str | None = None) -> dict[str, Any]:
        if worker_host:
            remote_command = f"cd {shlex.quote(str(workspace_path))} && {self.config.command}"
            parts = ["ssh", worker_host, remote_command]
        else:
            parts = ["bash", "-lc", self.config.command]
        return {"parts": parts}

    async def _start_process(self, workspace_path: Path, *, worker_host: str | None = None) -> Any:
        if not workspace_path.exists() or not workspace_path.is_dir():
            raise CodexError("invalid_workspace_cwd", f"Workspace path is not a directory: {workspace_path}")
        parts = self._build_process_launch(workspace_path, worker_host=worker_host)["parts"]
        env = self._process_env(workspace_path)
        try:
            return await self.process_factory(
                *parts,
                cwd=str(workspace_path),
                env=env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=10 * 1024 * 1024,
            )
        except FileNotFoundError as exc:
            raise CodexError("codex_not_found", str(exc)) from exc
        except OSError as exc:
            raise CodexError("port_exit", str(exc)) from exc

    def _process_env(self, workspace_path: Path) -> dict[str, str]:
        env = dict(os.environ)
        codex_home = workspace_path / ".codex-home"
        codex_home.mkdir(parents=True, exist_ok=True)
        self._seed_codex_home(codex_home, env.get("CODEX_HOME"))
        env["CODEX_HOME"] = str(codex_home)
        env.pop("PYTHONHOME", None)
        workspace_src = workspace_path / "src"
        if workspace_src.is_dir():
            env["PYTHONPATH"] = str(workspace_src)
        else:
            env.pop("PYTHONPATH", None)
        env["PYTHONNOUSERSITE"] = "1"
        return env

    def _seed_codex_home(self, target_home: Path, source_home_raw: str | None) -> None:
        source_home = Path(source_home_raw).expanduser() if source_home_raw else Path.home() / ".codex"
        for relative in ("config.toml", "auth.json"):
            source = source_home / relative
            target = target_home / relative
            if target.exists() or not source.exists() or not source.is_file():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

    def _thread_start_params(self, workspace_path: Path) -> dict[str, Any]:
        params: dict[str, Any] = {
            "cwd": str(workspace_path),
            "approvalPolicy": self.config.approval_policy,
            "sandbox": self.config.thread_sandbox,
            "ephemeral": True,
            "baseInstructions": None,
        }
        dynamic_tools = self._dynamic_tool_specs()
        if dynamic_tools:
            params["dynamicTools"] = dynamic_tools
        return params

    def _dynamic_tool_specs(self) -> list[dict[str, Any]]:
        return [_DYNAMIC_TOOL_SPECS[name] for name in self.tools if name in _DYNAMIC_TOOL_SPECS]

    async def _start_turn(
        self, proc: Any, thread_id: str, workspace_path: Path, prompt: str, title: str
    ) -> dict[str, Any]:
        return await self._request(
            proc,
            "turn/start",
            {
                "threadId": thread_id,
                "cwd": str(workspace_path),
                "approvalPolicy": self.config.approval_policy,
                "sandboxPolicy": self.config.turn_sandbox_policy,
                "input": [{"type": "text", "text": prompt}],
                "clientUserMessageId": title,
            },
            timeout_ms=self.config.read_timeout_ms,
        )

    async def _request(self, proc: Any, method: str, params: dict[str, Any], *, timeout_ms: int) -> dict[str, Any]:
        request_id = self._next_id
        self._next_id += 1
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[request_id] = future
        await self._send(proc, {"method": method, "id": request_id, "params": params})
        orphan = self._orphan_responses.pop(request_id, None)
        if orphan is not None and not future.done():
            future.set_result(orphan)
        try:
            response = await asyncio.wait_for(future, timeout=timeout_ms / 1000)
        except TimeoutError as exc:
            self._pending.pop(request_id, None)
            self._emit(
                self._on_event,
                {
                    "event": "request_timeout",
                    "timestamp": utc_now().astimezone(timezone.utc).isoformat(),
                    "method": method,
                    "timeout_ms": timeout_ms,
                },
            )
            logger.error("symphony_codex_request_timeout method=%s timeout_ms=%s", method, timeout_ms)
            raise CodexError("response_timeout", f"{method} timed out") from exc
        if response.get("error"):
            raise CodexError("response_error", str(response["error"]))
        return response

    async def _notify(self, proc: Any, method: str, params: dict[str, Any]) -> None:
        await self._send(proc, {"method": method, "params": params})

    async def _send(self, proc: Any, message: dict[str, Any]) -> None:
        proc.stdin.write(json.dumps(message, separators=(",", ":")).encode() + b"\n")
        await proc.stdin.drain()

    async def _read_loop(self, proc: Any, on_event: EventCallback | None) -> None:
        while True:
            line = await proc.stdout.readline()
            if not line:
                self._set_fatal_error(CodexError("port_exit", "Codex app-server stdout closed"))
                return
            try:
                message = json.loads(line.decode())
            except json.JSONDecodeError:
                self._emit(on_event, {"event": "malformed", "message": line.decode(errors="replace")[:500]})
                continue
            if "id" in message and ("result" in message or "error" in message) and "method" not in message:
                future = self._pending.pop(message["id"], None)
                if future and not future.done():
                    future.set_result(message)
                else:
                    self._orphan_responses[message["id"]] = message
                continue
            if "id" in message and "method" in message:
                try:
                    await self._handle_server_request(proc, message, on_event)
                except CodexError as exc:
                    self._set_fatal_error(exc)
                    return
                continue
            if "method" in message:
                event = self._event_from_notification(message)
                if self._event_queue is not None:
                    await self._event_queue.put(event)
                self._emit(on_event, event)

    async def _stderr_loop(self, proc: Any, on_event: EventCallback | None) -> None:
        while True:
            line = await proc.stderr.readline()
            if not line:
                return
            self._emit(
                on_event,
                {
                    "event": "stderr",
                    "timestamp": utc_now().astimezone(timezone.utc).isoformat(),
                    "message": line.decode(errors="replace").rstrip()[:1000],
                    "codex_app_server_pid": getattr(proc, "pid", None),
                },
            )

    async def _handle_server_request(self, proc: Any, message: dict[str, Any], on_event: EventCallback | None) -> None:
        method = message.get("method")
        request_id = message["id"]
        if "approval" in method and "file" in method:
            self._emit(
                on_event,
                {
                    "event": "approval_auto_approved",
                    "timestamp": utc_now().astimezone(timezone.utc).isoformat(),
                    "method": method,
                    "payload": message.get("params") or {},
                },
            )
            await self._send(proc, {"id": request_id, "result": {"decision": "acceptForSession"}})
        elif "approval" in method or "exec_command" in method or "command" in method:
            self._emit(
                on_event,
                {
                    "event": "approval_auto_approved",
                    "timestamp": utc_now().astimezone(timezone.utc).isoformat(),
                    "method": method,
                    "payload": message.get("params") or {},
                },
            )
            await self._send(proc, {"id": request_id, "result": {"decision": "approved_for_session"}})
        elif "request_user_input" in method:
            raise CodexError("turn_input_required", "Codex requested user input")
        elif method in {"tool/call", "item/tool/call"}:
            await self._handle_tool_call(proc, request_id, method, message.get("params") or {}, on_event)
        else:
            self._emit(
                on_event,
                {
                    "event": "unsupported_tool_call",
                    "timestamp": utc_now().astimezone(timezone.utc).isoformat(),
                    "method": method,
                    "payload": message.get("params") or {},
                },
            )
            await self._send(
                proc,
                {
                    "id": request_id,
                    "error": {"code": -32601, "message": f"Unsupported client request: {method}"},
                },
            )

    async def _handle_tool_call(
        self,
        proc: Any,
        request_id: int,
        method: str,
        params: dict[str, Any],
        on_event: EventCallback | None,
    ) -> None:
        name = params.get("name") or params.get("toolName") or params.get("tool_name") or params.get("tool")
        arguments = params.get("arguments", params.get("input", {}))
        if not isinstance(name, str) or name not in self.tools:
            self._emit(
                on_event,
                {
                    "event": "unsupported_tool_call",
                    "timestamp": utc_now().astimezone(timezone.utc).isoformat(),
                    "method": method,
                    "tool_name": name,
                    "payload": params,
                },
            )
            await self._send(
                proc,
                {
                    "id": request_id,
                    "error": {"code": -32601, "message": f"Unsupported tool: {name}"},
                },
            )
            return

        self._emit(
            on_event,
            {
                "event": "tool_call_started",
                "timestamp": utc_now().astimezone(timezone.utc).isoformat(),
                "method": method,
                "tool_name": name,
                "arguments": arguments,
                "payload": params,
            },
        )
        try:
            result = await self.tools[name](arguments)
        except Exception as exc:
            self._emit(
                on_event,
                {
                    "event": "tool_call_failed",
                    "timestamp": utc_now().astimezone(timezone.utc).isoformat(),
                    "method": method,
                    "tool_name": name,
                    "arguments": arguments,
                    "error": str(exc),
                    "payload": params,
                },
            )
            raise CodexError("tool_call_failed", str(exc)) from exc
        self._emit(
            on_event,
            {
                "event": "tool_call_completed",
                "timestamp": utc_now().astimezone(timezone.utc).isoformat(),
                "method": method,
                "tool_name": name,
                "payload": result,
            },
        )
        await self._send(proc, {"id": request_id, "result": _tool_call_response(method, result)})

    async def _wait_for_turn(self, proc: Any, turn_id: str, on_event: EventCallback | None) -> str:
        if self.config.turn_timeout_ms <= 0:
            return await self._wait_for_turn_event(turn_id, on_event)
        deadline = self.config.turn_timeout_ms / 1000
        try:
            return await asyncio.wait_for(self._wait_for_turn_event(turn_id, on_event), timeout=deadline)
        except TimeoutError as exc:
            proc.kill()
            raise CodexError("turn_timeout", "Codex turn timed out") from exc

    async def _wait_for_turn_event(self, turn_id: str, on_event: EventCallback | None) -> str:
        if self._event_queue is None:
            raise CodexError("response_error", "Codex event queue is not initialized")
        while True:
            event_task = asyncio.create_task(self._event_queue.get())
            wait_for: set[asyncio.Future[Any] | asyncio.Task[Any]] = {event_task}
            if self._fatal_error is not None:
                wait_for.add(self._fatal_error)
            done, pending = await asyncio.wait(wait_for, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                if task is event_task:
                    task.cancel()
            if event_task in done:
                event = event_task.result()
                if event.get("turn_id") != turn_id:
                    continue
                if event["event"] == "turn_completed":
                    return "completed"
                if event["event"] == "turn_cancelled":
                    return "cancelled"
                if event["event"] in {"turn_failed", "turn_ended_with_error"}:
                    return "failed"
            if self._fatal_error in done and self._fatal_error is not None:
                raise self._fatal_error.result()

    def _set_fatal_error(self, error: CodexError) -> None:
        if self._fatal_error is not None and not self._fatal_error.done():
            self._fatal_error.set_result(error)

    def _event_from_notification(self, message: dict[str, Any]) -> dict[str, Any]:
        method = message.get("method", "other_message")
        params = message.get("params") or {}
        turn = params.get("turn") if isinstance(params, dict) else None
        event_name = "notification"
        status = params.get("status") if isinstance(params, dict) else None
        status = status or ((turn or {}).get("status") if isinstance(turn, dict) else None)
        if method == "turn/completed":
            event_name = "turn_completed" if status in {None, "completed", "success"} else "turn_failed"
        elif method == "turn/status/changed":
            if status in {"completed", "success"}:
                event_name = "turn_completed"
            elif status in {"failed", "error"}:
                event_name = "turn_failed"
            elif status in {"cancelled", "canceled"}:
                event_name = "turn_cancelled"
        elif method == "thread/tokenUsage/updated":
            event_name = "thread_token_usage_updated"
        elif method == "turn/cancelled":
            event_name = "turn_cancelled"
        elif method == "turn/failed":
            event_name = "turn_failed"
        usage = self._usage_from_params(method, params)
        event = {
            "event": event_name,
            "timestamp": utc_now().astimezone(timezone.utc).isoformat(),
            "turn_id": (turn or {}).get("id") or params.get("turnId"),
            "thread_id": self._active_thread_id,
            "session_id": self._session_id_for_turn((turn or {}).get("id") or params.get("turnId")),
            "message": self._message_from_params(method, params),
            "usage": usage,
            "rate_limits": self._rate_limits_from_params(params),
            "raw_method": method,
            "payload": params,
        }
        command = self._command_from_params(method, params)
        if command is not None:
            event["command"] = command
        exit_code = self._exit_code_from_params(method, params)
        if exit_code is not None:
            event["exit_code"] = exit_code
        if usage is not None:
            event.update(usage)
        return event

    def _session_id_for_turn(self, turn_id: Any) -> str | None:
        if not isinstance(turn_id, str):
            return None
        if turn_id in self._turn_sessions:
            return self._turn_sessions[turn_id]
        if self._active_thread_id:
            return f"{self._active_thread_id}-{turn_id}"
        return None

    def _usage_from_params(self, method: str, params: dict[str, Any]) -> dict[str, int] | None:
        if method != "thread/tokenUsage/updated":
            return None
        raw = params.get("total_token_usage") or params.get("totalTokenUsage") or params.get("tokenUsage")
        if not isinstance(raw, dict):
            return None
        usage = {
            "input_tokens": self._int_from_keys(raw, "input_tokens", "inputTokens", "input"),
            "output_tokens": self._int_from_keys(raw, "output_tokens", "outputTokens", "output"),
            "cached_tokens": self._int_from_keys(raw, "cached_tokens", "cachedTokens", "cached"),
            "total_tokens": self._int_from_keys(raw, "total_tokens", "totalTokens", "total"),
        }
        return usage

    def _rate_limits_from_params(self, params: dict[str, Any]) -> dict[str, Any] | None:
        raw = params.get("rate_limits") or params.get("rateLimits")
        return raw if isinstance(raw, dict) else None

    def _message_from_params(self, method: str, params: dict[str, Any]) -> str | None:
        for key in ("message", "delta", "text"):
            value = params.get(key)
            if isinstance(value, str) and value:
                return value
        item = params.get("item")
        if isinstance(item, dict):
            for key in ("message", "delta", "text"):
                value = item.get(key)
                if isinstance(value, str) and value:
                    return value
            content = item.get("content")
            if isinstance(content, list):
                parts = [
                    part.get("text")
                    for part in content
                    if isinstance(part, dict) and isinstance(part.get("text"), str)
                ]
                if parts:
                    return "".join(parts)
        status = params.get("status")
        if method.endswith("/status/changed") and isinstance(status, str) and status:
            return f"status={status}"
        return None

    def _command_from_params(self, method: str, params: dict[str, Any]) -> str | None:
        command = params.get("command")
        if isinstance(command, str) and command.strip():
            return command.strip()
        item = params.get("item")
        if isinstance(item, dict):
            nested = item.get("command")
            if isinstance(nested, str) and nested.strip():
                return nested.strip()
        return None

    def _exit_code_from_params(self, method: str, params: dict[str, Any]) -> int | None:
        if self._command_from_params(method, params) is None:
            return None
        for key in ("exit_code", "exitCode"):
            value = params.get(key)
            if isinstance(value, int) and not isinstance(value, bool):
                return value
        item = params.get("item")
        if isinstance(item, dict):
            for key in ("exit_code", "exitCode"):
                value = item.get(key)
                if isinstance(value, int) and not isinstance(value, bool):
                    return value
        return None

    def _int_from_keys(self, values: dict[str, Any], *keys: str) -> int:
        for key in keys:
            value = values.get(key)
            if isinstance(value, bool):
                continue
            if isinstance(value, int):
                return value
            if isinstance(value, str) and value.strip().isdigit():
                return int(value.strip())
        return 0

    def _emit(self, callback: EventCallback | None, event: dict[str, Any]) -> None:
        if callback:
            callback(event)


def _tool_call_response(method: str, result: dict[str, Any]) -> dict[str, Any]:
    if method != "item/tool/call":
        return result
    return {
        "success": bool(result.get("success", True)),
        "contentItems": [{"type": "inputText", "text": json.dumps(result, ensure_ascii=False)}],
    }
