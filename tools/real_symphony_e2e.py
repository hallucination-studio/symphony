from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from real_symphony_e2e_common import *  # noqa: F401,F403
from real_symphony_e2e_linear import *  # noqa: F401,F403
from real_symphony_e2e_analysis import *  # noqa: F401,F403
from real_symphony_e2e_wait import *  # noqa: F401,F403
from real_symphony_e2e_run import build_runtime_config_payload, run, stage_codex_home_seed
from real_symphony_e2e_common import DEFAULT_PROJECT_SLUG
import real_symphony_e2e_analysis as _analysis
import real_symphony_e2e_linear as _linear


async def create_linear_issue(*args: Any, **kwargs: Any) -> dict[str, Any]:
    original = _linear.linear_graphql
    _linear.linear_graphql = linear_graphql
    try:
        return await _linear.create_linear_issue(*args, **kwargs)
    finally:
        _linear.linear_graphql = original


async def create_linear_blocks_relation(*args: Any, **kwargs: Any) -> dict[str, Any]:
    original = _linear.linear_graphql
    _linear.linear_graphql = linear_graphql
    try:
        return await _linear.create_linear_blocks_relation(*args, **kwargs)
    finally:
        _linear.linear_graphql = original


async def fetch_linear_issue(*args: Any, **kwargs: Any) -> dict[str, Any]:
    original = _linear.linear_graphql
    _linear.linear_graphql = linear_graphql
    try:
        return await _linear.fetch_linear_issue(*args, **kwargs)
    finally:
        _linear.linear_graphql = original


async def wait_for_linear_delegate_visible(*args: Any, **kwargs: Any) -> dict[str, Any]:
    original = _linear.fetch_linear_issue
    _linear.fetch_linear_issue = fetch_linear_issue
    try:
        return await _linear.wait_for_linear_delegate_visible(*args, **kwargs)
    finally:
        _linear.fetch_linear_issue = original


async def fetch_linear_human_action_issue(*args: Any, **kwargs: Any) -> dict[str, Any]:
    original = _linear.linear_graphql
    _linear.linear_graphql = linear_graphql
    try:
        return await _linear.fetch_linear_human_action_issue(*args, **kwargs)
    finally:
        _linear.linear_graphql = original


async def update_linear_issue_description(*args: Any, **kwargs: Any) -> dict[str, Any]:
    original = _linear.linear_graphql
    _linear.linear_graphql = linear_graphql
    try:
        return await _linear.update_linear_issue_description(*args, **kwargs)
    finally:
        _linear.linear_graphql = original


async def move_linear_issue_to_state(*args: Any, **kwargs: Any) -> dict[str, Any]:
    original = _linear.linear_graphql
    _linear.linear_graphql = linear_graphql
    try:
        return await _linear.move_linear_issue_to_state(*args, **kwargs)
    finally:
        _linear.linear_graphql = original


async def complete_conductor_human_action(*args: Any, **kwargs: Any) -> dict[str, Any]:
    originals = (
        _analysis.fetch_linear_human_action_issue,
        _analysis.update_linear_issue_description,
        _analysis.move_linear_issue_to_state,
    )
    _analysis.fetch_linear_human_action_issue = fetch_linear_human_action_issue
    _analysis.update_linear_issue_description = update_linear_issue_description
    _analysis.move_linear_issue_to_state = move_linear_issue_to_state
    try:
        return await _analysis.complete_conductor_human_action(*args, **kwargs)
    finally:
        (
            _analysis.fetch_linear_human_action_issue,
            _analysis.update_linear_issue_description,
            _analysis.move_linear_issue_to_state,
        ) = originals


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Run a real Symphony Podium/Conductor/Performer e2e matrix.")
    arg_parser.add_argument("--out", type=Path, default=Path(".test-real-flow/e2e-matrix"))
    arg_parser.add_argument("--project-slug", default=DEFAULT_PROJECT_SLUG)
    arg_parser.add_argument("--pipeline-gates", action=argparse.BooleanOptionalAction, default=True)
    arg_parser.add_argument(
        "--pipeline-scenario",
        choices=["basic", "parallel", "replan", "integration-conflict", "runtime-wait", "overall-dod"],
        default="basic",
    )
    arg_parser.add_argument("--e2e-gate-mode", choices=["smoke", "strict"], default="smoke")
    arg_parser.add_argument("--stage-timeout", type=int, default=120)
    arg_parser.add_argument("--permission-approval-probe", action="store_true")
    arg_parser.add_argument("--crash-recovery-probe", action="store_true")
    arg_parser.add_argument("--sdk-codex-bin")
    arg_parser.add_argument("--init-max-attempts", type=int)
    arg_parser.add_argument("--init-backoff-ms", type=int)
    arg_parser.add_argument("--init-backoff-max-ms", type=int)
    arg_parser.add_argument("--read-timeout-ms", type=int)
    arg_parser.add_argument("--hard-turn-timeout-ms", type=int)
    arg_parser.add_argument("--overload-max-attempts", type=int)
    arg_parser.add_argument("--overload-initial-delay-ms", type=int)
    arg_parser.add_argument("--overload-max-delay-ms", type=int)
    arg_parser.add_argument("--config-override", action="append")
    arg_parser.add_argument("--expected-failure", choices=["none", "overload", "terminal_bad_request"], default="none")
    arg_parser.add_argument(
        "--simulate-agent-webhook",
        action="store_true",
        help="Use a synthetic AgentSessionEvent instead of requiring the Linear issue to be delegated to the app user.",
    )
    arg_parser.add_argument("--timeout", type=int, default=420)
    return arg_parser


def main() -> int:
    args = parser().parse_args()
    try:
        report = asyncio.run(run(args))
    except Exception as exc:
        print(f"real_symphony_e2e failed: {exc!r}", file=sys.stderr)
        return 1
    print(json.dumps(e2e_report_summary(report, report_path=args.out / "real-symphony-e2e-report.json"), indent=2))
    return 0 if not report["failures"] else 2


def e2e_report_summary(report: dict[str, Any], *, report_path: Path) -> dict[str, Any]:
    failures = [failure for failure in report.get("failures", []) if isinstance(failure, dict)]
    return {
        "report": str(report_path),
        "failures": len(failures),
        "failure_summaries": [_failure_summary(failure) for failure in failures[:5]],
    }


def _failure_summary(failure: dict[str, Any]) -> dict[str, Any]:
    summary: dict[str, Any] = {"name": failure.get("name")}
    for key in ["failure", "error", "reason", "status", "body", "process_status"]:
        if key in failure:
            summary[key] = failure[key]
    return summary


if __name__ == "__main__":
    raise SystemExit(main())
