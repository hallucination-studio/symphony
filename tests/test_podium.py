from __future__ import annotations

import asyncio
import json

import pytest

from podium.server import PodiumServer


async def request(port: int, method: str, path: str, body: object | bytes | None = None, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    if isinstance(body, bytes):
        raw = body
    elif body is None:
        raw = b""
    else:
        raw = json.dumps(body).encode()
    request_headers = {"Host": "127.0.0.1", "Content-Length": str(len(raw))}
    if body is not None and not isinstance(body, bytes):
        request_headers["Content-Type"] = "application/json"
    if headers:
        request_headers.update(headers)
    writer.write(
        f"{method} {path} HTTP/1.1\r\n".encode()
        + b"".join(f"{key}: {value}\r\n".encode() for key, value in request_headers.items())
        + b"\r\n"
        + raw
    )
    await writer.drain()
    status_line = await reader.readline()
    status = int(status_line.decode().split(" ")[1])
    response_headers: dict[str, str] = {}
    while True:
        line = await reader.readline()
        if line in {b"\r\n", b"\n", b""}:
            break
        key, value = line.decode().split(":", 1)
        response_headers[key.strip().lower()] = value.strip()
    response_body = await reader.readexactly(int(response_headers.get("content-length", "0")))
    writer.close()
    await writer.wait_closed()
    return status, response_headers, response_body


@pytest.mark.asyncio
async def test_podium_accepts_conductor_registration() -> None:
    server = PodiumServer()
    await server.start(port=0)
    try:
        assert server.port is not None
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/conductors/register",
            {"conductor_id": "cond-1", "metadata": {"version": "test"}},
        )
    finally:
        await server.stop()

    assert status == 200
    assert json.loads(body) == {"conductor_id": "cond-1", "message": "accepted", "status": "accepted"}


@pytest.mark.asyncio
async def test_podium_rejects_invalid_json() -> None:
    server = PodiumServer()
    await server.start(port=0)
    try:
        assert server.port is not None
        status, _, body = await request(server.port, "POST", "/api/v1/conductors/register", b"{")
    finally:
        await server.stop()

    assert status == 400
    assert json.loads(body)["error"]["code"] == "invalid_json"


@pytest.mark.asyncio
async def test_podium_rejects_unauthorized_registration_when_token_is_configured() -> None:
    server = PodiumServer(token="secret")
    await server.start(port=0)
    try:
        assert server.port is not None
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/conductors/register",
            {"conductor_id": "cond-1"},
        )
    finally:
        await server.stop()

    assert status == 401
    assert json.loads(body)["error"]["code"] == "unauthorized"
