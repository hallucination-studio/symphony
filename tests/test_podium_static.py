from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from podium.server import PodiumServer


async def request(
    port: int,
    method: str,
    path: str,
    body: object | bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, str], bytes]:
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


def _build_static(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "index.html").write_text("<!doctype html><title>Podium App</title>", encoding="utf-8")
    assets = root / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    (assets / "app.js").write_text("console.log('hi')", encoding="utf-8")
    (assets / "app.css").write_text("body{margin:0}", encoding="utf-8")


@pytest.mark.asyncio
async def test_serves_index_at_root(tmp_path: Path) -> None:
    static_root = tmp_path / "static"
    _build_static(static_root)
    server = PodiumServer(static_dir=static_root)
    await server.start(port=0)
    try:
        assert server.port is not None
        status, headers, body = await request(server.port, "GET", "/")
    finally:
        await server.stop()

    assert status == 200
    assert headers["content-type"].startswith("text/html")
    assert b"Podium App" in body


@pytest.mark.asyncio
async def test_serves_nested_asset(tmp_path: Path) -> None:
    static_root = tmp_path / "static"
    _build_static(static_root)
    server = PodiumServer(static_dir=static_root)
    await server.start(port=0)
    try:
        assert server.port is not None
        status_js, headers_js, body_js = await request(server.port, "GET", "/assets/app.js")
        status_css, headers_css, _ = await request(server.port, "GET", "/assets/app.css")
    finally:
        await server.stop()

    assert status_js == 200
    assert "javascript" in headers_js["content-type"]
    assert b"console.log" in body_js
    assert status_css == 200
    assert "text/css" in headers_css["content-type"]


@pytest.mark.asyncio
async def test_spa_fallback_for_unknown_route(tmp_path: Path) -> None:
    static_root = tmp_path / "static"
    _build_static(static_root)
    server = PodiumServer(static_dir=static_root)
    await server.start(port=0)
    try:
        assert server.port is not None
        status, headers, body = await request(server.port, "GET", "/setup")
    finally:
        await server.stop()

    assert status == 200
    assert headers["content-type"].startswith("text/html")
    assert b"Podium App" in body


@pytest.mark.asyncio
async def test_unknown_api_route_still_404(tmp_path: Path) -> None:
    static_root = tmp_path / "static"
    _build_static(static_root)
    server = PodiumServer(static_dir=static_root)
    await server.start(port=0)
    try:
        assert server.port is not None
        status, _, body = await request(server.port, "GET", "/api/v1/does-not-exist")
    finally:
        await server.stop()

    assert status == 404
    assert json.loads(body)["error"]["code"] == "not_found"


@pytest.mark.asyncio
async def test_path_traversal_blocked(tmp_path: Path) -> None:
    static_root = tmp_path / "static"
    _build_static(static_root)
    secret = tmp_path / "secret.txt"
    secret.write_text("top secret", encoding="utf-8")
    server = PodiumServer(static_dir=static_root)
    await server.start(port=0)
    try:
        assert server.port is not None
        # Encoded traversal that would escape the static root if resolved naively.
        status, headers, body = await request(server.port, "GET", "/..%2f..%2fsecret.txt")
    finally:
        await server.stop()

    # Must never leak the sibling file. Either SPA fallback (200 html) or 404.
    assert b"top secret" not in body
    if status == 200:
        assert headers["content-type"].startswith("text/html")


@pytest.mark.asyncio
async def test_root_falls_back_to_plaintext_when_no_static(tmp_path: Path) -> None:
    # static_dir provided but index.html absent -> legacy behavior preserved.
    empty_root = tmp_path / "empty"
    empty_root.mkdir(parents=True, exist_ok=True)
    server = PodiumServer(static_dir=empty_root)
    await server.start(port=0)
    try:
        assert server.port is not None
        status, headers, body = await request(server.port, "GET", "/")
        status_unknown, _, _ = await request(server.port, "GET", "/setup")
    finally:
        await server.stop()

    assert status == 200
    assert headers["content-type"] == "text/plain; charset=utf-8"
    assert body == b"Podium\n"
    # Without an index, unknown routes must not SPA-fallback.
    assert status_unknown == 404


@pytest.mark.asyncio
async def test_root_plaintext_when_static_dir_none() -> None:
    # No static_dir at all -> pure legacy behavior.
    server = PodiumServer()
    await server.start(port=0)
    try:
        assert server.port is not None
        status, headers, body = await request(server.port, "GET", "/")
    finally:
        await server.stop()

    assert status == 200
    assert headers["content-type"] == "text/plain; charset=utf-8"
    assert body == b"Podium\n"
