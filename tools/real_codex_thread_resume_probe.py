from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from performer.codex_client import CodexSdkClient
from performer.codex_config import CodexConfig


def summarize_probe(
    *,
    first_thread_id: str,
    resumed_thread_id: str,
    fallback_requested_thread_id: str,
    fallback_thread_id: str,
    fallback_events: list[dict[str, Any]],
) -> dict[str, Any]:
    resume_same_thread = bool(first_thread_id) and resumed_thread_id == first_thread_id
    fallback_recorded = any(
        event.get("event") == "thread_resume_failed" and event.get("thread_id") == fallback_requested_thread_id
        for event in fallback_events
    )
    fallback_started_new_thread = bool(fallback_thread_id) and fallback_thread_id != fallback_requested_thread_id
    return {
        "pass": resume_same_thread and fallback_recorded and fallback_started_new_thread,
        "resume_same_thread": resume_same_thread,
        "fallback_recorded": fallback_recorded,
        "fallback_started_new_thread": fallback_started_new_thread,
        "first_thread_id": first_thread_id,
        "resumed_thread_id": resumed_thread_id,
        "fallback_requested_thread_id": fallback_requested_thread_id,
        "fallback_thread_id": fallback_thread_id,
        "fallback_event_names": [str(event.get("event") or "") for event in fallback_events],
    }


def probe_prompt(message: str) -> str:
    return (
        f"{message}\n\n"
        "Return only the structured result object required by Performer. "
        "Use summary to describe this probe step, test_commands as an empty list, "
        "changed_files as an empty list, remaining_risks as an empty list, "
        "and next_action set to ready_for_review."
    )


async def run_probe(args: argparse.Namespace) -> dict[str, Any]:
    workspace = args.workspace.resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    client = CodexSdkClient(
        CodexConfig(
            model=args.model,
            sdk_codex_bin=args.sdk_codex_bin,
            sandbox=args.sandbox,
            read_timeout_ms=args.read_timeout_ms,
            hard_turn_timeout_ms=args.turn_timeout_ms,
        )
    )

    first = await client.run_session(
        workspace,
        probe_prompt("thread resume probe start"),
        "thread-resume-probe-start",
    )
    resumed_events: list[dict[str, Any]] = []
    resumed = await client.run_session(
        workspace,
        probe_prompt("thread resume probe resumed"),
        "thread-resume-probe-resume",
        existing_thread_id=first.thread_id,
        on_event=resumed_events.append,
    )

    fallback_requested = f"missing-{first.thread_id}"
    fallback_events: list[dict[str, Any]] = []
    fallback = await client.run_session(
        workspace,
        probe_prompt("thread resume probe rebuilt"),
        "thread-resume-probe-fallback",
        existing_thread_id=fallback_requested,
        on_event=fallback_events.append,
    )

    summary = summarize_probe(
        first_thread_id=first.thread_id,
        resumed_thread_id=resumed.thread_id,
        fallback_requested_thread_id=fallback_requested,
        fallback_thread_id=fallback.thread_id,
        fallback_events=fallback_events,
    )
    summary["workspace"] = str(workspace)
    summary["resumed_event_names"] = [str(event.get("event") or "") for event in resumed_events]
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    return summary


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Run a real Codex SDK thread resume and fallback probe.")
    arg_parser.add_argument("--workspace", type=Path, required=True)
    arg_parser.add_argument("--out", type=Path)
    arg_parser.add_argument("--model")
    arg_parser.add_argument("--sdk-codex-bin")
    arg_parser.add_argument("--sandbox")
    arg_parser.add_argument("--read-timeout-ms", type=int, default=30_000)
    arg_parser.add_argument("--turn-timeout-ms", type=int, default=180_000)
    return arg_parser


def main() -> int:
    args = parser().parse_args()
    summary = asyncio.run(run_probe(args))
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if summary["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
