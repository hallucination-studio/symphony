from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from performer.command_broker.cli import run_command


def test_symphony_cli_round_trips_one_correlated_command_over_workspace_fifos(
    tmp_path: Path,
) -> None:
    channel = tmp_path / ".symphony" / "agent-command"
    channel.mkdir(parents=True, mode=0o700)
    request_path = channel / "request.fifo"
    response_path = channel / "response.fifo"
    os.mkfifo(request_path, 0o600)
    os.mkfifo(response_path, 0o600)
    (channel / "metadata.json").write_text(json.dumps({
        "protocol_version": "1",
        "turn_id": "turn-1",
        "root_issue_id": "root-1",
        "performer_id": "conversation-1",
        "request_path": ".symphony/agent-command/request.fifo",
        "response_path": ".symphony/agent-command/response.fifo",
    }), encoding="utf-8")
    os.chmod(channel / "metadata.json", 0o600)
    observed: list[dict[str, object]] = []

    def broker() -> None:
        with request_path.open("rb") as requests:
            request = json.loads(requests.readline())
        observed.append(request)
        result = {
            **{key: request[key] for key in (
                "protocol_version", "request_id", "turn_id", "root_issue_id", "performer_id"
            )},
            "status": "applied",
            "summary": "Mutation applied.",
        }
        with response_path.open("wb") as responses:
            responses.write(json.dumps(result, separators=(",", ":")).encode() + b"\n")

    worker = threading.Thread(target=broker)
    worker.start()
    result = run_command(
        ["linear", "status", "set", "--args-json", json.dumps({
            "issue_id": "work-1", "status": "In Progress",
            "expected_remote_version": "version-1", "expected_git_head": "abc123",
        })],
        environment={
            "SYMPHONY_AGENT_COMMAND_CATALOG": json.dumps({
                "linear status set": "linear.status.set",
            }),
        },
        working_directory=tmp_path,
        request_id=lambda: "request-1",
    )
    worker.join(timeout=1)
    assert worker.is_alive() is False

    assert result["status"] == "applied"
    assert observed == [{
        "protocol_version": "1", "request_id": "request-1", "turn_id": "turn-1",
        "root_issue_id": "root-1", "performer_id": "conversation-1",
        "command": "linear.status.set",
        "args": {
            "issue_id": "work-1", "status": "In Progress",
            "expected_remote_version": "version-1", "expected_git_head": "abc123",
        },
    }]


def test_symphony_cli_rejects_unknown_commands_before_opening_channel(
    tmp_path: Path,
) -> None:
    try:
        run_command(
            ["linear", "unknown", "--args-json", "{}"],
            environment={
                "SYMPHONY_AGENT_COMMAND_CATALOG": json.dumps({
                    "linear status set": "linear.status.set",
                }),
            },
            working_directory=tmp_path,
        )
    except ValueError as error:
        assert str(error) == "agent_command_unknown"
    else:
        raise AssertionError("unknown command was accepted")
    assert (tmp_path / ".symphony").exists() is False
