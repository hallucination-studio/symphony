from __future__ import annotations


def explain_issue_state(detail: dict[str, object]) -> str:
    status = str(detail.get("status") or detail.get("state") or "unknown")
    last_event = detail.get("last_event_type")
    failure_summary = _string(detail.get("failure_summary") or detail.get("failure_reason"))
    last_reason = _string(detail.get("last_reason_summary"))

    if status == "stalled":
        if failure_summary:
            return f"Stalled because {failure_summary}."
        if last_event == "tool_call_failed":
            return "Stalled because the last tool call failed and no further Codex output arrived before the stall timeout."
        return "Stalled because no further Codex output arrived before the stall timeout."
    if status == "retrying":
        return f"Retrying because {failure_summary or 'the last attempt failed'}"
    if status == "blocked":
        return f"Blocked because {last_reason or 'a dependency is still non-terminal'}"
    return last_reason or failure_summary or status


def _string(value: object) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""
