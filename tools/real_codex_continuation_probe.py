from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from performer.codex_client import CodexSdkClient
from performer_api.config import CodexConfig


def probe_prompt(message: str) -> str:
    return (
        f"{message}\n\n"
        "Return only the structured result object required by Performer. "
        "Use summary to describe this continuation probe step, test_commands as an empty list, "
        "changed_files as an empty list, remaining_risks as an empty list, "
        "and next_action set to ready_for_review."
    )


def summarize_probe(result: Any, events: list[dict[str, Any]], continuation_calls: list[int]) -> dict[str, Any]:
    turn_started = [event for event in events if event.get("event") == "turn_started"]
    turn_completed = [event for event in events if event.get("event") == "turn_completed"]
    thread_ids = {
        str(event.get("thread_id") or "")
        for event in turn_started + turn_completed
        if str(event.get("thread_id") or "")
    }
    same_thread = len(thread_ids) == 1 and result.thread_id in thread_ids
    structured_ok = (
        isinstance(result.structured_result, dict)
        and result.structured_result.get("next_action") == "ready_for_review"
    )
    return {
        "pass": bool(
            result.success
            and result.turn_count == 2
            and continuation_calls == [1]
            and len(turn_started) == 2
            and len(turn_completed) == 2
            and same_thread
            and structured_ok
        ),
        "thread_id": result.thread_id,
        "turn_count": result.turn_count,
        "turn_started_count": len(turn_started),
        "turn_completed_count": len(turn_completed),
        "same_thread": same_thread,
        "continuation_calls": continuation_calls,
        "turn_started": turn_started,
        "turn_completed": turn_completed,
        "event_names": [str(event.get("event") or "") for event in events],
        "structured_next_action": result.structured_result.get("next_action") if structured_ok else None,
    }


async def run_probe(args: argparse.Namespace) -> dict[str, Any]:
    workspace = args.workspace.resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    events: list[dict[str, Any]] = []
    continuation_calls: list[int] = []

    def continuation_provider(turn_count: int) -> str | None:
        continuation_calls.append(turn_count)
        if turn_count == 1:
            return probe_prompt("codex continuation probe second turn")
        return None

    client = CodexSdkClient(
        CodexConfig(
            model=args.model,
            sdk_codex_bin=args.sdk_codex_bin,
            sandbox=args.sandbox,
            read_timeout_ms=args.read_timeout_ms,
            turn_timeout_ms=args.turn_timeout_ms,
            hard_turn_timeout_ms=args.turn_timeout_ms,
        )
    )
    result = await client.run_session(
        workspace,
        probe_prompt("codex continuation probe first turn"),
        "codex-continuation-probe",
        on_event=events.append,
        max_turns=2,
        continuation_provider=continuation_provider,
    )
    summary = summarize_probe(result, events, continuation_calls)
    summary["workspace"] = str(workspace)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    return summary


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Run a real Codex SDK same-thread continuation probe.")
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
