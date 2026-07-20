from __future__ import annotations

import json
import os
import select
import stat
import threading
from pathlib import Path
from types import TracebackType
from typing import Any

from contracts import decode_contract

from performer.contracts import validate


MAX_FRAME_BYTES = 65_536
AGENT_CONTRACT = "https://symphony.local/contracts/agent-command.schema.json#/$defs/"
CHANNEL_DIRECTORY = Path(".symphony/agent-command")
METADATA_NAME = "metadata.json"
REQUEST_NAME = "request.fifo"
RESPONSE_NAME = "response.fifo"


class WorkspaceCommandChannel:
    def __init__(
        self,
        command: dict[str, Any],
        *,
        request_fd: int = 3,
        response_fd: int = 4,
    ) -> None:
        self._command = validate("RootTurnCommand", command)
        self._workspace = Path(self._command["workspace_root"])
        self._request_fd = request_fd
        self._response_fd = response_fd
        self._channel = self._workspace / CHANNEL_DIRECTORY
        self._fifo_request_fd: int | None = None
        self._fifo_response_fd: int | None = None
        self._stop_read_fd: int | None = None
        self._stop_write_fd: int | None = None
        self._worker: threading.Thread | None = None
        self._worker_error: BaseException | None = None

    def __enter__(self) -> WorkspaceCommandChannel:
        try:
            self._prepare_files()
            self._fifo_request_fd = _open_fifo(self._channel / REQUEST_NAME)
            self._fifo_response_fd = _open_fifo(self._channel / RESPONSE_NAME)
            self._stop_read_fd, self._stop_write_fd = os.pipe()
            self._worker = threading.Thread(
                target=self._forward,
                name="workspace-agent-command-channel",
                daemon=True,
            )
            self._worker.start()
            return self
        except Exception:
            self._close_descriptors()
            self._clean_files()
            raise

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool:
        if self._stop_write_fd is not None:
            try:
                os.write(self._stop_write_fd, b"x")
            except OSError:
                pass
        if self._worker is not None:
            self._worker.join(timeout=2)
        worker_stopped = self._worker is None or not self._worker.is_alive()
        self._close_descriptors()
        self._clean_files()
        if exc_type is None:
            if not worker_stopped:
                raise ValueError("agent_command_channel_stop_failed")
            if self._worker_error is not None:
                raise ValueError("agent_command_channel_forwarding_failed") from self._worker_error
        return False

    def _prepare_files(self) -> None:
        _ensure_owned_directory(self._workspace)
        symphony = self._workspace / ".symphony"
        _ensure_or_create_directory(symphony)
        _ensure_or_create_directory(self._channel)
        allowed = {METADATA_NAME, REQUEST_NAME, RESPONSE_NAME, ".metadata.tmp"}
        for entry in self._channel.iterdir():
            if entry.name not in allowed:
                raise ValueError("agent_command_channel_invalid")
            _unlink_owned_artifact(entry)
        for name in (REQUEST_NAME, RESPONSE_NAME):
            os.mkfifo(self._channel / name, 0o600)
        metadata = decode_contract(
            f"{AGENT_CONTRACT}AgentCommandChannelMetadata",
            {
                "protocol_version": self._command["protocol_version"],
                "turn_id": self._command["turn_id"],
                "root_issue_id": self._command["root_issue_id"],
                "performer_id": self._command["performer_id"],
                "request_path": str(CHANNEL_DIRECTORY / REQUEST_NAME),
                "response_path": str(CHANNEL_DIRECTORY / RESPONSE_NAME),
            },
        )
        temporary = self._channel / ".metadata.tmp"
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        try:
            _write_all(
                descriptor,
                json.dumps(metadata, separators=(",", ":")).encode("utf-8"),
            )
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, self._channel / METADATA_NAME)

    def _forward(self) -> None:
        try:
            assert self._fifo_request_fd is not None
            assert self._fifo_response_fd is not None
            assert self._stop_read_fd is not None
            while True:
                request = _read_frame(self._fifo_request_fd, self._stop_read_fd)
                if request is None:
                    return
                _write_all(self._request_fd, request)
                response = _read_frame(self._response_fd, self._stop_read_fd)
                if response is None:
                    return
                if not _write_all(
                    self._fifo_response_fd, response, stop_fd=self._stop_read_fd
                ):
                    return
        except BaseException as error:
            self._worker_error = error

    def _close_descriptors(self) -> None:
        for attribute in (
            "_fifo_request_fd", "_fifo_response_fd", "_stop_read_fd", "_stop_write_fd"
        ):
            descriptor = getattr(self, attribute)
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
                setattr(self, attribute, None)

    def _clean_files(self) -> None:
        for name in (METADATA_NAME, REQUEST_NAME, RESPONSE_NAME, ".metadata.tmp"):
            path = self._channel / name
            try:
                _unlink_owned_artifact(path)
            except FileNotFoundError:
                pass
            except ValueError:
                continue
        for directory in (self._channel, self._workspace / ".symphony"):
            try:
                directory.rmdir()
            except OSError:
                pass


def _ensure_owned_directory(path: Path) -> None:
    try:
        facts = path.lstat()
    except OSError as error:
        raise ValueError("agent_command_channel_invalid") from error
    if (
        not stat.S_ISDIR(facts.st_mode)
        or facts.st_uid != os.getuid()
        or facts.st_mode & 0o022
    ):
        raise ValueError("agent_command_channel_invalid")


def _ensure_or_create_directory(path: Path) -> None:
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    _ensure_owned_directory(path)
    if path.stat().st_mode & 0o077:
        raise ValueError("agent_command_channel_invalid")


def _unlink_owned_artifact(path: Path) -> None:
    facts = path.lstat()
    if facts.st_uid != os.getuid() or facts.st_mode & 0o077:
        raise ValueError("agent_command_channel_invalid")
    if not (stat.S_ISREG(facts.st_mode) or stat.S_ISFIFO(facts.st_mode)):
        raise ValueError("agent_command_channel_invalid")
    path.unlink()


def _open_fifo(path: Path) -> int:
    descriptor = os.open(
        path,
        os.O_RDWR | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        facts = os.fstat(descriptor)
        if (
            not stat.S_ISFIFO(facts.st_mode)
            or facts.st_uid != os.getuid()
            or facts.st_mode & 0o077
        ):
            raise ValueError("agent_command_channel_invalid")
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _read_frame(descriptor: int, stop_fd: int) -> bytes | None:
    value = bytearray()
    while True:
        readable, _, _ = select.select([descriptor, stop_fd], [], [])
        if stop_fd in readable:
            return None
        chunk = os.read(descriptor, MAX_FRAME_BYTES + 1 - len(value))
        if not chunk:
            continue
        value.extend(chunk)
        newline = value.find(b"\n")
        if newline >= 0:
            if newline != len(value) - 1:
                raise ValueError("agent_command_frame_invalid")
            return bytes(value)
        if len(value) > MAX_FRAME_BYTES:
            raise ValueError("agent_command_frame_too_large")


def _write_all(descriptor: int, value: bytes, *, stop_fd: int | None = None) -> bool:
    offset = 0
    while offset < len(value):
        if stop_fd is not None:
            readable, writable, _ = select.select([stop_fd], [descriptor], [])
            if stop_fd in readable:
                return False
            if descriptor not in writable:
                continue
        try:
            written = os.write(descriptor, value[offset:])
        except BlockingIOError:
            continue
        if written <= 0:
            raise OSError("agent_command_channel_write_failed")
        offset += written
    return True
