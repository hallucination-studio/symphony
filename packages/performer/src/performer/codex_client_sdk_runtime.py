from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any, Callable

from .codex_client_helpers import (
    CodexError,
    _ThreadRunAdapter,
    _callable_accepts_keyword,
    _classify_sdk_exception,
    _codex_sdk_env,
    _first_dict,
    _first_string,
    _init_backoff_ms,
    _is_terminal_init_error,
    _is_transient_codex_error,
    _maybe_await,
    _sdk_event_to_dict,
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
                return await _maybe_await(op())
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
        return AsyncCodex(config=self._sdk_config(SdkCodexConfig))

    def _sdk_config(self, sdk_config_cls: Any) -> Any | None:
        sdk_env = _codex_sdk_env()
        if not (self.config.sdk_codex_bin or sdk_env or self.config.config_overrides):
            return None
        sdk_kwargs: dict[str, Any] = {"codex_bin": self.config.sdk_codex_bin}
        if sdk_env and _callable_accepts_keyword(sdk_config_cls, "env"):
            sdk_kwargs["env"] = sdk_env
        if self.config.config_overrides and _callable_accepts_keyword(sdk_config_cls, "config_overrides"):
            sdk_kwargs["config_overrides"] = tuple(self.config.config_overrides)
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
                return await _maybe_await(resume(existing_thread_id, **kwargs))
            except Exception as exc:
                if emit is not None:
                    emit({"event": "thread_resume_failed", "backend": "sdk", "thread_id": existing_thread_id, "cwd": str(workspace_path), "message": str(exc)})
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
        emit: Callable[[dict[str, Any]], None],
        *,
        validate_structured: bool,
    ) -> tuple[str | None, dict[str, Any] | None]:
        stream = getattr(turn, "stream", None)
        if callable(stream):
            return await self._consume_turn_stream(stream, emit, validate_structured=validate_structured)
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

    async def _consume_turn_stream(
        self,
        stream: Callable[[], Any],
        emit: Callable[[dict[str, Any]], None],
        *,
        validate_structured: bool,
    ) -> tuple[str | None, dict[str, Any] | None]:
        from .codex_client_helpers import _aiter

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
