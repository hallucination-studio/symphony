from __future__ import annotations

from pathlib import Path

import pytest

from podium.desktop_app import DesktopLifecycle
from podium.desktop_commands import CommandError, dispatch_command
from podium.desktop_health import handle_request


def lifecycle(tmp_path: Path) -> DesktopLifecycle:
    value = DesktopLifecycle(tmp_path / "app-data")
    value.start()
    return value


def test_lifecycle_snapshot_has_an_exact_secret_free_schema(tmp_path: Path) -> None:
    app = lifecycle(tmp_path)

    assert dispatch_command("lifecycle.snapshot", {}, app) == {
        "status": "ready",
        "installation_status": "not_installed",
        "error_code": None,
        "sanitized_reason": None,
        "action_required": False,
        "retryable": False,
        "next_action": "none",
    }


@pytest.mark.parametrize(
    "command,input_value,error_code",
    [
        ("shell.execute", {}, "desktop_command_unsupported"),
        ("url.open", {"url": "https://example.test"}, "desktop_command_unsupported"),
        ("sql.query", {"sql": "SELECT * FROM linear_installations"}, "desktop_command_unsupported"),
        ("lifecycle.snapshot", {"path": "/tmp/podium.db"}, "desktop_command_input_invalid"),
    ],
)
def test_dispatcher_rejects_unapproved_commands_and_inputs(
    tmp_path: Path, command: str, input_value: dict[str, str], error_code: str
) -> None:
    app = lifecycle(tmp_path)

    with pytest.raises(CommandError) as raised:
        dispatch_command(command, input_value, app)

    assert raised.value.code == error_code
    assert "token" not in raised.value.to_dict()


def test_protocol_returns_one_sanitized_command_error_shape(tmp_path: Path) -> None:
    app = lifecycle(tmp_path)
    response, stopping = handle_request(
        {
            "kind": "command",
            "request_id": "command-1",
            "protocol_version": 1,
            "command": "shell.execute",
            "input": {},
        },
        app,
    )

    assert stopping is False
    assert response == {
        "kind": "command.result",
        "request_id": "command-1",
        "protocol_version": 1,
        "command": "unknown",
        "ok": False,
        "error": {
            "code": "desktop_command_unsupported",
            "sanitized_reason": "command_unsupported",
            "action_required": False,
            "retryable": False,
            "next_action": "none",
        },
    }


def test_protocol_never_reflects_raw_command_or_request_id(tmp_path: Path) -> None:
    app = lifecycle(tmp_path)
    sentinel = "token_secret_path_tmp"
    response, _ = handle_request(
        {
            "kind": "command",
            "request_id": "safe-request",
            "protocol_version": 1,
            "command": sentinel,
            "input": {},
        },
        app,
    )
    assert response["command"] == "unknown"
    assert sentinel not in str(response)

    with pytest.raises(ValueError, match="request_invalid"):
        handle_request(
            {
                "kind": "command",
                "request_id": "x" * 201,
                "protocol_version": 1,
                "command": "lifecycle.snapshot",
                "input": {},
            },
            app,
        )
