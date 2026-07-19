from __future__ import annotations

import json
import os
import select
import threading

from performer.command_broker.cli import run_command


def test_symphony_cli_round_trips_one_correlated_command_over_inherited_fds() -> None:
    request_read, request_write = os.pipe()
    response_read, response_write = os.pipe()
    observed: list[dict[str, object]] = []

    def broker() -> None:
        with os.fdopen(request_read, "rb", closefd=True) as requests:
            request = json.loads(requests.readline())
        observed.append(request)
        result = {
            **{key: request[key] for key in (
                "protocol_version", "request_id", "turn_id", "root_issue_id", "performer_id"
            )},
            "status": "applied",
            "summary": "Mutation applied.",
        }
        with os.fdopen(response_write, "wb", closefd=True) as responses:
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
            "SYMPHONY_TURN_ID": "turn-1",
            "SYMPHONY_ROOT_ISSUE_ID": "root-1",
            "SYMPHONY_PERFORMER_ID": "conversation-1",
        },
        request_fd=request_write,
        response_fd=response_read,
        request_id=lambda: "request-1",
    )
    worker.join(timeout=1)
    os.close(request_write)
    os.close(response_read)

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


def test_symphony_cli_rejects_unknown_commands_before_writing() -> None:
    request_read, request_write = os.pipe()
    response_read, response_write = os.pipe()
    try:
        try:
            run_command(
                ["linear", "unknown", "--args-json", "{}"],
                environment={
                    "SYMPHONY_AGENT_COMMAND_CATALOG": json.dumps({
                        "linear status set": "linear.status.set",
                    }),
                    "SYMPHONY_TURN_ID": "turn-1",
                    "SYMPHONY_ROOT_ISSUE_ID": "root-1",
                    "SYMPHONY_PERFORMER_ID": "conversation-1",
                },
                request_fd=request_write,
                response_fd=response_read,
            )
        except ValueError as error:
            assert str(error) == "agent_command_unknown"
        else:
            raise AssertionError("unknown command was accepted")
        assert select.select([request_read], [], [], 0)[0] == []
    finally:
        for descriptor in (request_read, request_write, response_read, response_write):
            os.close(descriptor)
