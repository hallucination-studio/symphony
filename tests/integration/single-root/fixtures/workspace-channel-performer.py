from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from performer.command_broker.workspace_channel import WorkspaceCommandChannel


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--open-conversation-request-path", type=Path)
    parser.add_argument("--open-conversation-result-path", type=Path)
    parser.add_argument("--root-turn-result-path", type=Path)
    parser.add_argument("--turn-id")
    parser.add_argument("--root-issue-id")
    parser.add_argument("--performer-profile-id")
    parser.add_argument("--performer-id")
    parser.add_argument("--context-digest")
    arguments = parser.parse_args()
    if arguments.open_conversation_request_path:
        request = json.loads(arguments.open_conversation_request_path.read_text())
        _atomic_write(arguments.open_conversation_result_path, {
            "protocol_version": request["protocol_version"], "request_id": request["request_id"],
            "performer_profile_id": request["performer_profile_id"],
            "performer_id": "conversation-1", "completed_at": "2026-07-19T00:00:01Z",
        })
        start = json.loads(sys.stdin.buffer.readline())
        correlation = _correlation(start)
        result_path = Path(start["result_path"])
    else:
        correlation = {
            "protocol_version": "1", "turn_id": arguments.turn_id,
            "root_issue_id": arguments.root_issue_id,
            "performer_profile_id": arguments.performer_profile_id,
            "performer_id": arguments.performer_id, "context_digest": arguments.context_digest,
        }
        result_path = arguments.root_turn_result_path
    _ready(correlation)
    command = json.loads(sys.stdin.read())
    if _correlation(command) != correlation:
        raise SystemExit("command correlation mismatch")
    with WorkspaceCommandChannel(command):
        results = [_invoke(command, path, args) for path, args in _commands(command)]
    if any(result["status"] not in {"read", "applied", "already_applied"} for result in results):
        raise SystemExit("broker command failed")
    context = command["root_context"]
    _atomic_write(result_path, {
        **correlation, "result_kind": "root_turn_completed",
        **({"yield_reason": _yield_reason(command)} if _is_flow() else {}),
        "completed_at": "2026-07-19T00:00:02Z",
        "turn_usage": {"wall_time_ms": 1,
            "context_bytes": len(context["json"].encode()) + len(context["markdown"].encode()),
            "provider_tokens": 0, "broker_calls": 0, "mutations": 0},
    })


def _commands(command: dict[str, Any]) -> list[tuple[list[str], dict[str, Any]]]:
    if not _is_flow():
        return [(["linear", "status", "set"], {"issue_id": "root-1", "status": "In Progress",
            "expected_remote_version": "version-1", "expected_git_head": "abc"})]
    commands: list[tuple[list[str], dict[str, Any]]] = [
        (["linear", "read"], {"issue_id": "root-1", "include": ["issue"]}),
    ]
    if '"answer":"Approved"' not in command["root_context"]["json"]:
        return commands
    return commands + [
        (["linear", "issue", "create-child"], {"parent_issue_id": "root-1", "kind": "work",
         "title": "Implementation", "description": "Build the change", "write_id": "work-write",
         "expected_remote_version": "version-1", "expected_git_head": "abc"}),
        (["linear", "issue", "create-child"], {"parent_issue_id": "root-1", "kind": "rework",
         "title": "[Rework] Root Gate Findings", "description": "Address the failed Gate",
         "write_id": "rework-write", "expected_remote_version": "version-1",
         "expected_git_head": "abc"}),
        (["linear", "status", "set"], {"issue_id": "child-1", "status": "Done",
         "expected_remote_version": "version-2", "expected_git_head": "abc"}),
        (["linear", "comment", "create"], {"issue_id": "child-1",
         "body": "Human approval observed; Work and Gate passed.", "write_id": "write-1",
         "expected_remote_version": "version-2", "expected_git_head": "abc"}),
        (["git", "commit"], {"issue_id": "child-1", "expected_remote_version": "version-2",
         "expected_head": "abc"}),
        (["root", "deliver"], {"expected_root_version": "version-1", "expected_head": "abc"}),
    ]


def _invoke(command: dict[str, Any], path: list[str], args: dict[str, Any]) -> dict[str, Any]:
    completed = subprocess.run(
        ["symphony", *path, "--args-json", json.dumps(args, separators=(",", ":"))],
        cwd=command["workspace_root"], capture_output=True, text=True, check=False,
    )
    if completed.returncode != 0:
        raise SystemExit(completed.stderr.strip() or "symphony command failed")
    return json.loads(completed.stdout)


def _ready(correlation: dict[str, Any]) -> None:
    print(json.dumps({**correlation, "sequence": 0, "occurred_at": "2026-07-19T00:00:01Z",
        "body": {"kind": "protocol_ready"}}, separators=(",", ":")), flush=True)


def _correlation(value: dict[str, Any]) -> dict[str, Any]:
    return {key: value[key] for key in ("protocol_version", "turn_id", "root_issue_id",
        "performer_profile_id", "performer_id", "context_digest")}


def _atomic_write(path: Path | None, value: dict[str, Any]) -> None:
    if path is None:
        raise SystemExit("result path missing")
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")))
    os.replace(temporary, path)


def _is_flow() -> bool:
    return os.environ.get("SYMPHONY_TEST_PERFORMER_MODE") == "flow"


def _yield_reason(command: dict[str, Any]) -> str:
    return "delivered" if '"answer":"Approved"' in command["root_context"]["json"] else "waiting_human"


if __name__ == "__main__":
    main()
