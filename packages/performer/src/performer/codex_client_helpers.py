from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .codex_config import CodexConfig

logger = logging.getLogger(__name__)

try:
    from openai_codex.errors import (  # type: ignore
        InvalidParamsError as SdkInvalidParamsError,
        InvalidRequestError as SdkInvalidRequestError,
        MethodNotFoundError as SdkMethodNotFoundError,
        ParseError as SdkParseError,
        RetryLimitExceededError as SdkRetryLimitExceededError,
        ServerBusyError as SdkServerBusyError,
        TransportClosedError as SdkTransportClosedError,
        is_retryable_error as sdk_is_retryable_error,
    )
except ImportError:
    SdkInvalidParamsError = None
    SdkInvalidRequestError = None
    SdkMethodNotFoundError = None
    SdkParseError = None
    SdkRetryLimitExceededError = None
    SdkServerBusyError = None
    SdkTransportClosedError = None
    sdk_is_retryable_error = None


class CodexError(Exception):
    def __init__(self, code: str, message: str, *, http_status: int | None = None):
        super().__init__(message)
        self.code = code
        self.http_status = http_status


@dataclass(frozen=True)
class _SdkErrorClassification:
    code: str
    http_status: int | None = None


def _parse_structured_result(value: str | None) -> dict[str, Any] | None:
    if not value:
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    return parsed


def _is_transient_codex_error(code: str) -> bool:
    return code in {
        "invalid_structured_output",
        "sdk_transport_error",
        "response_error",
        "rate_limit",
        "timeout",
        "connection_error",
        "upstream_overloaded",
        "upstream_overloaded_exhausted",
    }


def _is_terminal_init_error(code: str) -> bool:
    return code in {
        "codex_sdk_not_installed",
        "invalid_sdk_codex_bin",
        "invalid_workspace_cwd",
        "sdk_missing_thread_start",
        "sdk_missing_thread_resume",
    }


def _classify_sdk_exception(exc: BaseException) -> _SdkErrorClassification:
    if isinstance(exc, CodexError):
        return _SdkErrorClassification(exc.code, exc.http_status)
    http_status = _sdk_http_status(exc)
    inferred_http_status = http_status or _http_status_from_error_text(str(exc))
    if inferred_http_status in {429, 500, 502, 503, 504} or _looks_like_upstream_overload(str(exc)):
        return _SdkErrorClassification("upstream_overloaded", inferred_http_status)
    if _is_instance(exc, SdkRetryLimitExceededError):
        return _SdkErrorClassification("upstream_overloaded", inferred_http_status)
    if _is_instance(exc, SdkServerBusyError):
        return _SdkErrorClassification("upstream_overloaded", inferred_http_status)
    if (
        _is_instance(exc, SdkInvalidParamsError)
        or _is_instance(exc, SdkInvalidRequestError)
        or _is_instance(exc, SdkMethodNotFoundError)
        or _is_instance(exc, SdkParseError)
    ):
        return _SdkErrorClassification("codex_bad_request", inferred_http_status)
    if _is_instance(exc, SdkTransportClosedError):
        return _SdkErrorClassification("sdk_transport_error", inferred_http_status)
    if sdk_is_retryable_error is not None:
        try:
            if sdk_is_retryable_error(exc):
                return _SdkErrorClassification("upstream_overloaded", inferred_http_status)
        except Exception:
            pass
    return _SdkErrorClassification("sdk_transport_error", inferred_http_status)


def _is_instance(value: BaseException, class_obj: Any) -> bool:
    return class_obj is not None and isinstance(value, class_obj)


def _sdk_http_status(exc: BaseException) -> int | None:
    data = getattr(exc, "data", None)
    return _http_status_from_any(data)


def _http_status_from_any(value: Any) -> int | None:
    if isinstance(value, dict):
        for key in ("httpStatusCode", "http_status", "status", "statusCode"):
            parsed = _optional_int(value.get(key))
            if parsed is not None:
                return parsed
        for nested in value.values():
            parsed = _http_status_from_any(nested)
            if parsed is not None:
                return parsed
    if isinstance(value, list):
        for nested in value:
            parsed = _http_status_from_any(nested)
            if parsed is not None:
                return parsed
    return None


def _http_status_from_error_text(value: str) -> int | None:
    match = re.search(r"\b(429|500|502|503|504)\b", value)
    return int(match.group(1)) if match else None


def _looks_like_upstream_overload(value: str) -> bool:
    lowered = value.lower()
    return any(
        marker in lowered
        for marker in (
            "bad gateway",
            "upstream request failed",
            "server overloaded",
            "upstream overloaded",
            "temporarily unavailable",
            "gateway timeout",
        )
    )


def _optional_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _init_backoff_ms(config: CodexConfig, completed_failures: int) -> int:
    base = max(1, config.init_backoff_ms)
    cap = max(1, config.init_backoff_max_ms)
    return min(base * (2 ** (completed_failures - 1)), cap)


def _codex_sdk_env() -> dict[str, str]:
    env: dict[str, str] = {}
    home = os.environ.get("HOME")
    codex_home = os.environ.get("CODEX_HOME")
    if home:
        env["HOME"] = home
    if codex_home:
        env["CODEX_HOME"] = codex_home
    return env


def _timeout_seconds(timeout_ms: int) -> float | None:
    if timeout_ms <= 0:
        return None
    return timeout_ms / 1000


def _latest_turn_identity(
    events: list[dict[str, Any]],
    *,
    thread_id: str,
    default_turn_id: str,
    default_session_id: str,
) -> tuple[str, str]:
    for event in reversed(events):
        if event.get("event") != "turn_started":
            continue
        if event.get("thread_id") != thread_id:
            continue
        turn_id = event.get("turn_id")
        session_id = event.get("session_id")
        if isinstance(turn_id, str) and isinstance(session_id, str):
            return turn_id, session_id
    return default_turn_id, default_session_id


async def _close_sdk_client(client: Any) -> None:
    close = getattr(client, "close", None)
    if not callable(close):
        return
    try:
        await close()
    except Exception as exc:
        logger.debug("codex_sdk_close_failed reason=%s", exc)


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
