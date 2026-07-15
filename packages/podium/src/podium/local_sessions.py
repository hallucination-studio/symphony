from __future__ import annotations

import json
import socket
import struct
from dataclasses import dataclass

from performer_api import LocalRuntimeEnvelope

MAX_LOCAL_FRAME_BYTES = 16 * 1024


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

    @classmethod
    def create(cls, expected: LocalRuntimeEnvelope) -> tuple[PodiumLocalSession, int]:
        parent, child = socket.socketpair()
        child.set_inheritable(True)
        child_fd = child.detach()
        return cls(parent, expected), child_fd

    def accept(self) -> LocalRuntimeEnvelope:
        if self.connected:
            raise ValueError("local_runtime_duplicate_connect")
        received = read_envelope(self.channel)
        self.connected = True
        if received != self.expected:
            raise ValueError("local_runtime_peer_mismatch")
        return received

    def close(self) -> None:
        self.channel.close()
