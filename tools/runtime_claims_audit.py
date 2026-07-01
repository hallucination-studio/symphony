from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


DISPATCH_COUNTS = re.compile(r"running=(?P<running>\d+)\s+claimed=(?P<claimed>\d+)")


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, dict) else {}


def audit_runtime_state(state: dict[str, Any], log_text: str = "") -> dict[str, Any]:
    sessions = _list(state.get("sessions"))
    retries = _list(state.get("retry_attempts"))
    continuations = _list(state.get("continuations"))
    failures: list[str] = []
    warnings: list[str] = []

    for retry in retries:
        if retry.get("error") is None:
            failures.append(f"retry_without_error:{retry.get('identifier') or retry.get('issue_identifier')}")
        if retry.get("phase") not in {None, "retrying"}:
            warnings.append(f"retry_unexpected_phase:{retry.get('identifier')}:{retry.get('phase')}")

    for continuation in continuations:
        if continuation.get("phase") not in {None, "continuing"}:
            failures.append(f"continuation_unexpected_phase:{continuation.get('identifier')}:{continuation.get('phase')}")
        status_label = continuation.get("status_label")
        if status_label not in {None, "performer:continuing"}:
            failures.append(f"continuation_unexpected_label:{continuation.get('identifier')}:{status_label}")

    repeated_claim_stalls = _claim_stalls(log_text)
    if repeated_claim_stalls:
        failures.append("log_repeated_running_0_claimed_positive")

    return {
        "counts": {
            "sessions": len(sessions),
            "retry_attempts": len(retries),
            "continuations": len(continuations),
            "log_claim_stalls": len(repeated_claim_stalls),
        },
        "sessions": [_session_row(session) for session in sessions],
        "retry_attempts": [_scheduled_row(retry) for retry in retries],
        "continuations": [_scheduled_row(continuation) for continuation in continuations],
        "log_claim_stalls": repeated_claim_stalls,
        "warnings": warnings,
        "failures": failures,
        "pass": not failures,
    }


def _claim_stalls(log_text: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in log_text.splitlines():
        match = DISPATCH_COUNTS.search(line)
        if not match:
            continue
        running = int(match.group("running"))
        claimed = int(match.group("claimed"))
        if running == 0 and claimed > 0:
            rows.append({"running": running, "claimed": claimed, "line": line[-500:]})
    return rows


def _list(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _session_row(session: dict[str, Any]) -> dict[str, Any]:
    return {
        "issue_id": session.get("issue_id"),
        "issue_identifier": session.get("issue_identifier"),
        "phase": session.get("phase"),
        "status_label": session.get("status_label"),
        "turn_count": session.get("turn_count"),
        "last_event": session.get("last_event"),
        "last_message": session.get("last_message"),
    }


def _scheduled_row(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "issue_id": entry.get("issue_id"),
        "identifier": entry.get("identifier") or entry.get("issue_identifier"),
        "attempt": entry.get("attempt"),
        "error": entry.get("error"),
        "phase": entry.get("phase"),
        "status_label": entry.get("status_label"),
        "last_message": entry.get("last_message"),
    }


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Audit Performer persisted runtime for retry/continuation problems.")
    arg_parser.add_argument("--state", type=Path, required=True, help="Path to state/performer.json")
    arg_parser.add_argument("--log", type=Path, help="Optional path to logs/performer.log")
    arg_parser.add_argument("--out", type=Path, help="Write JSON evidence to this path.")
    return arg_parser


def main() -> None:
    args = parser().parse_args()
    log_text = args.log.read_text(encoding="utf-8", errors="replace") if args.log and args.log.exists() else ""
    result = audit_runtime_state(load_json(args.state), log_text)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps(result, indent=2, sort_keys=True))
    if not result["pass"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
