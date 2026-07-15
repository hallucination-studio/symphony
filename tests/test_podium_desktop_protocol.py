from __future__ import annotations

import io
import json
import struct

import pytest

from podium.desktop_cli import run_desktop_protocol
from podium.desktop_protocol import MAX_FRAME_BYTES, ProtocolError, encode_frame, read_frame


class PartialReader(io.BytesIO):
    def read(self, size: int = -1) -> bytes:
        return super().read(min(size, 1))


def _request(kind: str, request_id: str = "req-1") -> bytes:
    return encode_frame({"kind": kind, "request_id": request_id, "protocol_version": 1})


def _frames(payload: bytes) -> list[dict[str, object]]:
    stream = io.BytesIO(payload)
    frames = []
    while stream.tell() < len(payload):
        frames.append(read_frame(stream))
    return frames


def test_handshake_health_and_shutdown_are_bounded_framed_responses() -> None:
    stdout = io.BytesIO()
    stderr = io.BytesIO()
    exit_code = run_desktop_protocol(
        stdin=io.BytesIO(_request("handshake") + _request("health", "req-2") + _request("shutdown", "req-3")),
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == 0
    assert stderr.getvalue() == b""
    assert _frames(stdout.getvalue()) == [
        {"kind": "handshake.result", "request_id": "req-1", "protocol_version": 1, "status": "ready"},
        {"kind": "health.result", "request_id": "req-2", "protocol_version": 1, "status": "ready"},
        {"kind": "shutdown.result", "request_id": "req-3", "protocol_version": 1, "status": "stopping"},
    ]


@pytest.mark.parametrize(
    "payload",
    [
        struct.pack(">I", MAX_FRAME_BYTES + 1),
        struct.pack(">I", 1) + b"{",
        encode_frame({"kind": "unknown", "request_id": "req-1", "protocol_version": 1}),
        encode_frame({"kind": "health", "request_id": "req-1", "protocol_version": 2}),
    ],
)
def test_malformed_or_unsupported_input_fails_closed(payload: bytes) -> None:
    stdout = io.BytesIO()
    stderr = io.BytesIO()

    assert run_desktop_protocol(stdin=io.BytesIO(payload), stdout=stdout, stderr=stderr) == 2
    assert stdout.getvalue() == b""
    assert b"event=podium_desktop_protocol_failed" in stderr.getvalue()


def test_encoder_rejects_oversized_payload() -> None:
    with pytest.raises(ProtocolError, match="frame_too_large"):
        encode_frame({"value": "x" * MAX_FRAME_BYTES})


def test_reader_accepts_partial_pipe_reads() -> None:
    assert read_frame(PartialReader(_request("health"))) == {
        "kind": "health",
        "request_id": "req-1",
        "protocol_version": 1,
    }
