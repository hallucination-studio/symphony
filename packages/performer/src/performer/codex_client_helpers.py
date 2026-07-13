from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

_INIT_BACKOFF_MS = 500
_INIT_BACKOFF_MAX_MS = 8_000

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
    if _looks_like_auth_failure(str(exc)):
        return _SdkErrorClassification("codex_auth_failed", inferred_http_status)
    class_name = type(exc).__name__
    if class_name == "RetryLimitExceededError":
        return _SdkErrorClassification("upstream_overloaded", inferred_http_status)
    if class_name == "ServerBusyError":
        return _SdkErrorClassification("upstream_overloaded", inferred_http_status)
    if class_name in {
        "InvalidParamsError",
        "InvalidRequestError",
        "MethodNotFoundError",
        "ParseError",
    }:
        return _SdkErrorClassification("codex_bad_request", inferred_http_status)
    if class_name == "TransportClosedError":
        return _SdkErrorClassification("sdk_transport_error", inferred_http_status)
    if _sdk_is_retryable(exc):
        return _SdkErrorClassification("upstream_overloaded", inferred_http_status)
    return _SdkErrorClassification("sdk_transport_error", inferred_http_status)


def _sdk_is_retryable(exc: BaseException) -> bool:
    try:
        from .backends.codex import is_codex_sdk_retryable

        return is_codex_sdk_retryable(exc)
    except Exception:
        return False


def _sanitized_sdk_reason(
    exc: BaseException,
    classification: _SdkErrorClassification | None = None,
) -> str:
    classified = classification or _classify_sdk_exception(exc)
    status_suffix = (
        f" (HTTP {classified.http_status})"
        if classified.http_status is not None
        else ""
    )
    reasons = {
        "codex_auth_failed": "Codex authentication failed",
        "codex_bad_request": "Codex rejected the SDK request",
        "codex_sdk_not_installed": "The Codex SDK is not installed",
        "invalid_sdk_codex_bin": "The configured Codex binary is not executable",
        "invalid_structured_output": "Codex returned invalid structured output",
        "invalid_workspace_cwd": "The managed workspace is not a directory",
        "response_error": "Codex returned an invalid SDK response",
        "sdk_missing_stream": "The Codex SDK does not support turn streaming",
        "sdk_missing_thread_resume": "The Codex SDK does not support thread resume",
        "sdk_missing_thread_start": "The Codex SDK does not support thread start",
        "sdk_missing_turn": "The Codex SDK does not support turns",
        "sdk_transport_error": "Codex SDK transport failed",
        "timeout": "Codex SDK request timed out",
        "upstream_overloaded": "Codex upstream is overloaded",
        "upstream_overloaded_exhausted": "Codex upstream retries were exhausted",
    }
    return f"{reasons.get(classified.code, 'Codex SDK request failed')}{status_suffix}"


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


def _looks_like_auth_failure(value: str) -> bool:
    lowered = value.lower()
    return any(
        marker in lowered
        for marker in (
            "authentication",
            "not authenticated",
            "unauthorized",
            "api key",
            "credential rejected",
        )
    )


def _optional_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _init_backoff_ms(completed_failures: int) -> int:
    return min(
        _INIT_BACKOFF_MS * (2 ** (completed_failures - 1)),
        _INIT_BACKOFF_MAX_MS,
    )


def _codex_sdk_env() -> dict[str, str]:
    home = os.environ.get("HOME")
    if not home:
        raise CodexError(
            "managed_home_required",
            "HOME is required for managed Codex execution",
        )
    env = {"HOME": home}
    codex_home = os.environ.get("CODEX_HOME")
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
        logger.debug(
            "event=codex_sdk_close_failed error_type=%s",
            type(exc).__name__,
        )


def _string_attr(value: Any, name: str) -> str | None:
    if isinstance(value, dict):
        raw = value.get(name)
    else:
        raw = getattr(value, name, None)
    return raw if isinstance(raw, str) and raw else None


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
