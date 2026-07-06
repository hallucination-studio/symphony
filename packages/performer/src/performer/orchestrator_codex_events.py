from __future__ import annotations

import logging
from typing import Any, Callable

from performer_api.models import PHASE_LABELS, RunningEntry, RuntimeTokens, utc_now


logger = logging.getLogger(__name__)


class CodexEventProcessor:
    def __init__(
        self,
        *,
        state: Any,
        config: Any,
        persist_state: Callable[[], None],
        comment_runtime_error_background: Callable[[RunningEntry, dict[str, Any]], None],
    ):
        self.state = state
        self.config = config
        self.persist_state = persist_state
        self.comment_runtime_error_background = comment_runtime_error_background

    def on_event(self, issue_id: str, event: dict[str, Any]) -> None:
        entry = self.state.running.get(issue_id)
        if not entry:
            return
        session_id = event.get("session_id")
        if isinstance(session_id, str) and session_id:
            entry.session_id = session_id
        thread_id = event.get("thread_id")
        if isinstance(thread_id, str) and thread_id:
            entry.thread_id = thread_id
        turn_id = event.get("turn_id")
        if isinstance(turn_id, str) and turn_id:
            entry.turn_id = turn_id
        cwd = event.get("cwd")
        if isinstance(cwd, str) and cwd:
            entry.workspace_path = cwd
        entry.last_codex_event = event.get("event")
        raw_message = event.get("message") or event.get("raw_method") or event.get("method")
        entry.last_raw_codex_message = str(raw_message) if raw_message is not None else None
        message = status_message_from_event(event)
        if message is not None:
            entry.last_codex_message = message
        entry.last_codex_timestamp = utc_now()
        if event.get("event") == "turn_completed":
            entry.turn_count += 1
        blocked_reason = human_blocked_runtime_reason(entry, event) if event_can_signal_human_block(event) else None
        if blocked_reason and entry.human_blocked_reason is None:
            entry.human_blocked_reason = blocked_reason
            entry.phase = "error"
            entry.status_label = PHASE_LABELS["blocked"]
            entry.runtime_phase = "failed"
            self.comment_runtime_error_background(entry, event)
            if entry.task is not None and not entry.task.done():
                entry.task.cancel()
        self.apply_phase_from_event(entry, event)
        self.append_recent_event(entry, event)
        logger.info(
            "performer_codex_event issue_id=%s issue_identifier=%s session_id=%s event=%s raw_method=%s message=%s",
            issue_id,
            entry.issue.identifier,
            entry.session_id or "-",
            event.get("event") or "-",
            event.get("raw_method") or event.get("method") or "-",
            log_message(event.get("message") or event.get("tool_name") or ""),
        )
        rate_limits = self.extract_rate_limits(event)
        if rate_limits is not None:
            self.state.codex_rate_limits = rate_limits
        tokens = self.extract_absolute_tokens(event)
        if tokens is not None:
            self.apply_absolute_tokens(entry, tokens)
        self.persist_state()

    def apply_phase_from_event(self, entry: RunningEntry, event: dict[str, Any]) -> None:
        event_name = event.get("event")
        if event_name in {"process_launch", "session_started"}:
            entry.phase = "starting"
            entry.status_label = PHASE_LABELS["implementation_running"]
            entry.runtime_phase = "dispatch_received"
        elif event_name == "turn_started":
            if entry.human_blocked_reason:
                return
            entry.phase = "running"
            entry.status_label = PHASE_LABELS["implementation_running"]
            entry.runtime_phase = "implementation_running"
            entry.turn_started_at = utc_now()
        elif event_name in {"request_timeout", "stderr", "turn_failed", "turn_cancelled", "turn_ended_with_error"}:
            was_error = entry.phase == "error"
            entry.phase = "error"
            entry.status_label = PHASE_LABELS["failed"]
            entry.runtime_phase = "failed"
            if not was_error:
                self.comment_runtime_error_background(entry, event)
            if entry.human_blocked_reason and entry.task is not None and not entry.task.done():
                entry.task.cancel()
        elif event_name == "turn_completed":
            if entry.human_blocked_reason:
                return
            entry.phase = "running"
            entry.status_label = PHASE_LABELS["implementation_running"]
            entry.runtime_phase = "implementation_done"
            entry.turn_started_at = None

    def append_recent_event(self, entry: RunningEntry, event: dict[str, Any]) -> None:
        row = {
            "at": entry.last_codex_timestamp.astimezone().isoformat()
            if entry.last_codex_timestamp is not None
            else None,
            "event": event.get("event"),
            "message": entry.last_codex_message,
            "raw_method": event.get("raw_method") or event.get("method"),
            "usage": event.get("usage") or usage_row_from_tokens(self.extract_absolute_tokens(event)),
            "command": command_from_event(event),
            "exit_code": exit_code_from_event(event),
            "raw_event": dict(event),
        }
        entry.recent_events.append(row)
        if len(entry.recent_events) > 20:
            del entry.recent_events[:-20]

    def apply_absolute_tokens(self, entry: RunningEntry, tokens: RuntimeTokens) -> None:
        input_delta = max(tokens.input_tokens - entry.last_reported_tokens.input_tokens, 0)
        output_delta = max(tokens.output_tokens - entry.last_reported_tokens.output_tokens, 0)
        total_delta = max(tokens.total_tokens - entry.last_reported_tokens.total_tokens, 0)
        entry.tokens = tokens
        entry.last_reported_tokens = RuntimeTokens(
            input_tokens=tokens.input_tokens,
            output_tokens=tokens.output_tokens,
            cached_tokens=tokens.cached_tokens,
            total_tokens=tokens.total_tokens,
        )
        self.state.codex_totals.input_tokens += input_delta
        self.state.codex_totals.output_tokens += output_delta
        self.state.codex_totals.total_tokens += total_delta

    def extract_absolute_tokens(self, event: dict[str, Any]) -> RuntimeTokens | None:
        return extract_absolute_tokens(event)

    def extract_rate_limits(self, event: dict[str, Any]) -> dict[str, Any] | None:
        payload = event.get("payload")
        if not isinstance(payload, dict):
            return None
        rate_limits = payload.get("rate_limits") or payload.get("rateLimits")
        return rate_limits if isinstance(rate_limits, dict) else None


def log_message(value: Any) -> str:
    text = str(value or "-").replace("\n", "\\n")
    if len(text) > 240:
        return text[:237] + "..."
    return text


def status_message_from_event(event: dict[str, Any]) -> str | None:
    message = event.get("message")
    if isinstance(message, str) and message.strip():
        if is_low_value_message(message):
            return None
        return message

    raw_method = event.get("raw_method") or event.get("method")
    if raw_method in {
        "item/started",
        "item/completed",
        "thread/tokenUsage/updated",
        "account/rateLimits/updated",
        "turn/diff/updated",
        "thread/status/changed",
    }:
        return None

    event_name = event.get("event")
    if event_name == "request_timeout":
        method = event.get("method")
        if isinstance(method, str) and method:
            return f"{method} timed out"
        return "request timed out"
    if event_name in {
        "stderr",
        "turn_failed",
        "turn_cancelled",
        "turn_ended_with_error",
        "unsupported_tool_call",
        "malformed",
    }:
        fallback = raw_method or event_name
        return str(fallback) if fallback else None

    tool_name = event.get("tool_name")
    if isinstance(tool_name, str) and tool_name:
        return tool_name
    return None


def is_low_value_message(message: str) -> bool:
    stripped = message.strip()
    return bool(stripped) and set(stripped) <= {".", " ", "\n", "\r", "\t"}


def usage_row_from_tokens(tokens: RuntimeTokens | None) -> dict[str, int] | None:
    if tokens is None:
        return None
    return {
        "input_tokens": tokens.input_tokens,
        "output_tokens": tokens.output_tokens,
        "cached_tokens": tokens.cached_tokens,
        "total_tokens": tokens.total_tokens,
    }


def command_from_event(event: dict[str, Any]) -> str | None:
    payload = event.get("payload")
    if not isinstance(payload, dict):
        return None
    command = payload.get("command")
    if isinstance(command, str) and command.strip():
        return command.strip()
    item = payload.get("item")
    if isinstance(item, dict):
        nested = item.get("command")
        if isinstance(nested, str) and nested.strip():
            return nested.strip()
    return None


def exit_code_from_event(event: dict[str, Any]) -> int | None:
    payload = event.get("payload")
    if not isinstance(payload, dict):
        return None
    value = payload.get("exit_code")
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    item = payload.get("item")
    if isinstance(item, dict):
        nested = item.get("exit_code")
        if isinstance(nested, int):
            return nested
        if isinstance(nested, str) and nested.strip().isdigit():
            return int(nested.strip())
    return None


def extract_absolute_tokens(event: dict[str, Any]) -> RuntimeTokens | None:
    payload = event.get("payload")
    if not isinstance(payload, dict):
        return None
    token_payload: Any = None
    if event.get("raw_method") == "thread/tokenUsage/updated":
        token_payload = payload.get("tokenUsage") or payload.get("token_usage") or payload
    if token_payload is None:
        token_payload = payload.get("total_token_usage") or payload.get("totalTokenUsage")
    if not isinstance(token_payload, dict):
        return None
    return RuntimeTokens(
        input_tokens=int_from_keys(token_payload, "input_tokens", "inputTokens", "input"),
        output_tokens=int_from_keys(token_payload, "output_tokens", "outputTokens", "output"),
        cached_tokens=int_from_keys(token_payload, "cached_tokens", "cachedTokens", "cached"),
        total_tokens=int_from_keys(token_payload, "total_tokens", "totalTokens", "total"),
    )


def int_from_keys(values: dict[str, Any], *keys: str) -> int:
    for key in keys:
        value = values.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.strip().isdigit():
            return int(value.strip())
    return 0


def human_blocked_runtime_reason(entry: RunningEntry, event: dict[str, Any]) -> str | None:
    message = " ".join(
        str(value or "")
        for value in (
            event.get("message"),
            event.get("raw_method"),
            event.get("method"),
            entry.last_codex_message,
            entry.last_raw_codex_message,
        )
    ).lower()
    blocked_patterns = (
        "writing outside of the project",
        "outside of the project",
        "requires approval",
        "permission denied",
        "operation not permitted",
        "sandbox",
        "approval denied",
        "not permitted",
    )
    if any(pattern in message for pattern in blocked_patterns):
        readable = entry.last_codex_message or event.get("message") or event.get("raw_method") or event.get("event")
        return f"runtime_permission_blocked: {readable}"
    return None


def event_can_signal_human_block(event: dict[str, Any]) -> bool:
    event_name = str(event.get("event") or "")
    raw_method = str(event.get("raw_method") or event.get("method") or "")
    if event_name in {"request_timeout", "stderr", "turn_failed", "turn_cancelled", "turn_ended_with_error"}:
        return True
    if raw_method.startswith("item/commandExecution/"):
        return True
    if raw_method == "item/completed":
        message = str(event.get("message") or "").lower()
        if "previous attempt failed" in message:
            return False
        return "operation not permitted" in message or "permission denied" in message or "outside-workspace write failed" in message
    return False
