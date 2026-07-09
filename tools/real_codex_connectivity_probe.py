from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from real_codex_connectivity_core import (
    CONNECTIVITY_SCHEMA,
    PLANNER_SHAPED_SCHEMA,
    SECRET_PATTERNS,
    ProbeSpec,
    _contains_secret,
    _first_http_status,
    _planner_shape_valid,
    classify_connectivity,
    extract_probe_structured_result,
    planner_shaped_probe_prompt,
    probe_prompt,
    probe_spec,
    sanitize_text,
    sanitize_value,
    scenario_passed,
    summarize_events,
)
from real_codex_connectivity_run import run_probe


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Run a real Codex SDK connectivity probe.")
    arg_parser.add_argument("--workspace", type=Path, required=True)
    arg_parser.add_argument("--codex-home", type=Path)
    arg_parser.add_argument("--out", type=Path)
    arg_parser.add_argument("--probe-kind", choices=["minimal", "planner-shaped"], default="minimal")
    arg_parser.add_argument(
        "--expected",
        choices=["connected", "planner_shape_invalid", "upstream_unavailable", "auth_failed", "timeout", "codex_error", "unexpected_error"],
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
