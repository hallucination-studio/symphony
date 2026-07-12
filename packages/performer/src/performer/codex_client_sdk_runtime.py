from __future__ import annotations

import asyncio
import inspect
import os
from pathlib import Path
from typing import Any, Callable

from .codex_client_helpers import (
    CodexError,
    _classify_sdk_exception,
    _codex_sdk_env,
    _first_dict,
    _first_string,
    _init_backoff_ms,
    _is_terminal_init_error,
    _is_transient_codex_error,
    _string_attr,
    _timeout_seconds,
    _usage_from_any,
)


class _CodexSdkRuntimeMixin:
    async def _init_thread(
        self,
        workspace_path: Path,
        existing_thread_id: str | None,
        *,
        emit: Callable[[dict[str, Any]], None],
    ) -> tuple[Any, Any, str]:
        attempts = max(1, self.config.init_max_attempts)
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
        emit: Callable[[dict[str, Any]], None],
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
        emit: Callable[[dict[str, Any]], None],
    ) -> tuple[Any, Any, str]:
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
        emit({"event": "codex_init_succeeded", "backend": "sdk", "attempts": attempt, "thread_id": thread_id})
        return client, thread, thread_id

    async def _handle_init_timeout(
        self,
        exc: BaseException,
        attempt: int,
        attempts: int,
        *,
        emit: Callable[[dict[str, Any]], None],
    ) -> tuple[str, str]:
        code = "timeout"
        message = f"Codex SDK init exceeded read_timeout_ms={self.config.read_timeout_ms}"
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
        emit: Callable[[dict[str, Any]], None],
    ) -> tuple[str, str]:
        classified = _classify_sdk_exception(exc)
        code = classified.code
        if _is_terminal_init_error(code):
            emit({"event": "codex_init_failed", "backend": "sdk", "attempts": attempt, "message": code})
            if isinstance(exc, CodexError):
                raise exc
            raise CodexError(code, str(exc), http_status=classified.http_status) from exc
        if attempt >= attempts or not _is_transient_codex_error(code):
            emit({"event": "codex_init_failed", "backend": "sdk", "attempts": attempt, "message": code})
            raise CodexError("codex_init_failed", f"{code}: {exc}", http_status=classified.http_status) from exc
        await self._sleep_before_init_retry(attempt, code, emit=emit)
        return code, str(exc)

    async def _sleep_before_init_retry(
        self,
        attempt: int,
        code: str,
        *,
        emit: Callable[[dict[str, Any]], None],
    ) -> None:
        delay_ms = _init_backoff_ms(self.config, attempt)
        emit({"event": "codex_init_retrying", "backend": "sdk", "attempt": attempt + 1, "delay_ms": delay_ms, "message": code})
        await asyncio.sleep(delay_ms / 1000)

    async def _retry_overload(self, op: Callable[[], Any], *, emit: Callable[[dict[str, Any]], None]) -> Any:
        attempts = max(1, self.config.overload_max_attempts)
        delay_ms = max(1, self.config.overload_initial_delay_ms)
        max_delay_ms = max(1, self.config.overload_max_delay_ms)
        for attempt in range(1, attempts + 1):
            try:
                return await op()
            except Exception as exc:
                classified = _classify_sdk_exception(exc)
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

    def _emit_terminal_request_failure(self, exc: Exception, classified: Any, emit: Callable[[dict[str, Any]], None]) -> None:
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

    async def _client_and_thread(
        self,
        workspace_path: Path,
        existing_thread_id: str | None,
        *,
        emit: Callable[[dict[str, Any]], None],
    ) -> tuple[Any, Any]:
        client = await self._client()
        thread = await self._thread(client, workspace_path, existing_thread_id, emit=emit)
        return client, thread

    async def _client(self) -> Any:
        if self.sdk_factory is not None:
            client = self.sdk_factory(self.config)
            if inspect.isawaitable(client):
                client = await client
            return client
        if self.config.sdk_codex_bin and not os.access(self.config.sdk_codex_bin, os.X_OK):
            raise CodexError("invalid_sdk_codex_bin", f"Codex binary is not executable: {self.config.sdk_codex_bin}")
        try:
            from openai_codex import AsyncCodex  # type: ignore
            from openai_codex import CodexConfig as SdkCodexConfig  # type: ignore
        except ImportError as exc:
            raise CodexError("codex_sdk_not_installed", "Install openai-codex to run Performer Codex turns") from exc
        return AsyncCodex(config=self._sdk_config(SdkCodexConfig))

    def _sdk_config(self, sdk_config_cls: Any) -> Any | None:
        sdk_env = _codex_sdk_env()
        if not (self.config.sdk_codex_bin or sdk_env or self.config.config_overrides):
            return None
        sdk_kwargs: dict[str, Any] = {
            "codex_bin": self.config.sdk_codex_bin,
            "env": sdk_env or None,
            "config_overrides": tuple(self.config.config_overrides),
        }
        return sdk_config_cls(**sdk_kwargs)

    async def _thread(
        self,
        client: Any,
        workspace_path: Path,
        existing_thread_id: str | None,
        *,
        emit: Callable[[dict[str, Any]], None] | None = None,
    ) -> Any:
        kwargs = self._thread_kwargs(workspace_path)
        if existing_thread_id:
            resume = getattr(client, "thread_resume", None)
            if not callable(resume):
                raise CodexError("sdk_missing_thread_resume", "Codex SDK client does not support thread_resume")
            try:
                return await resume(existing_thread_id, **kwargs)
            except Exception as exc:
                if emit is not None:
                    emit({"event": "thread_resume_failed", "backend": "sdk", "thread_id": existing_thread_id, "cwd": str(workspace_path), "message": str(exc)})
        start = getattr(client, "thread_start", None)
        if not callable(start):
            raise CodexError("sdk_missing_thread_start", "Codex SDK client does not support thread_start")
        return await start(**kwargs)

    def _thread_kwargs(self, workspace_path: Path) -> dict[str, Any]:
        kwargs: dict[str, Any] = {"cwd": str(workspace_path)}
        if self.config.model:
            kwargs["model"] = self.config.model
        if self.config.sandbox:
            kwargs["sandbox"] = self.config.sandbox
        return kwargs

    async def _start_sdk_turn(self, thread: Any, prompt: str, output_schema: dict[str, Any]) -> Any:
        turn = getattr(thread, "turn", None)
        if callable(turn):
            return await turn(prompt, output_schema=output_schema)
        raise CodexError("sdk_missing_turn", "Codex SDK thread does not support turn")

    async def _consume_turn(
        self,
        turn: Any,
        emit: Callable[[dict[str, Any]], None],
    ) -> tuple[str | None, dict[str, Any] | None]:
        stream = getattr(turn, "stream", None)
        if callable(stream):
            return await self._consume_turn_stream(stream, emit)
        raise CodexError("sdk_missing_stream", "Codex SDK turn does not support stream")

    async def _consume_turn_stream(
        self,
        stream: Callable[[], Any],
        emit: Callable[[dict[str, Any]], None],
    ) -> tuple[str | None, dict[str, Any] | None]:
        final_response: str | None = None
        fallback_response: str | None = None
        structured: dict[str, Any] | None = None
        async for event in stream():
            mapped = _sdk_event_to_dict(event)
            if mapped:
                emit(mapped)
            usage = _usage_from_any(_event_payload(event)) or _usage_from_any(event)
            if usage is not None:
                emit({"event": "thread_token_usage_updated", "backend": "sdk", "usage": usage, **usage})
            response, is_final = _notification_response(event)
            if response:
                if is_final:
                    final_response = response
                elif fallback_response is None:
                    fallback_response = response
            payload = _event_payload(event)
            structured = _first_dict(event, "structured_result", "output", "parsed", default=structured)
            structured = _first_dict(payload, "structured_result", "output", "parsed", default=structured)
        return final_response or fallback_response, structured


def _sdk_event_to_dict(event: Any) -> dict[str, Any] | None:
    raw = event if isinstance(event, dict) else _event_model_dict(event)
    name = raw.get("event") or raw.get("type") or raw.get("method")
    if not isinstance(name, str):
        return None
    params = raw.get("params") if isinstance(raw.get("params"), dict) else _event_payload(event)
    if not params:
        params = raw
    payload = {**params, "type": name}
    mapped = {"event": f"sdk_{name.replace('.', '_').replace('/', '_')}", "backend": "sdk", "payload": payload}
    for key in ("message", "command", "exit_code", "usage", "turn_id", "thread_id"):
        if key in payload:
            mapped[key] = payload[key]
    return mapped


def _event_model_dict(event: Any) -> dict[str, Any]:
    model_dump = getattr(event, "model_dump", None)
    if callable(model_dump):
        dumped = model_dump(by_alias=True)
        if isinstance(dumped, dict):
            return dumped
    values = {
        key: getattr(event, key)
        for key in ("method", "params", "type", "event", "message", "command", "exit_code", "usage", "turn_id", "thread_id")
        if hasattr(event, key)
    }
    payload = _event_payload(event)
    if payload:
        values["payload"] = payload
    return values


def _event_payload(event: Any) -> dict[str, Any]:
    raw = event.get("payload") if isinstance(event, dict) else getattr(event, "payload", None)
    if isinstance(raw, dict):
        return raw
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
    raw = _event_model_dict(event)
    direct = _first_string(raw, "final_response", "response", "text")
    if direct:
        return direct, True
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
