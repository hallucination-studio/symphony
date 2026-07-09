from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

CONNECTIVITY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["ok"]},
        "summary": {"type": "string"},
    },
    "required": ["status", "summary"],
    "additionalProperties": False,
}


PLANNER_SHAPED_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "probe_kind": {"type": "string", "enum": ["planner-shaped"]},
        "summary": {"type": "string"},
        "proposal": {
            "type": "object",
            "properties": {
                "nodes": {
                    "type": "array",
                    "minItems": 3,
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "mode": {"type": "string", "enum": ["plan", "execute", "verify"]},
                            "objective": {"type": "string"},
                            "depends_on": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["id", "mode", "objective", "depends_on"],
                        "additionalProperties": False,
                    },
                },
                "gates": {
                    "type": "array",
                    "minItems": 2,
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "node_id": {"type": "string"},
                            "kind": {"type": "string"},
                            "command": {"type": "string"},
                        },
                        "required": ["id", "node_id", "kind", "command"],
                        "additionalProperties": False,
                    },
                },
                "entry_node_ids": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                "exit_node_ids": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                "risk_notes": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["nodes", "gates", "entry_node_ids", "exit_node_ids", "risk_notes"],
            "additionalProperties": False,
        },
    },
    "required": ["probe_kind", "summary", "proposal"],
    "additionalProperties": False,
}


@dataclass(frozen=True)
class ProbeSpec:
    prompt: str
    schema: dict[str, Any]


SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE),
    re.compile(r"sk-[A-Za-z0-9_-]+", re.IGNORECASE),
    re.compile(r"(api[_-]?key=)[^&\s]+", re.IGNORECASE),
    re.compile(r"(access_token=)[^&\s]+", re.IGNORECASE),
    re.compile(r"(refresh_token=)[^&\s]+", re.IGNORECASE),
)


def probe_prompt(message: str) -> str:
    return (
        f"{message}\n\n"
        'Return only JSON matching this shape: {"status":"ok","summary":"one short sentence"}.'
    )


def planner_shaped_probe_prompt(message: str) -> str:
    return (
        f"{message}\n\n"
        "You are validating that the real Codex runtime can complete a planner-shaped structured turn. "
        "Create a small Symphony three-mode runtime proposal for an overall-dod acceptance run. "
        "Return only JSON. Include top-level probe_kind='planner-shaped', a one sentence summary, and a proposal. "
        "The proposal must include nodes for plan, execute, and verify work, explicit depends_on arrays, gates with "
        "commands, entry_node_ids, exit_node_ids, and risk_notes. Do not include secrets or environment values."
    )


def probe_spec(probe_kind: str, message: str = "symphony codex connectivity probe") -> ProbeSpec:
    if probe_kind == "minimal":
        return ProbeSpec(prompt=probe_prompt(message), schema=CONNECTIVITY_SCHEMA)
    if probe_kind == "planner-shaped":
        return ProbeSpec(prompt=planner_shaped_probe_prompt(message), schema=PLANNER_SHAPED_SCHEMA)
    raise ValueError(f"unsupported probe kind: {probe_kind}")


def summarize_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    names = [str(event.get("event") or "") for event in events]
    overload_events = [event for event in events if str(event.get("event") or "").startswith("codex_overload_")]
    terminal_events = [event for event in events if str(event.get("event") or "") == "codex_request_failed_terminal"]
    timeout_events = [event for event in events if str(event.get("event") or "") == "request_timeout"]
    summary = {
        "event_names": names,
        "init_succeeded": "codex_init_succeeded" in names,
        "init_failed": "codex_init_failed" in names,
        "turn_started": "turn_started" in names,
        "turn_completed": "turn_completed" in names,
        "overload_retry_count": names.count("codex_overload_retrying"),
        "overload_exhausted": "codex_overload_exhausted" in names,
        "terminal_failed": "codex_request_failed_terminal" in names,
        "request_timeout": "request_timeout" in names,
        "http_statuses": [
            event.get("http_status")
            for event in [*overload_events, *terminal_events]
            if event.get("http_status") is not None
        ],
        "init_events": sanitize_value([event for event in events if str(event.get("event") or "").startswith("codex_init_")]),
        "overload_events": sanitize_value(overload_events),
        "terminal_events": sanitize_value(terminal_events),
        "timeout_events": sanitize_value(timeout_events),
        "secret_leak_found": _contains_secret(events),
    }
    summary["connectivity_status"] = classify_connectivity(summary)
    return summary


def classify_connectivity(summary: dict[str, Any]) -> str:
    if summary.get("secret_leak_found"):
        return "secret_leak"
    if summary.get("outcome") == "success" and summary.get("init_succeeded") and summary.get("turn_completed"):
        if summary.get("probe_kind") == "planner-shaped" and not summary.get("planner_shape_valid"):
            return "planner_shape_invalid"
        return "connected"
    http_status = _first_http_status(summary)
    error_code = str(summary.get("error_code") or "")
    error_text = str(summary.get("error") or "").lower()
    if http_status in {401, 403}:
        return "auth_failed"
    if error_code in {"upstream_overloaded_exhausted", "upstream_overloaded"}:
        return "upstream_unavailable"
    if http_status is not None and 500 <= http_status <= 599:
        return "upstream_unavailable"
    if summary.get("overload_exhausted"):
        return "upstream_unavailable"
    if error_code == "timeout" or summary.get("request_timeout") or "timeout" in error_text:
        return "timeout"
    if summary.get("outcome") == "unexpected_error":
        return "unexpected_error"
    if summary.get("outcome") == "codex_error":
        return "codex_error"
    return "not_connected"


def scenario_passed(summary: dict[str, Any], expected: str) -> bool:
    return classify_connectivity(summary) == expected


def sanitize_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: sanitize_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize_value(item) for item in value]
    if isinstance(value, str):
        return sanitize_text(value)
    return value


def sanitize_text(value: str) -> str:
    redacted = value
    for pattern in SECRET_PATTERNS:
        redacted = pattern.sub(lambda match: f"{match.group(1)}<redacted>" if match.lastindex else "<redacted>", redacted)
    return redacted


def extract_probe_structured_result(result: object) -> dict[str, Any]:
    structured = getattr(result, "structured_result", None)
    if isinstance(structured, dict):
        return structured
    final_response = getattr(result, "final_response", None)
    if not isinstance(final_response, str) or not final_response.strip():
        return {}
    try:
        parsed = json.loads(final_response)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _contains_secret(value: Any) -> bool:
    text = json.dumps(value, sort_keys=True)
    return any(pattern.search(text) for pattern in SECRET_PATTERNS)


def _first_http_status(summary: dict[str, Any]) -> int | None:
    raw_status = summary.get("http_status")
    if raw_status is None:
        statuses = summary.get("http_statuses")
        if isinstance(statuses, list) and statuses:
            raw_status = statuses[-1]
    try:
        return int(raw_status)
    except (TypeError, ValueError):
        return None


def _planner_shape_valid(structured: dict[str, Any]) -> bool:
    proposal = structured.get("proposal")
    if structured.get("probe_kind") != "planner-shaped" or not isinstance(proposal, dict):
        return False
    nodes = proposal.get("nodes")
    gates = proposal.get("gates")
    entry_node_ids = proposal.get("entry_node_ids")
    exit_node_ids = proposal.get("exit_node_ids")
    if not isinstance(nodes, list) or len(nodes) < 3:
        return False
    if not isinstance(gates, list) or len(gates) < 2:
        return False
    if not isinstance(entry_node_ids, list) or not entry_node_ids:
        return False
    if not isinstance(exit_node_ids, list) or not exit_node_ids:
        return False
    modes = {node.get("mode") for node in nodes if isinstance(node, dict)}
    return {"plan", "execute", "verify"}.issubset(modes)
