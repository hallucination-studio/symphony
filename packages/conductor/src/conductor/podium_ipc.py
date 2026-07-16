from __future__ import annotations

import asyncio
import json
import logging
import socket
import struct
from typing import Any, Protocol

from performer_api import (
    ConfigureCommand,
    DispatchAck,
    DispatchLease,
    DrainAck,
    DrainRequest,
    LocalRuntimeContext,
    LocalRuntimeEnvelope,
    RuntimeReportMessage,
    parse_local_runtime_message,
)

from .models import LocalRuntimeIdentity

MAX_LOCAL_FRAME_BYTES = 16 * 1024
LOGGER = logging.getLogger(__name__)


class PrivateSyncHandler(Protocol):
    private_sync_failure: dict[str, Any] | None

    async def drain_for_podium(self, request: DrainRequest) -> DrainAck: ...

    def apply_private_configure(self, command: ConfigureCommand) -> dict[str, Any]: ...

    def _private_runtime_report(
        self, context: LocalRuntimeContext
    ) -> RuntimeReportMessage: ...

    def _apply_private_dispatch(
        self, lease: DispatchLease, configure_result: dict[str, Any]
    ) -> DispatchAck: ...

    def _record_private_sync_failure(
        self,
        exc: Exception,
        *,
        context: LocalRuntimeContext | None = None,
        lease: DispatchLease | None = None,
        identity: LocalRuntimeIdentity | None = None,
    ) -> None: ...


def inherited_podium_channel(fd: int) -> socket.socket:
    if fd < 0:
        raise ValueError("podium_ipc_fd_invalid")
    try:
        return socket.socket(fileno=fd)
    except OSError:
        raise ValueError("podium_ipc_fd_unavailable") from None


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
        try:
            send_handshake(channel, handshake)
        except Exception:
            _log_failure(identity, "podium_ipc_handshake_failed")
            channel.close()
            raise ValueError("podium_ipc_handshake_failed") from None
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
        self, request: DrainRequest, handler: PrivateSyncHandler
    ) -> DrainAck:
        self._require_open()
        self._validate_context(request)
        acknowledgment = await handler.drain_for_podium(request)
        self.send(acknowledgment)
        return acknowledgment

    async def sync_once(self, handler: PrivateSyncHandler) -> dict[str, Any]:
        context = None
        lease = None
        try:
            command = await asyncio.to_thread(self.receive)
            context = getattr(command, "context", None)
            if isinstance(command, DrainRequest):
                acknowledgment = await self.handle_drain(command, handler)
                return {"status": acknowledgment.status, "kind": "drain"}
            if not isinstance(command, ConfigureCommand):
                raise ValueError("private_sync_command_invalid")

            previous_failure = handler.private_sync_failure
            configure_result = handler.apply_private_configure(command)
            if (
                previous_failure is not None
                and previous_failure.get("event") == "private_sync_failed"
                and configure_result.get("status") != "rejected"
            ):
                handler.private_sync_failure = previous_failure
            await asyncio.to_thread(
                self.send, handler._private_runtime_report(command.context)
            )
            if handler.private_sync_failure is previous_failure:
                handler.private_sync_failure = None

            lease = await asyncio.to_thread(self.receive)
            if not isinstance(lease, DispatchLease):
                raise ValueError("private_sync_lease_invalid")
            context = lease.context
            acknowledgment = handler._apply_private_dispatch(lease, configure_result)
            await asyncio.to_thread(self.send, acknowledgment)
            return {
                "status": acknowledgment.status,
                "kind": "dispatch",
                "dispatch_id": lease.dispatch_id,
            }
        except Exception as exc:
            handler._record_private_sync_failure(
                exc,
                context=context,
                lease=lease if isinstance(lease, DispatchLease) else None,
                identity=self.identity,
            )
            raise

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
