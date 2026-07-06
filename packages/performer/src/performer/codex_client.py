from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from performer_api.config import CodexConfig
from .codex_client_helpers import (
    CodexError,
    _ThreadRunAdapter,
    _aiter,
    _callable_accepts_keyword,
    _classify_sdk_exception,
    _close_sdk_client,
    _codex_sdk_env,
    _first_dict,
    _first_string,
    _init_backoff_ms,
    _is_terminal_init_error,
    _is_transient_codex_error,
    _latest_turn_identity,
    _maybe_await,
    _parse_structured_result,
    _sdk_event_to_dict,
    _string_attr,
    _timeout_seconds,
    _usage_from_any,
)


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


CodexRunResult = CodexTurnResult


EventCallback = Callable[[dict[str, Any]], None]
ContinuationProvider = Callable[[int], Any]


STRUCTURED_RESULT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "test_commands": {"type": "array", "items": {"type": "string"}},
        "changed_files": {"type": "array", "items": {"type": "string"}},
        "remaining_risks": {"type": "array", "items": {"type": "string"}},
        "next_action": {"type": "string", "enum": ["ready_for_review", "needs_human", "blocked"]},
    },
    "required": ["summary", "test_commands", "changed_files", "remaining_risks", "next_action"],
    "additionalProperties": False,
}


TEXT_RESULT_SCHEMA: dict[str, Any] = {"type": "object", "additionalProperties": True}



class CodexSdkClient:
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
        max_turns: int = 1,
        continuation_provider: ContinuationProvider | None = None,
        worker_host: str | None = None,
        existing_thread_id: str | None = None,
        output_schema: dict[str, Any] | None = None,
    ) -> CodexRunResult:
        _ = title
        if worker_host:
            raise CodexError("unsupported_sdk_worker_host", "Codex SDK backend does not support worker_host")
        if not workspace_path.exists() or not workspace_path.is_dir():
            raise CodexError("invalid_workspace_cwd", f"Workspace path is not a directory: {workspace_path}")
        events: list[dict[str, Any]] = []

        def emit(event: dict[str, Any]) -> None:
            events.append(event)
            if on_event:
                on_event(event)

        emit(
            {
                "event": "sdk_session_starting",
                "backend": "sdk",
                "thread_id": existing_thread_id,
                "cwd": str(workspace_path),
            }
        )
        client, thread, thread_id = await self._init_thread(workspace_path, existing_thread_id, emit=emit)
        emit(
            {
                "event": "session_started",
                "backend": "sdk",
                "thread_id": thread_id,
                "session_id": f"{thread_id}-",
                "cwd": str(workspace_path),
            }
        )
        schema = output_schema or STRUCTURED_RESULT_SCHEMA
        requires_handoff = output_schema is None
        final_response: str | None = None
        structured: dict[str, Any] | None = None
        turn_count = 0
        turn_id = "turn"
        session_id = f"{thread_id}-{turn_id}"
        turn_prompt: str | None = prompt
        max_turn_count = max(1, int(max_turns or 1))
        while turn_prompt is not None and turn_count < max_turn_count:
            validate_this_turn = requires_handoff and (turn_count + 1 >= max_turn_count or continuation_provider is None)
            turn, turn_id, session_id, final_response, turn_structured = await self._run_structured_turn(
                thread,
                turn_prompt,
                schema,
                thread_id=thread_id,
                emit=emit,
                events=events,
                validate_structured=validate_this_turn,
            )
            if turn_structured is None:
                turn_structured = _parse_structured_result(final_response)
            if turn_structured is not None:
                structured = turn_structured
            turn_count += 1
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
            if structured is not None or turn_count >= max_turn_count or continuation_provider is None:
                break
            turn_prompt = await _maybe_await(continuation_provider(turn_count))
            if turn_prompt is not None and not isinstance(turn_prompt, str):
                raise CodexError(
                    "invalid_continuation_prompt",
                    f"Continuation provider returned unsupported prompt type: {type(turn_prompt).__name__}",
                )
            if turn_prompt:
                emit(
                    {
                        "event": "turn_continuing",
                        "backend": "sdk",
                        "thread_id": thread_id,
                        "turn_count": turn_count,
                        "next_turn": turn_count + 1,
                    }
                )
        await _close_sdk_client(client)
        return CodexRunResult(
            True,
            thread_id,
            turn_id,
            session_id,
            turn_count,
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
        validate_structured: bool,
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
                    validate_structured=validate_structured,
                )
                if validate_structured and structured is None:
                    structured = _parse_structured_result(final_response)
                if validate_structured and structured is None:
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

    async def _init_thread(
        self,
        workspace_path: Path,
        existing_thread_id: str | None,
        *,
        emit: EventCallback,
    ) -> tuple[Any, Any, str]:
        attempts = max(1, self.config.init_max_attempts)
        last_code = "sdk_transport_error"
        last_message = ""
        for attempt in range(1, attempts + 1):
            emit(
                {
                    "event": "codex_init_starting",
                    "backend": "sdk",
                    "cwd": str(workspace_path),
                    "existing_thread_id": existing_thread_id,
                    "attempt": attempt,
                }
            )
            try:
                client, thread = await asyncio.wait_for(
                    self._retry_overload(
                        lambda: self._client_and_thread(workspace_path, existing_thread_id, emit=emit),
                        emit=emit,
                    ),
                    timeout=_timeout_seconds(self.config.read_timeout_ms),
                )
                thread_id = _string_attr(thread, "id") or existing_thread_id
                if not thread_id:
                    raise CodexError("response_error", "Codex SDK thread did not include an id")
                emit(
                    {
                        "event": "codex_init_succeeded",
                        "backend": "sdk",
                        "attempts": attempt,
                        "thread_id": thread_id,
                    }
                )
                return client, thread, thread_id
            except (asyncio.TimeoutError, TimeoutError) as exc:
                code = "timeout"
                last_code = code
                last_message = f"Codex SDK init exceeded read_timeout_ms={self.config.read_timeout_ms}"
                if attempt >= attempts:
                    emit(
                        {
                            "event": "codex_init_failed",
                            "backend": "sdk",
                            "attempts": attempt,
                            "message": code,
                        }
                    )
                    raise CodexError("codex_init_failed", f"{code}: {last_message}") from exc
                delay_ms = _init_backoff_ms(self.config, attempt)
                emit(
                    {
                        "event": "codex_init_retrying",
                        "backend": "sdk",
                        "attempt": attempt + 1,
                        "delay_ms": delay_ms,
                        "message": code,
                    }
                )
                await asyncio.sleep(delay_ms / 1000)
            except Exception as exc:
                classified = _classify_sdk_exception(exc)
                code = classified.code
                last_code = code
                last_message = str(exc)
                last_http_status = classified.http_status
                if _is_terminal_init_error(code):
                    emit(
                        {
                            "event": "codex_init_failed",
                            "backend": "sdk",
                            "attempts": attempt,
                            "message": code,
                        }
                    )
                    if isinstance(exc, CodexError):
                        raise
                    raise CodexError(code, str(exc), http_status=last_http_status) from exc
                if attempt >= attempts or not _is_transient_codex_error(code):
                    emit(
                        {
                            "event": "codex_init_failed",
                            "backend": "sdk",
                            "attempts": attempt,
                            "message": code,
                        }
                    )
                    raise CodexError("codex_init_failed", f"{code}: {last_message}", http_status=last_http_status) from exc
                delay_ms = _init_backoff_ms(self.config, attempt)
                emit(
                    {
                        "event": "codex_init_retrying",
                        "backend": "sdk",
                        "attempt": attempt + 1,
                        "delay_ms": delay_ms,
                        "message": code,
                    }
                )
                await asyncio.sleep(delay_ms / 1000)
        raise CodexError("codex_init_failed", f"{last_code}: {last_message}")

    async def _retry_overload(self, op: Callable[[], Any], *, emit: EventCallback) -> Any:
        attempts = max(1, self.config.overload_max_attempts)
        delay_ms = max(1, self.config.overload_initial_delay_ms)
        max_delay_ms = max(1, self.config.overload_max_delay_ms)
        for attempt in range(1, attempts + 1):
            try:
                return await _maybe_await(op())
            except Exception as exc:
                classified = _classify_sdk_exception(exc)
                if classified.code == "codex_bad_request":
                    emit(
                        {
                            "event": "codex_request_failed_terminal",
                            "backend": "sdk",
                            "code": classified.code,
                            "http_status": classified.http_status,
                            "message": str(exc),
                        }
                    )
                    raise CodexError(classified.code, str(exc), http_status=classified.http_status) from exc
                if classified.code != "upstream_overloaded":
                    raise
                if attempt >= attempts:
                    emit(
                        {
                            "event": "codex_overload_exhausted",
                            "backend": "sdk",
                            "attempts": attempt,
                            "http_status": classified.http_status,
                            "message": str(exc),
                        }
                    )
                    raise CodexError("upstream_overloaded_exhausted", str(exc), http_status=classified.http_status) from exc
                current_delay_ms = min(delay_ms, max_delay_ms)
                emit(
                    {
                        "event": "codex_overload_retrying",
                        "backend": "sdk",
                        "attempt": attempt + 1,
                        "delay_ms": current_delay_ms,
                        "http_status": classified.http_status,
                        "message": str(exc),
                    }
                )
                await asyncio.sleep(current_delay_ms / 1000)
                delay_ms = min(max_delay_ms, delay_ms * 2)

    async def _client_and_thread(
        self,
        workspace_path: Path,
        existing_thread_id: str | None,
        *,
        emit: EventCallback,
    ) -> tuple[Any, Any]:
        client = await self._client()
        thread = await self._thread(client, workspace_path, existing_thread_id, emit=emit)
        return client, thread

    async def _client(self) -> Any:
        if self.sdk_factory is not None:
            client = self.sdk_factory(self.config)
            if hasattr(client, "__await__"):
                client = await client
            return client
        if self.config.sdk_codex_bin and not os.access(self.config.sdk_codex_bin, os.X_OK):
            raise CodexError("invalid_sdk_codex_bin", f"Codex binary is not executable: {self.config.sdk_codex_bin}")
        try:
            from openai_codex import AsyncCodex  # type: ignore
            from openai_codex import CodexConfig as SdkCodexConfig  # type: ignore
        except ImportError as exc:
            raise CodexError("codex_sdk_not_installed", "Install openai-codex to use codex.backend=sdk") from exc
        sdk_env = _codex_sdk_env()
        if self.config.sdk_codex_bin or sdk_env or self.config.config_overrides:
            sdk_kwargs: dict[str, Any] = {"codex_bin": self.config.sdk_codex_bin}
            if sdk_env and _callable_accepts_keyword(SdkCodexConfig, "env"):
                sdk_kwargs["env"] = sdk_env
            if self.config.config_overrides and _callable_accepts_keyword(SdkCodexConfig, "config_overrides"):
                sdk_kwargs["config_overrides"] = tuple(self.config.config_overrides)
            sdk_config = SdkCodexConfig(**sdk_kwargs)
        else:
            sdk_config = None
        return AsyncCodex(config=sdk_config)

    async def _thread(
        self,
        client: Any,
        workspace_path: Path,
        existing_thread_id: str | None,
        *,
        emit: EventCallback | None = None,
    ) -> Any:
        kwargs = self._thread_kwargs(workspace_path)
        if existing_thread_id:
            resume = getattr(client, "thread_resume", None)
            if not callable(resume):
                raise CodexError("sdk_missing_thread_resume", "Codex SDK client does not support thread_resume")
            try:
                return await _maybe_await(resume(existing_thread_id, **kwargs))
            except Exception as exc:
                if emit is not None:
                    emit(
                        {
                            "event": "thread_resume_failed",
                            "backend": "sdk",
                            "thread_id": existing_thread_id,
                            "cwd": str(workspace_path),
                            "message": str(exc),
                        }
                    )
        start = getattr(client, "thread_start", None)
        if not callable(start):
            raise CodexError("sdk_missing_thread_start", "Codex SDK client does not support thread_start")
        return await _maybe_await(start(**kwargs))

    def _thread_kwargs(self, workspace_path: Path) -> dict[str, Any]:
        kwargs: dict[str, Any] = {"cwd": str(workspace_path)}
        if self.config.model:
            kwargs["model"] = self.config.model
        if self.config.sandbox:
            kwargs["sandbox"] = self.config.sandbox
        return kwargs

    async def _start_sdk_turn(self, thread: Any, prompt: str, output_schema: dict[str, Any]) -> Any:
        run = getattr(thread, "run", None)
        if callable(run):
            return _ThreadRunAdapter(thread, output_schema, prompt)
        turn = getattr(thread, "turn", None)
        if callable(turn):
            try:
                return await _maybe_await(turn(prompt, output_schema=output_schema))
            except TypeError:
                return await _maybe_await(turn(prompt))
        raise CodexError("sdk_missing_turn", "Codex SDK thread does not support turn or run")

    async def _consume_turn(
        self,
        turn: Any,
        emit: EventCallback,
        *,
        validate_structured: bool,
    ) -> tuple[str | None, dict[str, Any] | None]:
        stream = getattr(turn, "stream", None)
        if callable(stream):
            final_response: str | None = None
            structured: dict[str, Any] | None = None
            async for event in _aiter(stream()):
                mapped = _sdk_event_to_dict(event)
                if mapped:
                    emit(mapped)
                usage = _usage_from_any(event)
                if usage is not None:
                    emit({"event": "thread_token_usage_updated", "backend": "sdk", "usage": usage, **usage})
                final_response = _first_string(event, "final_response", "response", "text", default=final_response)
                structured = _first_dict(event, "structured_result", "output", "parsed", default=structured, validate=validate_structured)
            return final_response, structured
        run = getattr(turn, "run", None)
        if not callable(run):
            raise CodexError("sdk_missing_run", "Codex SDK turn does not support stream or run")
        result = await _maybe_await(run())
        usage = _usage_from_any(result)
        if usage is not None:
            emit({"event": "thread_token_usage_updated", "backend": "sdk", "usage": usage, **usage})
        return (
            _first_string(result, "final_response", "response", "text"),
            _first_dict(result, "structured_result", "output", "parsed", validate=validate_structured),
        )
