from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
import logging

from performer_api.config import CodexConfig

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
        _ = title, max_turns, continuation_provider
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
        client = await self._client()
        thread = await self._thread(client, workspace_path, existing_thread_id)
        thread_id = _string_attr(thread, "id") or existing_thread_id
        if not thread_id:
            raise CodexError("response_error", "Codex SDK thread did not include an id")
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
        turn = await self._start_sdk_turn(thread, prompt, schema)
        turn_id = _string_attr(turn, "id")
        if turn_id is None:
            turn_id = "turn"
        session_id = f"{thread_id}-{turn_id}"
        emit({"event": "turn_started", "backend": "sdk", "thread_id": thread_id, "turn_id": turn_id, "session_id": session_id})
        requires_handoff = output_schema is None
        final_response, structured = await self._consume_turn(turn, emit, validate_structured=requires_handoff)
        if requires_handoff and structured is None:
            structured = _parse_structured_result(final_response)
        if requires_handoff and structured is None:
            emit({"event": "turn_failed", "backend": "sdk", "thread_id": thread_id, "turn_id": turn_id, "session_id": session_id, "message": "invalid_structured_output"})
            raise CodexError("invalid_structured_output", "Codex SDK turn did not produce the required structured JSON result")
        emit({"event": "turn_completed", "backend": "sdk", "thread_id": thread_id, "turn_id": turn_id, "session_id": session_id, "message": final_response})
        return CodexRunResult(
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

    async def _client(self) -> Any:
        if self.sdk_factory is not None:
            client = self.sdk_factory(self.config)
            if hasattr(client, "__await__"):
                client = await client
            return client
        try:
            from openai_codex import AsyncCodex  # type: ignore
            from openai_codex import CodexConfig as SdkCodexConfig  # type: ignore
        except ImportError as exc:
            raise CodexError("codex_sdk_not_installed", "Install openai-codex to use codex.backend=sdk") from exc
        sdk_config = SdkCodexConfig(codex_bin=self.config.sdk_codex_bin) if self.config.sdk_codex_bin else None
        return AsyncCodex(config=sdk_config)

    async def _thread(self, client: Any, workspace_path: Path, existing_thread_id: str | None) -> Any:
        kwargs = self._thread_kwargs(workspace_path)
        if existing_thread_id:
            resume = getattr(client, "thread_resume", None)
            if not callable(resume):
                raise CodexError("sdk_missing_thread_resume", "Codex SDK client does not support thread_resume")
            return await _maybe_await(resume(existing_thread_id, **kwargs))
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


def _parse_structured_result(value: str | None) -> dict[str, Any] | None:
    if not value:
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if _valid_structured_result(parsed) else None


def _valid_structured_result(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    if value.get("next_action") not in {"ready_for_review", "needs_human", "blocked"}:
        return False
    if not isinstance(value.get("summary"), str):
        return False
    for key in ("test_commands", "changed_files", "remaining_risks"):
        raw = value.get(key)
        if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
            return False
    return True


async def _maybe_await(value: Any) -> Any:
    if hasattr(value, "__await__"):
        return await value
    return value


async def _aiter(value: Any) -> Any:
    iterator = await _maybe_await(value)
    async for item in iterator:
        yield item


def _string_attr(value: Any, name: str) -> str | None:
    if isinstance(value, dict):
        raw = value.get(name)
    else:
        raw = getattr(value, name, None)
    return raw if isinstance(raw, str) and raw else None


def _first_string(value: Any, *names: str, default: str | None = None) -> str | None:
    for name in names:
        raw = value.get(name) if isinstance(value, dict) else getattr(value, name, None)
        if isinstance(raw, str) and raw:
            return raw
    return default


def _first_dict(
    value: Any,
    *names: str,
    default: dict[str, Any] | None = None,
    validate: bool = True,
) -> dict[str, Any] | None:
    for name in names:
        raw = value.get(name) if isinstance(value, dict) else getattr(value, name, None)
        if isinstance(raw, dict) and (not validate or _valid_structured_result(raw)):
            return raw
    return default


def _sdk_event_to_dict(event: Any) -> dict[str, Any] | None:
    if isinstance(event, dict):
        raw = dict(event)
    else:
        raw = {
            key: getattr(event, key)
            for key in ("type", "event", "message", "command", "exit_code", "usage", "turn_id", "thread_id")
            if hasattr(event, key)
        }
    name = raw.get("event") or raw.get("type")
    if not isinstance(name, str):
        return None
    mapped = {"event": f"sdk_{name.replace('.', '_').replace('/', '_')}", "backend": "sdk", "payload": raw}
    for key in ("message", "command", "exit_code", "usage", "turn_id", "thread_id"):
        if key in raw:
            mapped[key] = raw[key]
    return mapped


def _usage_from_any(value: Any) -> dict[str, int] | None:
    raw: Any = None
    if isinstance(value, dict):
        for key in ("usage", "token_usage", "tokenUsage", "total_token_usage", "totalTokenUsage"):
            candidate = value.get(key)
            if isinstance(candidate, dict):
                raw = candidate
                break
    else:
        for key in ("usage", "token_usage", "tokenUsage", "total_token_usage", "totalTokenUsage"):
            candidate = getattr(value, key, None)
            if isinstance(candidate, dict):
                raw = candidate
                break
    if not isinstance(raw, dict):
        return None
    usage = {
        "input_tokens": _int_from_keys(raw, "input_tokens", "inputTokens", "input"),
        "output_tokens": _int_from_keys(raw, "output_tokens", "outputTokens", "output"),
        "cached_tokens": _int_from_keys(raw, "cached_tokens", "cachedTokens", "cached"),
        "total_tokens": _int_from_keys(raw, "total_tokens", "totalTokens", "total"),
    }
    if usage["total_tokens"] == 0:
        usage["total_tokens"] = usage["input_tokens"] + usage["output_tokens"]
    return usage if any(usage.values()) else None


def _int_from_keys(values: dict[str, Any], *keys: str) -> int:
    for key in keys:
        value = values.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.strip().isdigit():
            return int(value.strip())
    return 0


class _ThreadRunAdapter:
    id = "turn"

    def __init__(self, thread: Any, output_schema: dict[str, Any], prompt: str):
        self.thread = thread
        self.output_schema = output_schema
        self.prompt = prompt

    async def run(self) -> Any:
        run = getattr(self.thread, "run")
        try:
            result = await _maybe_await(run(self.prompt, output_schema=self.output_schema))
        except TypeError:
            result = await _maybe_await(run(self.prompt))
        nested_run = getattr(result, "run", None)
        if callable(nested_run):
            return await _maybe_await(nested_run())
        return result
