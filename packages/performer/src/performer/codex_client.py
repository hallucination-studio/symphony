from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .codex_client_helpers import (
    CodexError,
    _classify_sdk_exception,
    _close_sdk_client,
    _latest_turn_identity,
    _parse_structured_result,
    _string_attr,
    _timeout_seconds,
)
from .codex_config import CodexConfig
from .codex_client_sdk_runtime import _CodexSdkRuntimeMixin


@dataclass(frozen=True)
class CodexTurnResult:
    success: bool
    thread_id: str
    turn_id: str
    session_id: str
    turn_count: int = 1
    backend: str = "sdk"
    final_response: str | None = None
    structured_result: dict[str, Any] | None = None
    events: list[dict[str, Any]] = field(default_factory=list)


EventCallback = Callable[[dict[str, Any]], None]

class CodexSdkClient(_CodexSdkRuntimeMixin):
    def __init__(self, config: CodexConfig, *, sdk_factory: Any | None = None):
        self.config = config
        self.sdk_factory = sdk_factory

    async def run_session(
        self,
        workspace_path: Path,
        prompt: str,
        title: str,
        *,
        on_event: EventCallback | None = None,
        existing_thread_id: str | None = None,
        output_schema: dict[str, Any],
    ) -> CodexTurnResult:
        _ = title
        if not workspace_path.exists() or not workspace_path.is_dir():
            raise CodexError("invalid_workspace_cwd", f"Workspace path is not a directory: {workspace_path}")
        events: list[dict[str, Any]] = []
        emit = _event_collector(events, on_event)
        emit(
            {
                "event": "sdk_session_starting",
                "backend": "sdk",
                "thread_id": existing_thread_id,
                "cwd": str(workspace_path),
            }
        )
        client, thread, thread_id = await self._init_thread(workspace_path, existing_thread_id, emit=emit)
        emit({"event": "session_started", "backend": "sdk", "thread_id": thread_id, "session_id": f"{thread_id}-", "cwd": str(workspace_path)})
        _turn, turn_id, session_id, final_response, structured = await self._run_structured_turn(
            thread,
            prompt,
            output_schema,
            thread_id=thread_id,
            emit=emit,
            events=events,
            require_structured=True,
            validate_structured=True,
        )
        await _close_sdk_client(client)
        emit(
            {
                "event": "turn_completed",
                "backend": "sdk",
                "thread_id": thread_id,
                "turn_id": turn_id,
                "session_id": session_id,
                "message": final_response,
            }
        )
        return CodexTurnResult(
            True,
            thread_id,
            turn_id,
            session_id,
            1,
            backend="sdk",
            final_response=final_response,
            structured_result=structured,
            events=events,
        )

    async def _run_structured_turn(
        self,
        thread: Any,
        prompt: str,
        output_schema: dict[str, Any],
        *,
        thread_id: str,
        emit: EventCallback,
        events: list[dict[str, Any]],
        require_structured: bool,
        validate_default_shape: bool,
    ) -> tuple[Any, str, str, str | None, dict[str, Any] | None]:
        turn_id = "turn"
        session_id = f"{thread_id}-{turn_id}"
        turn_prompt = prompt
        for attempt in range(1, 3):
            try:
                turn, turn_id, session_id, final_response, structured = await self._run_turn_with_timeout(
                    thread,
                    turn_prompt,
                    output_schema,
                    thread_id=thread_id,
                    emit=emit,
                    validate_structured=validate_default_shape,
                )
                if structured is None:
                    structured = _parse_structured_result(final_response, validate=validate_default_shape)
                if require_structured and structured is None:
                    raise CodexError("invalid_structured_output", "Codex SDK turn did not produce the required structured JSON result")
                return turn, turn_id, session_id, final_response, structured
            except (asyncio.TimeoutError, TimeoutError) as exc:
                timeout_turn_id, timeout_session_id = _latest_turn_identity(
                    events,
                    thread_id=thread_id,
                    default_turn_id=turn_id,
                    default_session_id=session_id,
                )
                emit(
                    {
                        "event": "request_timeout",
                        "backend": "sdk",
                        "thread_id": thread_id,
                        "turn_id": timeout_turn_id,
                        "session_id": timeout_session_id,
                        "timeout_ms": self.config.hard_turn_timeout_ms,
                    }
                )
                raise CodexError("timeout", f"Codex SDK turn exceeded hard_turn_timeout_ms={self.config.hard_turn_timeout_ms}") from exc
            except Exception as exc:
                classified = _classify_sdk_exception(exc)
                code = classified.code
                if isinstance(exc, CodexError) and code != "invalid_structured_output":
                    raise
                if code != "invalid_structured_output" or attempt >= 2:
                    if isinstance(exc, CodexError):
                        raise
                    raise CodexError(code, str(exc), http_status=classified.http_status) from exc
                emit(
                    {
                        "event": "turn_retrying",
                        "backend": "sdk",
                        "thread_id": thread_id,
                        "turn_id": turn_id,
                        "session_id": session_id,
                        "message": code,
                        "attempt": attempt + 1,
                    }
                )
                turn_prompt = (
                    f"{prompt}\n\nYour previous response did not match the required JSON schema. "
                    "Reply again with only valid JSON for the required structured result."
                )
        raise CodexError("invalid_structured_output", "Codex SDK turn did not produce the required structured JSON result")

    async def _run_turn_with_timeout(
        self,
        thread: Any,
        prompt: str,
        output_schema: dict[str, Any],
        *,
        thread_id: str,
        emit: EventCallback,
        validate_structured: bool,
    ) -> tuple[Any, str, str, str | None, dict[str, Any] | None]:
        return await asyncio.wait_for(
            self._run_turn(thread, prompt, output_schema, thread_id=thread_id, emit=emit, validate_structured=validate_structured),
            timeout=_timeout_seconds(self.config.hard_turn_timeout_ms),
        )

    async def _run_turn(
        self,
        thread: Any,
        prompt: str,
        output_schema: dict[str, Any],
        *,
        thread_id: str,
        emit: EventCallback,
        validate_structured: bool,
    ) -> tuple[Any, str, str, str | None, dict[str, Any] | None]:
        async def op() -> tuple[Any, str, str, str | None, dict[str, Any] | None]:
            turn = await self._start_sdk_turn(thread, prompt, output_schema)
            turn_id = _string_attr(turn, "id") or "turn"
            session_id = f"{thread_id}-{turn_id}"
            emit({"event": "turn_started", "backend": "sdk", "thread_id": thread_id, "turn_id": turn_id, "session_id": session_id})
            final_response, structured = await self._consume_turn(turn, emit, validate_structured=validate_structured)
            return turn, turn_id, session_id, final_response, structured

        return await self._retry_overload(op, emit=emit)


def _event_collector(events: list[dict[str, Any]], on_event: EventCallback | None) -> EventCallback:
    def emit(event: dict[str, Any]) -> None:
        events.append(event)
        if on_event:
            on_event(event)

    return emit
