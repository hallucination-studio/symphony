from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from performer.codex_client import CodexError, CodexSdkClient
from performer.codex_config import CodexConfig


def probe_prompt(message: str) -> str:
    return (
        f"{message}\n\n"
        "Return only the structured result object required by Performer. "
        "Use summary to describe this overload probe step, test_commands as an empty list, "
        "changed_files as an empty list, remaining_risks as an empty list, "
        "and next_action set to ready_for_review."
    )


def summarize_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    names = [str(event.get("event") or "") for event in events]
    overload_events = [event for event in events if str(event.get("event") or "").startswith("codex_overload_")]
    terminal_events = [event for event in events if str(event.get("event") or "") == "codex_request_failed_terminal"]
    return {
        "event_names": names,
        "overload_retry_count": names.count("codex_overload_retrying"),
        "overload_exhausted": "codex_overload_exhausted" in names,
        "terminal_failed": "codex_request_failed_terminal" in names,
        "turn_completed": "turn_completed" in names,
        "http_statuses": [
            event.get("http_status")
            for event in [*overload_events, *terminal_events]
            if event.get("http_status") is not None
        ],
        "overload_events": overload_events,
        "terminal_events": terminal_events,
        "last_overload_message": str(overload_events[-1].get("message") or "") if overload_events else None,
        "last_terminal_message": str(terminal_events[-1].get("message") or "") if terminal_events else None,
        "secret_leak_found": _contains_secret(events),
    }


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
            read_timeout_ms=args.read_timeout_ms,
            hard_turn_timeout_ms=args.turn_timeout_ms,
            overload_max_attempts=args.overload_max_attempts,
            overload_initial_delay_ms=args.overload_initial_delay_ms,
            overload_max_delay_ms=args.overload_max_delay_ms,
        )
    )

    summary: dict[str, Any] = {
        "workspace": str(workspace),
        "scenario": args.scenario,
        "expected": args.expected,
        "config_overrides": list(config_overrides),
    }
    try:
        result = await client.run_session(
            workspace,
            probe_prompt(f"codex overload probe scenario {args.scenario}"),
            f"codex-overload-probe-{args.scenario}",
            on_event=events.append,
        )
        summary.update(
            {
                "outcome": "success",
                "thread_id": result.thread_id,
                "turn_id": result.turn_id,
                "structured_next_action": (
                    result.structured_result.get("next_action")
                    if isinstance(result.structured_result, dict)
                    else None
                ),
            }
        )
    except CodexError as exc:
        summary.update(
            {
                "outcome": "codex_error",
                "error_code": exc.code,
                "error": str(exc),
                "http_status": exc.http_status,
            }
        )
    except Exception as exc:
        summary.update({"outcome": "unexpected_error", "error_code": exc.__class__.__name__, "error": str(exc)})

    summary.update(summarize_events(events))
    if args.wrapper_log:
        summary["wrapper_log"] = str(args.wrapper_log)
        summary["wrapper_events"] = _read_wrapper_events(args.wrapper_log)
        summary["secret_leak_found"] = bool(summary.get("secret_leak_found") or _contains_secret(summary["wrapper_events"]))
    summary["pass"] = scenario_passed(summary, args.expected)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    return summary


def scenario_passed(summary: dict[str, Any], expected: str) -> bool:
    if summary.get("secret_leak_found"):
        return False
    if expected == "success":
        return bool(summary.get("outcome") == "success" and summary.get("turn_completed"))
    if expected == "overload_recovered":
        return bool(
            summary.get("outcome") == "success"
            and summary.get("overload_retry_count", 0) >= 1
            and summary.get("turn_completed")
        )
    if expected == "overload_exhausted":
        return bool(
            summary.get("outcome") == "codex_error"
            and summary.get("error_code") == "upstream_overloaded_exhausted"
            and summary.get("overload_exhausted")
        )
    if expected == "terminal_failed":
        return bool(
            summary.get("outcome") == "codex_error"
            and summary.get("error_code") == "codex_bad_request"
            and summary.get("terminal_failed")
            and summary.get("overload_retry_count", 0) == 0
        )
    raise ValueError(f"Unsupported expected outcome: {expected}")


def _contains_secret(value: Any) -> bool:
    text = json.dumps(value, sort_keys=True).lower()
    return any(marker in text for marker in ("sk-", "bearer ", "access_token=", "refresh_token=", "api_key="))


def _read_wrapper_events(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    events: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
    return events


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Run a real Codex SDK overload resilience probe.")
    arg_parser.add_argument("--workspace", type=Path, required=True)
    arg_parser.add_argument("--out", type=Path)
    arg_parser.add_argument("--scenario", default="natural")
    arg_parser.add_argument(
        "--expected",
        choices=["success", "overload_recovered", "overload_exhausted", "terminal_failed"],
        default="success",
    )
    arg_parser.add_argument("--model")
    arg_parser.add_argument("--sdk-codex-bin")
    arg_parser.add_argument("--sandbox")
    arg_parser.add_argument("--config-override", action="append")
    arg_parser.add_argument("--wrapper-log", type=Path)
    arg_parser.add_argument("--read-timeout-ms", type=int, default=30_000)
    arg_parser.add_argument("--turn-timeout-ms", type=int, default=180_000)
    arg_parser.add_argument("--overload-max-attempts", type=int, default=5)
    arg_parser.add_argument("--overload-initial-delay-ms", type=int, default=250)
    arg_parser.add_argument("--overload-max-delay-ms", type=int, default=8_000)
    return arg_parser


def main() -> int:
    args = parser().parse_args()
    summary = asyncio.run(run_probe(args))
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if summary["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
