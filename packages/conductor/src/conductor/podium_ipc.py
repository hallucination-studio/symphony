from __future__ import annotations

import json
import socket
import struct

from performer_api import LocalRuntimeEnvelope


def inherited_podium_channel(fd: int) -> socket.socket:
    if fd < 0:
        raise ValueError("podium_ipc_fd_invalid")
    return socket.socket(fileno=fd)


def send_handshake(channel: socket.socket, envelope: LocalRuntimeEnvelope) -> None:
    body = json.dumps(envelope.to_dict(), separators=(",", ":")).encode()
    channel.sendall(struct.pack(">I", len(body)) + body)
