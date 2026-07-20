from __future__ import annotations

import json
import os
import re
import stat
import sys
from pathlib import Path
from collections.abc import Callable, Mapping, Sequence
from typing import Any
from uuid import uuid4

import fcntl

from contracts import decode_contract


AGENT_CONTRACT = "https://symphony.local/contracts/agent-command.schema.json#/$defs/"
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
MAX_FRAME_BYTES = 65_536
CHANNEL_METADATA_PATH = Path(".symphony/agent-command/metadata.json")


def run_command(
    arguments: Sequence[str],
    *,
    environment: Mapping[str, str] = os.environ,
    working_directory: Path | None = None,
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
    root = working_directory or Path.cwd()
    metadata_fd = _open_owned(root / CHANNEL_METADATA_PATH, regular=True)
    try:
        fcntl.flock(metadata_fd, fcntl.LOCK_EX)
        metadata = _read_metadata(metadata_fd)
        correlation = {
            "protocol_version": metadata["protocol_version"],
            "request_id": _identifier(request_id(), "agent_command_request_id_invalid"),
            "turn_id": metadata["turn_id"],
            "root_issue_id": metadata["root_issue_id"],
            "performer_id": metadata["performer_id"],
        }
        request = _decode("AgentCommandRequest", {
            **correlation, "command": command_name, "args": args,
        })
        frame = json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
        if len(frame) > MAX_FRAME_BYTES:
            raise ValueError("agent_command_frame_too_large")
        request_fd = _open_owned(root / metadata["request_path"], regular=False)
        try:
            _write_all(request_fd, frame)
        finally:
            os.close(request_fd)
        response_fd = _open_owned(root / metadata["response_path"], regular=False, write=False)
        with os.fdopen(response_fd, "rb", closefd=True) as responses:
            response_frame = responses.readline(MAX_FRAME_BYTES + 1)
    finally:
        os.close(metadata_fd)
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


def _read_metadata(descriptor: int) -> dict[str, Any]:
    os.lseek(descriptor, 0, os.SEEK_SET)
    raw = os.read(descriptor, MAX_FRAME_BYTES + 1)
    if len(raw) > MAX_FRAME_BYTES:
        raise ValueError("agent_command_channel_metadata_invalid")
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValueError("agent_command_channel_metadata_invalid") from error
    return _decode("AgentCommandChannelMetadata", value)


def _open_owned(path: Path, *, regular: bool, write: bool = True) -> int:
    flags = os.O_WRONLY if write and not regular else os.O_RDONLY
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        facts = os.fstat(descriptor)
        expected = stat.S_ISREG(facts.st_mode) if regular else stat.S_ISFIFO(facts.st_mode)
        if not expected or facts.st_uid != os.getuid() or facts.st_mode & 0o077:
            raise ValueError("agent_command_channel_invalid")
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _write_all(descriptor: int, value: bytes) -> None:
    offset = 0
    while offset < len(value):
        written = os.write(descriptor, value[offset:])
        if written <= 0:
            raise OSError("agent_command_channel_write_failed")
        offset += written


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
