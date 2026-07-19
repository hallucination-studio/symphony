from __future__ import annotations

import json
import os
import re
import sys
from collections.abc import Callable, Mapping, Sequence
from typing import Any
from uuid import uuid4

from contracts import decode_contract


AGENT_CONTRACT = "https://symphony.local/contracts/agent-command.schema.json#/$defs/"
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
MAX_FRAME_BYTES = 65_536


def run_command(
    arguments: Sequence[str],
    *,
    environment: Mapping[str, str] = os.environ,
    request_fd: int = 3,
    response_fd: int = 4,
    request_id: Callable[[], str] = lambda: f"broker-{uuid4()}",
) -> dict[str, Any]:
    try:
        separator = arguments.index("--args-json")
    except ValueError as error:
        raise ValueError("agent_command_arguments_invalid") from error
    if separator < 1 or separator != len(arguments) - 2:
        raise ValueError("agent_command_arguments_invalid")
    command_path = " ".join(arguments[:separator])
    catalog = _catalog(environment.get("SYMPHONY_AGENT_COMMAND_CATALOG"))
    command_name = catalog.get(command_path)
    if command_name is None:
        raise ValueError("agent_command_unknown")
    try:
        args = json.loads(arguments[-1])
    except (json.JSONDecodeError, TypeError) as error:
        raise ValueError("agent_command_arguments_invalid") from error
    correlation = {
        "protocol_version": "1",
        "request_id": _identifier(request_id(), "agent_command_request_id_invalid"),
        "turn_id": _environment_identifier(environment, "SYMPHONY_TURN_ID"),
        "root_issue_id": _environment_identifier(environment, "SYMPHONY_ROOT_ISSUE_ID"),
        "performer_id": _environment_identifier(environment, "SYMPHONY_PERFORMER_ID"),
    }
    request = _decode("AgentCommandRequest", {
        **correlation, "command": command_name, "args": args,
    })
    frame = json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(frame) > MAX_FRAME_BYTES:
        raise ValueError("agent_command_frame_too_large")
    with os.fdopen(os.dup(request_fd), "wb", closefd=True) as requests:
        requests.write(frame)
        requests.flush()
    with os.fdopen(os.dup(response_fd), "rb", closefd=True) as responses:
        response_frame = responses.readline(MAX_FRAME_BYTES + 1)
    if not response_frame.endswith(b"\n") or len(response_frame) > MAX_FRAME_BYTES:
        raise ValueError("agent_command_response_invalid")
    try:
        result = _decode("AgentCommandResult", json.loads(response_frame))
    except json.JSONDecodeError as error:
        raise ValueError("agent_command_response_invalid") from error
    if any(result.get(key) != value for key, value in correlation.items()):
        raise ValueError("agent_command_response_correlation_invalid")
    return result


def main() -> None:
    try:
        result = run_command(sys.argv[1:])
    except (OSError, ValueError):
        print("symphony command failed", file=sys.stderr)
        raise SystemExit(2) from None
    print(json.dumps(result, separators=(",", ":")))


def _catalog(raw: str | None) -> dict[str, str]:
    if raw is None or len(raw.encode("utf-8")) > 16_384:
        raise ValueError("agent_command_catalog_invalid")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError("agent_command_catalog_invalid") from error
    if not isinstance(value, dict) or not 1 <= len(value) <= 32:
        raise ValueError("agent_command_catalog_invalid")
    if not all(
        isinstance(key, str) and IDENTIFIER.fullmatch(key.replace(" ", "."))
        and isinstance(item, str) and IDENTIFIER.fullmatch(item)
        for key, item in value.items()
    ):
        raise ValueError("agent_command_catalog_invalid")
    return value


def _environment_identifier(environment: Mapping[str, str], key: str) -> str:
    return _identifier(environment.get(key), "agent_command_environment_invalid")


def _identifier(value: object, code: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ValueError(code)
    return value


def _decode(name: str, value: object) -> dict[str, Any]:
    try:
        decoded = decode_contract(f"{AGENT_CONTRACT}{name}", value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"agent_{name.lower()}_invalid") from error
    if not isinstance(decoded, dict):
        raise ValueError(f"agent_{name.lower()}_invalid")
    return decoded


if __name__ == "__main__":
    main()
