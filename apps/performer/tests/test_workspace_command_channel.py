from __future__ import annotations

import json
import os
import threading
from pathlib import Path

import pytest

from performer.command_broker.cli import run_command
from performer.command_broker.workspace_channel import WorkspaceCommandChannel


def test_workspace_channel_bridges_one_correlated_command_and_cleans_up(
    root_command: dict[str, object],
    tmp_path: Path,
) -> None:
    command = {**root_command, "workspace_root": str(tmp_path)}
    request_read, request_write = os.pipe()
    response_read, response_write = os.pipe()
    observed: list[dict[str, object]] = []

    def conductor() -> None:
        with os.fdopen(request_read, "rb", closefd=True) as requests:
            request = json.loads(requests.readline())
        observed.append(request)
        result = {
            **{key: request[key] for key in (
                "protocol_version", "request_id", "turn_id", "root_issue_id", "performer_id"
            )},
            "status": "read",
            "summary": "Fresh facts returned.",
        }
        with os.fdopen(response_write, "wb", closefd=True) as responses:
            responses.write(json.dumps(result, separators=(",", ":")).encode() + b"\n")

    worker = threading.Thread(target=conductor)
    worker.start()
    try:
        with WorkspaceCommandChannel(
            command, request_fd=request_write, response_fd=response_read
        ):
            metadata_path = tmp_path / ".symphony/agent-command/metadata.json"
            assert metadata_path.stat().st_mode & 0o777 == 0o600
            result = run_command(
                ["linear", "read", "--args-json", json.dumps({
                    "issue_id": "root-1", "include": ["issue"],
                })],
                environment={
                    "SYMPHONY_AGENT_COMMAND_CATALOG": json.dumps({
                        "linear read": "linear.read",
                    }),
                },
                working_directory=tmp_path,
                request_id=lambda: "request-1",
            )
        worker.join(timeout=1)
        assert worker.is_alive() is False
        assert result["status"] == "read"
        assert observed[0]["turn_id"] == command["turn_id"]
        assert observed[0]["root_issue_id"] == command["root_issue_id"]
        assert observed[0]["performer_id"] == command["performer_id"]
        assert (tmp_path / ".symphony").exists() is False
    finally:
        os.close(request_write)
        os.close(response_read)


def test_workspace_channel_rejects_a_symlinked_channel_directory(
    root_command: dict[str, object],
    tmp_path: Path,
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    symphony = tmp_path / ".symphony"
    symphony.mkdir(mode=0o700)
    (symphony / "agent-command").symlink_to(outside, target_is_directory=True)
    command = {**root_command, "workspace_root": str(tmp_path)}
    request_read, request_write = os.pipe()
    response_read, response_write = os.pipe()
    try:
        with pytest.raises(ValueError, match="agent_command_channel_invalid"):
            with WorkspaceCommandChannel(
                command, request_fd=request_write, response_fd=response_read
            ):
                pass
    finally:
        for descriptor in (request_read, request_write, response_read, response_write):
            os.close(descriptor)
