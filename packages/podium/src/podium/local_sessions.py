from __future__ import annotations

import json
import re
import socket
import struct
from dataclasses import dataclass, field
from uuid import uuid4

from performer_api import LocalRuntimeEnvelope

MAX_LOCAL_FRAME_BYTES = 16 * 1024
_IDENTIFIER = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\Z")
_SECRET_IDENTIFIER = re.compile(
    r"(?i)(?:sk-[A-Za-z0-9_-]{20,}|"
    r"[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})"
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


def read_envelope(channel: socket.socket) -> LocalRuntimeEnvelope:
    size = struct.unpack(">I", _read_exact(channel, 4))[0]
    if size > MAX_LOCAL_FRAME_BYTES:
        raise ValueError("local_runtime_frame_too_large")
    try:
        payload = json.loads(_read_exact(channel, size))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("local_runtime_frame_invalid") from exc
    return LocalRuntimeEnvelope.from_dict(payload)


@dataclass
class PodiumLocalSession:
    channel: socket.socket
    expected: LocalRuntimeEnvelope
    connected: bool = False
    closed: bool = False

    @classmethod
    def create(cls, expected: LocalRuntimeEnvelope) -> tuple[PodiumLocalSession, int]:
        parent, child = socket.socketpair()
        child.set_inheritable(True)
        child_fd = child.detach()
        return cls(parent, expected), child_fd

    def accept(self) -> LocalRuntimeEnvelope:
        if self.closed:
            raise ValueError("local_runtime_session_closed")
        if self.connected:
            raise ValueError("local_runtime_duplicate_connect")
        received = read_envelope(self.channel)
        self.connected = True
        if received != self.expected:
            raise ValueError("local_runtime_peer_mismatch")
        return received

    def close(self) -> None:
        if not self.closed:
            self.channel.close()
            self.closed = True


@dataclass(frozen=True)
class LocalSessionIdentity:
    conductor_id: str
    project_id: str
    binding_id: str
    binding_generation: int
    instance_id: str
    expected_pid: int

    def __post_init__(self) -> None:
        for field_name in ("conductor_id", "project_id", "binding_id", "instance_id"):
            value = getattr(self, field_name)
            if (
                not isinstance(value, str)
                or _IDENTIFIER.fullmatch(value) is None
                or _SECRET_IDENTIFIER.search(value) is not None
            ):
                raise ValueError(f"{field_name} is invalid")
        if (
            isinstance(self.binding_generation, bool)
            or not isinstance(self.binding_generation, int)
            or self.binding_generation < 1
        ):
            raise ValueError("binding_generation is invalid")
        if (
            isinstance(self.expected_pid, bool)
            or not isinstance(self.expected_pid, int)
            or self.expected_pid < 1
        ):
            raise ValueError("expected_pid is invalid")

    def to_dict(self) -> dict[str, str | int]:
        return {
            "conductor_id": self.conductor_id,
            "project_id": self.project_id,
            "binding_id": self.binding_id,
            "binding_generation": self.binding_generation,
            "instance_id": self.instance_id,
            "expected_pid": self.expected_pid,
        }


@dataclass
class LocalSessionRecord:
    session_id: str
    identity: LocalSessionIdentity
    session: PodiumLocalSession
    state: str = "pending"

    @property
    def expected(self) -> LocalRuntimeEnvelope:
        return self.session.expected


@dataclass
class LocalSessionRegistry:
    _records: dict[str, LocalSessionRecord] = field(default_factory=dict)

    def register(
        self,
        identity: LocalSessionIdentity,
        session: PodiumLocalSession,
        *,
        session_id: str | None = None,
    ) -> LocalSessionRecord:
        if session_id is not None and session_id in self._records:
            raise ValueError("local_runtime_duplicate_session")
        if self.active_for_binding(identity.binding_id) is not None:
            raise ValueError("local_runtime_duplicate_binding")
        if any(
            record.state in {"pending", "online"}
            and (
                record.identity.expected_pid == identity.expected_pid
                or record.identity.instance_id == identity.instance_id
                or record.identity.conductor_id == identity.conductor_id
            )
            for record in self._records.values()
        ):
            raise ValueError("local_runtime_duplicate_process_identity")
        record = LocalSessionRecord(session_id or str(uuid4()), identity, session)
        self._records[record.session_id] = record
        return record

    def get(self, session_id: str) -> LocalSessionRecord:
        try:
            return self._records[session_id]
        except KeyError:
            raise ValueError("local_runtime_session_unknown") from None

    def active_for_binding(self, binding_id: str) -> LocalSessionRecord | None:
        return next(
            (
                record
                for record in self._records.values()
                if record.identity.binding_id == binding_id
                and record.state in {"pending", "online"}
            ),
            None,
        )

    def process_exited(self, expected_pid: int) -> LocalSessionRecord:
        record = next(
            (
                item
                for item in self._records.values()
                if item.identity.expected_pid == expected_pid
                and item.state in {"pending", "online"}
            ),
            None,
        )
        if record is None:
            raise ValueError("local_runtime_process_unknown")
        record.session.close()
        record.state = "offline"
        return record

    def close_all(self) -> None:
        for record in self._records.values():
            record.session.close()
            record.state = "closed"
