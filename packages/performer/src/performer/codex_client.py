from __future__ import annotations

import asyncio
from dataclasses import dataclass
import inspect
import json
import os
from pathlib import Path
import re
from typing import Any, Callable

from .codex_client_helpers import (
    CodexError,
    _classify_sdk_exception,
    _close_sdk_client,
    _codex_sdk_env,
    _init_backoff_ms,
    _is_terminal_init_error,
    _is_transient_codex_error,
    _http_status_from_any,
    _http_status_from_error_text,
    _latest_turn_identity,
    _looks_like_upstream_overload,
    _parse_structured_result,
    _sanitized_sdk_reason,
    _string_attr,
    _timeout_seconds,
    _usage_from_any,
)
from .codex_config import CodexConfig


@dataclass(frozen=True)
class CodexTurnResult:
    thread_id: str
    structured_result: dict[str, Any]
    events: list[dict[str, Any]]


EventCallback = Callable[[dict[str, Any]], None]

_OVERLOAD_INITIAL_DELAY_MS = 250
_OVERLOAD_MAX_DELAY_MS = 8_000


class CodexSdkClient:
    def __init__(
        self,
        config: CodexConfig,
        *,
        sdk_factory: Any | None = None,
        sdk_types: Any | None = None,
    ):
        self.config = config
        self.sdk_factory = sdk_factory
        self.sdk_types = sdk_types

    async def run_session(
        self,
        workspace_path: Path,
        prompt: str,
        *,
        existing_thread_id: str | None = None,
        output_schema: dict[str, Any],
    ) -> CodexTurnResult:
        if not workspace_path.exists() or not workspace_path.is_dir():
            raise CodexError("invalid_workspace_cwd", f"Workspace path is not a directory: {workspace_path}")
        events: list[dict[str, Any]] = []
        emit = events.append
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
        try:
            turn_id, session_id, final_response, structured = await self._run_structured_turn(
                thread,
                prompt,
                output_schema,
                thread_id=thread_id,
                emit=emit,
                events=events,
            )
        finally:
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
            thread_id=thread_id,
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
    ) -> tuple[str, str, str | None, dict[str, Any]]:
        turn_id = "turn"
        session_id = f"{thread_id}-{turn_id}"
        turn_prompt = prompt
        for attempt in range(1, 3):
            try:
                turn_id, session_id, final_response = await self._run_turn_with_timeout(
                    thread,
                    turn_prompt,
                    output_schema,
                    thread_id=thread_id,
                    emit=emit,
                )
                structured = _parse_structured_result(final_response)
                if structured is None:
                    raise CodexError("invalid_structured_output", "Codex SDK turn did not produce the required structured JSON result")
                return turn_id, session_id, final_response, structured
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
                        "timeout_ms": self.config.turn_timeout_ms,
                    }
                )
                raise CodexError(
                    "timeout",
                    f"Codex SDK turn exceeded turn_timeout_ms={self.config.turn_timeout_ms}",
                ) from exc
            except Exception as exc:
                classified = _classify_sdk_exception(exc)
                code = classified.code
                if isinstance(exc, CodexError) and code != "invalid_structured_output":
                    raise
                if code != "invalid_structured_output" or attempt >= 2:
                    if isinstance(exc, CodexError):
                        raise
                    raise CodexError(
                        code,
                        _sanitized_sdk_reason(exc, classified),
                        http_status=classified.http_status,
                    ) from exc
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
    ) -> tuple[str, str, str | None]:
        return await asyncio.wait_for(
            self._run_turn(thread, prompt, output_schema, thread_id=thread_id, emit=emit),
            timeout=_timeout_seconds(self.config.turn_timeout_ms),
        )

    async def _run_turn(
        self,
        thread: Any,
        prompt: str,
        output_schema: dict[str, Any],
        *,
        thread_id: str,
        emit: EventCallback,
    ) -> tuple[str, str, str | None]:
        async def op() -> tuple[str, str, str | None]:
            turn = await self._start_sdk_turn(thread, prompt, output_schema)
            turn_id = _string_attr(turn, "id") or "turn"
            session_id = f"{thread_id}-{turn_id}"
            emit({"event": "turn_started", "backend": "sdk", "thread_id": thread_id, "turn_id": turn_id, "session_id": session_id})
            final_response = await self._consume_turn(turn, emit)
            return turn_id, session_id, final_response

        return await self._retry_overload(op, emit=emit)

    async def _init_thread(
        self,
        workspace_path: Path,
        existing_thread_id: str | None,
        *,
        emit: EventCallback,
    ) -> tuple[Any, Any, str]:
        attempts = max(1, self.config.initialize_max_attempts)
        last_code = "sdk_transport_error"
        last_message = ""
        for attempt in range(1, attempts + 1):
            self._emit_init_start(emit, workspace_path, existing_thread_id, attempt)
            try:
                return await self._init_thread_once(workspace_path, existing_thread_id, attempt, emit=emit)
            except (asyncio.TimeoutError, TimeoutError) as exc:
                last_code, last_message = await self._handle_init_timeout(exc, attempt, attempts, emit=emit)
            except Exception as exc:
                last_code, last_message = await self._handle_init_exception(exc, attempt, attempts, emit=emit)
        raise CodexError("codex_init_failed", f"{last_code}: {last_message}")

    def _emit_init_start(
        self,
        emit: EventCallback,
        workspace_path: Path,
        existing_thread_id: str | None,
        attempt: int,
    ) -> None:
        emit(
            {
                "event": "codex_init_starting",
                "backend": "sdk",
                "cwd": str(workspace_path),
                "existing_thread_id": existing_thread_id,
                "attempt": attempt,
            }
        )

    async def _init_thread_once(
        self,
        workspace_path: Path,
        existing_thread_id: str | None,
        attempt: int,
        *,
        emit: EventCallback,
    ) -> tuple[Any, Any, str]:
        client, thread = await asyncio.wait_for(
            self._retry_overload(
                lambda: self._client_and_thread(workspace_path, existing_thread_id, emit=emit),
                emit=emit,
            ),
            timeout=_timeout_seconds(self.config.initialize_timeout_ms),
        )
        thread_id = _string_attr(thread, "id") or existing_thread_id
        if not thread_id:
            raise CodexError("response_error", "Codex SDK thread did not include an id")
        emit({"event": "codex_init_succeeded", "backend": "sdk", "attempts": attempt, "thread_id": thread_id})
        return client, thread, thread_id

    async def _handle_init_timeout(
        self,
        exc: BaseException,
        attempt: int,
        attempts: int,
        *,
        emit: EventCallback,
    ) -> tuple[str, str]:
        code = "timeout"
        message = (
            "Codex SDK init exceeded "
            f"initialize_timeout_ms={self.config.initialize_timeout_ms}"
        )
        if attempt >= attempts:
            emit({"event": "codex_init_failed", "backend": "sdk", "attempts": attempt, "message": code})
            raise CodexError("codex_init_failed", f"{code}: {message}") from exc
        await self._sleep_before_init_retry(attempt, code, emit=emit)
        return code, message

    async def _handle_init_exception(
        self,
        exc: Exception,
        attempt: int,
        attempts: int,
        *,
        emit: EventCallback,
    ) -> tuple[str, str]:
        classified = _classify_sdk_exception(exc)
        code = classified.code
        reason = _sanitized_sdk_reason(exc, classified)
        if _is_terminal_init_error(code):
            emit({"event": "codex_init_failed", "backend": "sdk", "attempts": attempt, "message": code})
            raise CodexError(code, reason, http_status=classified.http_status) from exc
        if attempt >= attempts or not _is_transient_codex_error(code):
            emit({"event": "codex_init_failed", "backend": "sdk", "attempts": attempt, "message": code})
            raise CodexError(
                "codex_init_failed",
                f"{code}: {reason}",
                http_status=classified.http_status,
            ) from exc
        await self._sleep_before_init_retry(attempt, code, emit=emit)
        return code, reason

    async def _sleep_before_init_retry(self, attempt: int, code: str, *, emit: EventCallback) -> None:
        delay_ms = _init_backoff_ms(attempt)
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

    async def _retry_overload(self, op: Callable[[], Any], *, emit: EventCallback) -> Any:
        attempts = max(1, self.config.overload_max_attempts)
        delay_ms = _OVERLOAD_INITIAL_DELAY_MS
        max_delay_ms = _OVERLOAD_MAX_DELAY_MS
        for attempt in range(1, attempts + 1):
            try:
                return await op()
            except Exception as exc:
                classified = _classify_sdk_exception(exc)
                reason = _sanitized_sdk_reason(exc, classified)
                if classified.code == "codex_bad_request":
                    self._emit_terminal_request_failure(exc, classified, emit)
                if classified.code != "upstream_overloaded":
                    raise
                if attempt >= attempts:
                    emit(
                        {
                            "event": "codex_overload_exhausted",
                            "backend": "sdk",
                            "attempts": attempt,
                            "http_status": classified.http_status,
                            "message": reason,
                        }
                    )
                    raise CodexError(
                        "upstream_overloaded_exhausted",
                        reason,
                        http_status=classified.http_status,
                    ) from exc
                current_delay_ms = min(delay_ms, max_delay_ms)
                emit(
                    {
                        "event": "codex_overload_retrying",
                        "backend": "sdk",
                        "attempt": attempt + 1,
                        "delay_ms": current_delay_ms,
                        "http_status": classified.http_status,
                        "message": reason,
                    }
                )
                await asyncio.sleep(current_delay_ms / 1000)
                delay_ms = min(max_delay_ms, delay_ms * 2)

    def _emit_terminal_request_failure(self, exc: Exception, classified: Any, emit: EventCallback) -> None:
        reason = _sanitized_sdk_reason(exc, classified)
        emit(
            {
                "event": "codex_request_failed_terminal",
                "backend": "sdk",
                "code": classified.code,
                "http_status": classified.http_status,
                "message": reason,
            }
        )
        raise CodexError(
            classified.code,
            reason,
            http_status=classified.http_status,
        ) from exc

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
        if self.config.sdk_codex_bin and not os.access(self.config.sdk_codex_bin, os.X_OK):
            raise CodexError("invalid_sdk_codex_bin", f"Codex binary is not executable: {self.config.sdk_codex_bin}")
        factory = self.sdk_factory or _default_sdk_factory
        client = factory(self.config)
        if inspect.isawaitable(client):
            client = await client
        return client

    def _sdk_config(self, sdk_config_cls: Any) -> Any:
        sdk_env = _codex_sdk_env()
        return sdk_config_cls(
            codex_bin=self.config.sdk_codex_bin,
            env=sdk_env,
        )

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
                resume_kwargs = {
                    key: value for key, value in kwargs.items() if key != "ephemeral"
                }
                return await resume(existing_thread_id, **resume_kwargs)
            except Exception as exc:
                if emit is not None:
                    classified = _classify_sdk_exception(exc)
                    emit(
                        {
                            "event": "thread_resume_failed",
                            "backend": "sdk",
                            "thread_id": existing_thread_id,
                            "cwd": str(workspace_path),
                            "message": _sanitized_sdk_reason(exc, classified),
                        }
                    )
        start = getattr(client, "thread_start", None)
        if not callable(start):
            raise CodexError("sdk_missing_thread_start", "Codex SDK client does not support thread_start")
        return await start(**kwargs)

    def _thread_kwargs(self, workspace_path: Path) -> dict[str, Any]:
        sdk_types = self.sdk_types or _default_sdk_types()

        return {
            "approval_mode": sdk_types.ApprovalMode(self.config.approval_mode),
            "cwd": str(workspace_path),
            "ephemeral": True,
            "model": self.config.model,
            "model_provider": self.config.model_provider,
            "sandbox": sdk_types.Sandbox(self.config.sandbox.replace("_", "-")),
        }

    async def _start_sdk_turn(self, thread: Any, prompt: str, output_schema: dict[str, Any]) -> Any:
        turn = getattr(thread, "turn", None)
        if callable(turn):
            sdk_types = self.sdk_types or _default_sdk_types()

            return await turn(
                prompt,
                approval_mode=sdk_types.ApprovalMode(self.config.approval_mode),
                effort=sdk_types.ReasoningEffort(self.config.reasoning_effort),
                summary=sdk_types.ReasoningSummary.model_validate(
                    self.config.reasoning_summary
                ),
                sandbox=sdk_types.Sandbox(self.config.sandbox.replace("_", "-")),
                output_schema=output_schema,
            )
        raise CodexError("sdk_missing_turn", "Codex SDK thread does not support turn")

    async def _consume_turn(self, turn: Any, emit: EventCallback) -> str | None:
        stream = getattr(turn, "stream", None)
        if callable(stream):
            return await self._consume_turn_stream(stream, emit)
        raise CodexError("sdk_missing_stream", "Codex SDK turn does not support stream")

    async def _consume_turn_stream(
        self,
        stream: Callable[[], Any],
        emit: EventCallback,
    ) -> str | None:
        final_response: str | None = None
        fallback_response: str | None = None
        terminal_error: CodexError | None = None
        async for event in stream():
            mapped = _sdk_event_to_dict(event)
            if mapped:
                emit(mapped)
            event_error = _terminal_sdk_error(event)
            if event_error is not None:
                terminal_error = event_error
            usage = _usage_from_any(_event_payload(event))
            if usage is not None:
                emit({"event": "thread_token_usage_updated", "backend": "sdk", "usage": usage, **usage})
            response, is_final = _notification_response(event)
            if response:
                if is_final:
                    final_response = response
                elif fallback_response is None:
                    fallback_response = response
        if terminal_error is not None:
            raise terminal_error
        return final_response or fallback_response


def _default_sdk_factory(config: CodexConfig) -> Any:
    from .backends.codex import create_codex_sdk_client

    return create_codex_sdk_client(config)


def _default_sdk_types() -> Any:
    from .backends.codex import codex_sdk_types

    return codex_sdk_types()


def _terminal_sdk_error(event: Any) -> CodexError | None:
    """Turn the SDK's terminal error notification into an actionable failure.

    The app-server retries transient upstream failures inside the stream and
    emits a final ``error`` notification when those retries are exhausted. A
    missing agent message after that notification is not a structured-output
    problem, so preserve the transport failure instead of misclassifying it.
    """

    payload = _event_payload(event)
    event_type = str(payload.get("type") or getattr(event, "method", "") or "")
    if event_type != "error" or bool(payload.get("willRetry")):
        return None
    error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
    error_text = json.dumps(error, sort_keys=True, default=str)
    http_status = _http_status_from_any(error) or _http_status_from_error_text(error_text)
    if http_status in {429, 500, 502, 503, 504}:
        return CodexError(
            "upstream_overloaded_exhausted",
            f"Codex upstream returned HTTP {http_status} after SDK retries",
            http_status=http_status,
        )
    if _looks_like_upstream_overload(error_text):
        return CodexError("upstream_overloaded_exhausted", "Codex upstream failed after SDK retries", http_status=http_status)
    if re.search(r"(?i)unauthori[sz]ed|authentication|invalid[_ -]?token|login required", error_text):
        return CodexError("codex_auth_failed", "Codex authentication failed", http_status=http_status)
    if re.search(r"(?i)invalid[_ -]?(?:json[_ -]?)?schema|invalid_request_error|response_format", error_text):
        return CodexError("codex_bad_request", "Codex rejected the structured output schema", http_status=http_status)
    return CodexError("codex_sdk_error", "Codex SDK reported an unrecoverable turn error", http_status=http_status)


def _sdk_event_to_dict(event: Any) -> dict[str, Any] | None:
    name = getattr(event, "method", None)
    if not isinstance(name, str):
        return None
    payload = {**_event_payload(event), "type": name}
    mapped = {
        "event": f"sdk_{name.replace('.', '_').replace('/', '_')}",
        "backend": "sdk",
        "payload": payload,
    }
    for key in ("message", "command", "exit_code", "usage", "turn_id", "thread_id"):
        if key in payload:
            mapped[key] = payload[key]
    return mapped


def _event_payload(event: Any) -> dict[str, Any]:
    raw = getattr(event, "payload", None)
    params = getattr(raw, "params", None)
    if isinstance(params, dict):
        return params
    model_dump = getattr(raw, "model_dump", None)
    if callable(model_dump):
        try:
            dumped = model_dump(by_alias=True, mode="json")
        except TypeError:
            dumped = model_dump(by_alias=True)
        if isinstance(dumped, dict):
            return dumped
    return {}


def _notification_response(event: Any) -> tuple[str | None, bool]:
    payload = _event_payload(event)
    item = payload.get("item") if isinstance(payload.get("item"), dict) else {}
    if str(item.get("type") or "") != "agentMessage":
        return None, False
    text = str(item.get("text") or "").strip()
    if not text:
        return None, False
    phase = item.get("phase")
    phase_value = getattr(phase, "value", phase)
    return text, str(phase_value or "") == "final_answer"
