from __future__ import annotations

import json
import logging
import socket
import struct
from typing import Any, Protocol

from performer_api import (
    DrainAck,
    DrainRequest,
    LocalRuntimeContext,
    LocalRuntimeEnvelope,
    parse_local_runtime_message,
)

from .models import LocalRuntimeIdentity

MAX_LOCAL_FRAME_BYTES = 16 * 1024
LOGGER = logging.getLogger(__name__)


class DrainHandler(Protocol):
    async def drain_for_podium(self, request: DrainRequest) -> DrainAck: ...


def inherited_podium_channel(fd: int) -> socket.socket:
    if fd < 0:
        raise ValueError("podium_ipc_fd_invalid")
    return socket.socket(fileno=fd)


def send_handshake(channel: socket.socket, envelope: LocalRuntimeEnvelope) -> None:
    body = json.dumps(envelope.to_dict(), separators=(",", ":")).encode()
    channel.sendall(struct.pack(">I", len(body)) + body)


def write_runtime_message(channel: socket.socket, message: Any) -> None:
    body = json.dumps(message.to_dict(), separators=(",", ":")).encode()
    if len(body) > MAX_LOCAL_FRAME_BYTES:
        raise ValueError("podium_ipc_frame_too_large")
    channel.sendall(struct.pack(">I", len(body)) + body)


def read_runtime_message(channel: socket.socket) -> Any:
    size = struct.unpack(">I", _read_exact(channel, 4))[0]
    if size > MAX_LOCAL_FRAME_BYTES:
        raise ValueError("podium_ipc_frame_too_large")
    try:
        payload = json.loads(_read_exact(channel, size))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("podium_ipc_frame_invalid") from error
    return parse_local_runtime_message(payload)


class LocalRuntimeClient:
    def __init__(self, channel: socket.socket, identity: LocalRuntimeIdentity) -> None:
        self.channel = channel
        self.identity = identity
        self.closed = False

    @classmethod
    def connect(
        cls,
        fd: int,
        identity: LocalRuntimeIdentity,
        handshake: LocalRuntimeEnvelope,
    ) -> LocalRuntimeClient:
        channel = inherited_podium_channel(fd)
        if (
            handshake.protocol_version != 1
            or handshake.instance_id != identity.instance_id
            or handshake.project_id != identity.project_id
            or handshake.binding_generation != identity.binding_generation
            or handshake.payload_kind != "handshake"
        ):
            _log_failure(identity, "podium_ipc_handshake_mismatch")
            channel.close()
            raise ValueError("podium_ipc_handshake_mismatch")
        send_handshake(channel, handshake)
        return cls(channel, identity)

    def receive(self) -> Any:
        self._require_open()
        try:
            message = read_runtime_message(self.channel)
            self._validate_context(message)
            return message
        except Exception as error:
            self._log_failure(error)
            self.close()
            raise

    def send(self, message: Any) -> None:
        self._require_open()
        try:
            self._validate_context(message)
            write_runtime_message(self.channel, message)
        except Exception as error:
            self._log_failure(error)
            self.close()
            raise

    async def handle_drain(
        self, request: DrainRequest, handler: DrainHandler
    ) -> DrainAck:
        self._require_open()
        self._validate_context(request)
        acknowledgment = await handler.drain_for_podium(request)
        self.send(acknowledgment)
        return acknowledgment

    def close(self) -> None:
        if not self.closed:
            self.channel.close()
            self.closed = True

    def _validate_context(self, message: Any) -> None:
        context = getattr(message, "context", None)
        identity = self.identity
        if not isinstance(context, LocalRuntimeContext) or (
            context.protocol_version != 1
            or context.conductor_id != identity.conductor_id
            or context.instance_id != identity.instance_id
            or context.project_id != identity.project_id
            or context.binding_id != identity.binding_id
            or context.binding_generation != identity.binding_generation
        ):
            raise ValueError("podium_ipc_context_mismatch")

    def _require_open(self) -> None:
        if self.closed:
            raise ValueError("podium_ipc_closed")

    def _log_failure(self, error: Exception) -> None:
        code = str(error) if str(error).startswith("podium_ipc_") else "podium_ipc_transport_failed"
        _log_failure(self.identity, code)


def _read_exact(channel: socket.socket, size: int) -> bytes:
    chunks = []
    while size:
        chunk = channel.recv(size)
        if not chunk:
            raise ValueError("podium_ipc_frame_incomplete")
        chunks.append(chunk)
        size -= len(chunk)
    return b"".join(chunks)


def _log_failure(identity: LocalRuntimeIdentity, code: str) -> None:
    LOGGER.error(
        "event=conductor_podium_ipc_failed conductor_id=%s instance_id=%s "
        "project_id=%s binding_id=%s binding_generation=%s error_type=local_runtime "
        "error_code=%s sanitized_reason=%s action_required=true retryable=true "
        "next_action=restart_conductor",
        identity.conductor_id,
        identity.instance_id,
        identity.project_id,
        identity.binding_id,
        identity.binding_generation,
        code,
        code,
    )
