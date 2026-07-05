from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from performer.codex_client import CodexError, CodexSdkClient
from performer_api.config import CodexConfig


def probe_prompt(message: str) -> str:
    return (
        f"{message}\n\n"
        "Return only the structured result object required by Performer. "
        "Use summary to describe this init probe step, test_commands as an empty list, "
        "changed_files as an empty list, remaining_risks as an empty list, "
        "and next_action set to ready_for_review."
    )


def summarize_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    names = [str(event.get("event") or "") for event in events]
    return {
        "event_names": names,
        "init_start_count": names.count("codex_init_starting"),
        "init_retry_count": names.count("codex_init_retrying"),
        "init_succeeded": "codex_init_succeeded" in names,
        "init_failed": "codex_init_failed" in names,
        "init_events": [event for event in events if str(event.get("event") or "").startswith("codex_init_")],
    }


async def run_probe(args: argparse.Namespace) -> dict[str, Any]:
    workspace = args.workspace.resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    events: list[dict[str, Any]] = []
    client = CodexSdkClient(
        CodexConfig(
            model=args.model,
            sdk_codex_bin=args.sdk_codex_bin,
            sandbox=args.sandbox,
            read_timeout_ms=args.read_timeout_ms,
            turn_timeout_ms=args.turn_timeout_ms,
            hard_turn_timeout_ms=args.turn_timeout_ms,
            init_max_attempts=args.init_max_attempts,
            init_backoff_ms=args.init_backoff_ms,
            init_backoff_max_ms=args.init_backoff_max_ms,
        )
    )

    summary: dict[str, Any] = {
        "workspace": str(workspace),
        "scenario": args.scenario,
        "expected": args.expected,
    }
    try:
        result = await client.run_session(
            workspace,
            probe_prompt(f"codex init probe scenario {args.scenario}"),
            f"codex-init-probe-{args.scenario}",
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
        summary.update({"outcome": "codex_error", "error_code": exc.code, "error": str(exc)})
    except Exception as exc:
        summary.update({"outcome": "unexpected_error", "error_code": exc.__class__.__name__, "error": str(exc)})

    summary.update(summarize_events(events))
    summary["pass"] = _scenario_passed(summary, args.expected)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    return summary


def _scenario_passed(summary: dict[str, Any], expected: str) -> bool:
    if expected == "success":
        return bool(summary.get("outcome") == "success" and summary.get("init_succeeded"))
    if expected == "transient_recovered":
        return bool(
            summary.get("outcome") == "success"
            and summary.get("init_retry_count", 0) >= 1
            and summary.get("init_succeeded")
        )
    if expected == "init_failed":
        return bool(
            summary.get("outcome") == "codex_error"
            and summary.get("error_code") == "codex_init_failed"
            and summary.get("init_failed")
        )
    if expected == "terminal_failed":
        return bool(
            summary.get("outcome") == "codex_error"
            and summary.get("error_code") != "codex_init_failed"
            and summary.get("init_start_count") == 1
            and summary.get("init_failed")
        )
    raise ValueError(f"Unsupported expected outcome: {expected}")


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Run a real Codex SDK init hardening probe.")
    arg_parser.add_argument("--workspace", type=Path, required=True)
    arg_parser.add_argument("--out", type=Path)
    arg_parser.add_argument("--scenario", default="natural")
    arg_parser.add_argument(
        "--expected",
        choices=["success", "transient_recovered", "init_failed", "terminal_failed"],
        default="success",
    )
    arg_parser.add_argument("--model")
    arg_parser.add_argument("--sdk-codex-bin")
    arg_parser.add_argument("--sandbox")
    arg_parser.add_argument("--read-timeout-ms", type=int, default=30_000)
    arg_parser.add_argument("--turn-timeout-ms", type=int, default=180_000)
    arg_parser.add_argument("--init-max-attempts", type=int, default=4)
    arg_parser.add_argument("--init-backoff-ms", type=int, default=500)
    arg_parser.add_argument("--init-backoff-max-ms", type=int, default=8_000)
    return arg_parser


def main() -> int:
    args = parser().parse_args()
    summary = asyncio.run(run_probe(args))
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if summary["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
