from __future__ import annotations

import json
import logging
import socket
import struct
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

from performer_api import (
    ConfigureCommand,
    DrainAck,
    DrainRequest,
    LocalRuntimeContext,
    parse_local_runtime_message,
)

from .conductor_bindings import DesiredBinding
from .local_sessions import MAX_LOCAL_FRAME_BYTES, LocalSessionRecord, LocalSessionRegistry
from .store.bindings import BindingRepository

LOGGER = logging.getLogger(__name__)


class LocalRuntimeCommandError(ValueError):
    def __init__(
        self,
        code: str,
        *,
        retryable: bool,
        next_action: str,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable
        self.next_action = next_action


def write_runtime_message(channel: socket.socket, message: Any) -> None:
    encoded = json.dumps(message.to_dict(), separators=(",", ":")).encode()
    if len(encoded) > MAX_LOCAL_FRAME_BYTES:
        raise ValueError("local_runtime_frame_too_large")
    channel.sendall(struct.pack(">I", len(encoded)) + encoded)


def read_runtime_message(channel: socket.socket) -> Any:
    size = struct.unpack(">I", _read_exact(channel, 4))[0]
    if size > MAX_LOCAL_FRAME_BYTES:
        raise ValueError("local_runtime_frame_too_large")
    try:
        payload = json.loads(_read_exact(channel, size))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("local_runtime_frame_invalid") from error
    return parse_local_runtime_message(payload)


class LocalRuntimeCommandDispatcher:
    def __init__(
        self, repository: BindingRepository, registry: LocalSessionRegistry
    ) -> None:
        self.repository = repository
        self.registry = registry
        self._draining: set[str] = set()
        self._drain_requests: dict[str, DrainRequest] = {}
        self._drain_acks: dict[str, DrainAck] = {}

    def accepts_new_work(self, binding_id: str) -> bool:
        return binding_id not in self._draining

    def configure(
        self, binding_id: str, profile_id: str, *, policy_revision: int
    ) -> ConfigureCommand:
        binding, session = self._current(binding_id)
        try:
            repository_path = str(Path(binding.repository_path).resolve(strict=True))
        except OSError:
            raise ValueError("local_runtime_repository_mismatch") from None
        if repository_path != binding.repository_path or not Path(repository_path).is_dir():
            raise ValueError("local_runtime_repository_mismatch")
        command = ConfigureCommand(
            self._context(session), repository_path, profile_id, policy_revision
        )
        write_runtime_message(session.session.channel, command)
        LOGGER.info(
            "event=podium_runtime_configure_sent conductor_id=%s instance_id=%s "
            "project_id=%s binding_id=%s binding_generation=%s "
            "correlation_id=%s policy_revision=%s retryable=false next_action=none",
            binding.conductor_id,
            session.identity.instance_id,
            binding.project_id,
            binding.binding_id,
            binding.generation,
            command.context.correlation_id,
            policy_revision,
        )
        return command

    def drain(self, binding_id: str, *, deadline_at: int) -> DrainAck:
        _, session = self._current(binding_id)
        self._draining.add(binding_id)
        request = DrainRequest(self._context(session), deadline_at)
        self._drain_requests[request.context.correlation_id] = request
        remaining = deadline_at - time.time()
        if remaining <= 0:
            self._raise_drain_failure(session, "local_runtime_drain_timeout")
        write_runtime_message(session.session.channel, request)
        previous_timeout = session.session.channel.gettimeout()
        session.session.channel.settimeout(remaining)
        try:
            message = read_runtime_message(session.session.channel)
        except (socket.timeout, TimeoutError):
            self._raise_drain_failure(session, "local_runtime_drain_timeout")
        except (OSError, ValueError):
            self._raise_drain_failure(session, "local_runtime_drain_ack_invalid")
        finally:
            session.session.channel.settimeout(previous_timeout)
        if not isinstance(message, DrainAck):
            self._raise_drain_failure(session, "local_runtime_drain_ack_invalid")
        return self.record_drain_ack(message)

    def record_drain_ack(self, ack: DrainAck) -> DrainAck:
        binding, session = self._current(ack.context.binding_id)
        if ack.context.binding_generation != binding.generation:
            raise ValueError("local_runtime_stale_generation")
        expected = session.identity
        if (
            ack.context.conductor_id != expected.conductor_id
            or ack.context.instance_id != expected.instance_id
            or ack.context.project_id != expected.project_id
        ):
            raise ValueError("local_runtime_peer_mismatch")
        existing = self._drain_acks.get(ack.context.correlation_id)
        if existing is not None:
            if existing != ack:
                raise ValueError("local_runtime_ack_conflict")
            return existing
        request = self._drain_requests.get(ack.context.correlation_id)
        if (
            request is None
            or request.context != ack.context
            or request.deadline_at != ack.deadline_at
        ):
            raise ValueError("local_runtime_ack_unexpected")
        self._drain_acks[ack.context.correlation_id] = ack
        level = logging.INFO if ack.status == "drained" else logging.ERROR
        LOGGER.log(
            level,
            "event=podium_runtime_drain_acknowledged conductor_id=%s instance_id=%s "
            "project_id=%s binding_id=%s binding_generation=%s correlation_id=%s "
            "error_code=%s sanitized_reason=%s action_required=%s retryable=false "
            "next_action=%s",
            binding.conductor_id,
            session.identity.instance_id,
            binding.project_id,
            binding.binding_id,
            binding.generation,
            ack.context.correlation_id,
            ack.error_code or "none",
            ack.error_code or "none",
            str(ack.status == "failed").lower(),
            ack.next_action,
        )
        return ack

    def _current(self, binding_id: str) -> tuple[DesiredBinding, LocalSessionRecord]:
        binding = self.repository.get_active(binding_id)
        if binding is None:
            raise ValueError("local_runtime_binding_not_active")
        session = self.registry.active_for_binding(binding_id)
        if session is None or session.state != "online":
            raise ValueError("local_runtime_session_not_online")
        identity = session.identity
        if (
            identity.binding_generation != binding.generation
            or identity.conductor_id != binding.conductor_id
            or identity.project_id != binding.project_id
        ):
            raise ValueError("local_runtime_stale_generation")
        return binding, session

    @staticmethod
    def _context(session: LocalSessionRecord) -> LocalRuntimeContext:
        identity = session.identity
        return LocalRuntimeContext(
            1,
            identity.conductor_id,
            identity.instance_id,
            identity.project_id,
            identity.binding_id,
            identity.binding_generation,
            str(uuid4()),
        )

    @staticmethod
    def _raise_drain_failure(session: LocalSessionRecord, code: str) -> None:
        identity = session.identity
        LOGGER.error(
            "event=podium_runtime_drain_failed conductor_id=%s instance_id=%s "
            "project_id=%s binding_id=%s binding_generation=%s "
            "error_type=local_runtime "
            "error_code=%s sanitized_reason=%s action_required=true retryable=true "
            "next_action=retry_quit",
            identity.conductor_id,
            identity.instance_id,
            identity.project_id,
            identity.binding_id,
            identity.binding_generation,
            code,
            code,
        )
        raise LocalRuntimeCommandError(
            code, retryable=True, next_action="retry_quit"
        )


def _read_exact(channel: socket.socket, size: int) -> bytes:
    chunks = []
    while size:
        chunk = channel.recv(size)
        if not chunk:
            raise ValueError("local_runtime_frame_incomplete")
        chunks.append(chunk)
        size -= len(chunk)
    return b"".join(chunks)
