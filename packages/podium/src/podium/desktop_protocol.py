from __future__ import annotations

import json
import struct
from typing import Any, BinaryIO

MAX_FRAME_BYTES = 64 * 1024
PROTOCOL_VERSION = 1


class ProtocolError(ValueError):
    pass


def _read_exact(stream: BinaryIO, size: int) -> bytes:
    chunks = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def encode_frame(payload: dict[str, Any]) -> bytes:
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(body) > MAX_FRAME_BYTES:
        raise ProtocolError("frame_too_large")
    return struct.pack(">I", len(body)) + body


def read_frame(stream: BinaryIO) -> dict[str, Any] | None:
    header = _read_exact(stream, 4)
    if not header:
        return None
    if len(header) != 4:
        raise ProtocolError("frame_header_incomplete")
    size = struct.unpack(">I", header)[0]
    if size > MAX_FRAME_BYTES:
        raise ProtocolError("frame_too_large")
    body = _read_exact(stream, size)
    if len(body) != size:
        raise ProtocolError("frame_body_incomplete")
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError("frame_json_invalid") from exc
    if not isinstance(payload, dict):
        raise ProtocolError("frame_payload_invalid")
    return payload
