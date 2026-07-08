from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from performer.codex_client import CodexError, CodexSdkClient
from performer_api.config import CodexConfig


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


async def run_probe(args: argparse.Namespace) -> dict[str, Any]:
    workspace = args.workspace.resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    events: list[dict[str, Any]] = []
    config_overrides = tuple(args.config_override or ())
    client = CodexSdkClient(
        CodexConfig(
            model=args.model,
            sdk_codex_bin=args.sdk_codex_bin,
            sandbox=args.sandbox,
            config_overrides=config_overrides,
            read_timeout_ms=args.timeout_ms,
            turn_timeout_ms=args.timeout_ms,
            hard_turn_timeout_ms=args.timeout_ms,
            init_max_attempts=args.init_max_attempts,
            init_backoff_ms=args.init_backoff_ms,
            init_backoff_max_ms=args.init_backoff_max_ms,
            overload_max_attempts=args.overload_max_attempts,
            overload_initial_delay_ms=args.overload_initial_delay_ms,
            overload_max_delay_ms=args.overload_max_delay_ms,
        )
    )

    summary: dict[str, Any] = {
        "workspace": str(workspace),
        "expected": args.expected,
        "probe_kind": args.probe_kind,
        "codex_home_configured": bool(args.codex_home),
        "config_overrides": sanitize_value(list(config_overrides)),
    }
    spec = probe_spec(args.probe_kind)
    old_codex_home = os.environ.get("CODEX_HOME")
    if args.codex_home:
        os.environ["CODEX_HOME"] = str(args.codex_home.resolve())
    try:
        result = await client.run_session(
            workspace,
            spec.prompt,
            "symphony-codex-connectivity-probe",
            on_event=events.append,
            output_schema=spec.schema,
        )
        structured = extract_probe_structured_result(result)
        final_response = result.final_response if isinstance(result.final_response, str) else ""
        summary.update(
            {
                "outcome": "success",
                "thread_id": result.thread_id,
                "turn_id": result.turn_id,
                "structured_present": bool(structured),
                "structured_status": structured.get("status"),
                "structured_probe_kind": structured.get("probe_kind"),
                "planner_shape_valid": _planner_shape_valid(structured),
                "final_response_excerpt": sanitize_text(final_response[:1000]),
            }
        )
    except CodexError as exc:
        summary.update(
            {
                "outcome": "codex_error",
                "error_code": exc.code,
                "error": sanitize_text(str(exc)),
                "http_status": exc.http_status,
            }
        )
    except Exception as exc:
        summary.update(
            {
                "outcome": "unexpected_error",
                "error_code": exc.__class__.__name__,
                "error": sanitize_text(str(exc)),
            }
        )
    finally:
        if old_codex_home is None:
            os.environ.pop("CODEX_HOME", None)
        else:
            os.environ["CODEX_HOME"] = old_codex_home

    summary.update(summarize_events(events))
    summary["connectivity_status"] = classify_connectivity(summary)
    summary["pass"] = scenario_passed(summary, args.expected)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
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


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Run a real Codex SDK connectivity probe.")
    arg_parser.add_argument("--workspace", type=Path, required=True)
    arg_parser.add_argument("--codex-home", type=Path)
    arg_parser.add_argument("--out", type=Path)
    arg_parser.add_argument("--probe-kind", choices=["minimal", "planner-shaped"], default="minimal")
    arg_parser.add_argument(
        "--expected",
        choices=[
            "connected",
            "planner_shape_invalid",
            "upstream_unavailable",
            "auth_failed",
            "timeout",
            "codex_error",
            "unexpected_error",
        ],
        default="connected",
    )
    arg_parser.add_argument("--model")
    arg_parser.add_argument("--sdk-codex-bin")
    arg_parser.add_argument("--sandbox")
    arg_parser.add_argument("--config-override", action="append")
    arg_parser.add_argument("--timeout-ms", type=int, default=45_000)
    arg_parser.add_argument("--init-max-attempts", type=int, default=2)
    arg_parser.add_argument("--init-backoff-ms", type=int, default=500)
    arg_parser.add_argument("--init-backoff-max-ms", type=int, default=2_000)
    arg_parser.add_argument("--overload-max-attempts", type=int, default=2)
    arg_parser.add_argument("--overload-initial-delay-ms", type=int, default=250)
    arg_parser.add_argument("--overload-max-delay-ms", type=int, default=2_000)
    return arg_parser


def main() -> int:
    args = parser().parse_args()
    summary = asyncio.run(run_probe(args))
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if summary["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
