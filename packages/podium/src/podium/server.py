from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

from performer_api.registration import (
    ConductorRegistrationRequest,
    ConductorRegistrationResponse,
    RegistrationError,
)


@dataclass(frozen=True)
class RawResponse:
    body: bytes
    content_type: str

    @classmethod
    def text(cls, content: str, content_type: str) -> RawResponse:
        return cls(content.encode(), content_type)


class PodiumServer:
    def __init__(self, *, token: str | None = None):
        self.token = token or ""
        self._server: asyncio.AbstractServer | None = None
        self.port: int | None = None

    async def start(self, *, host: str = "127.0.0.1", port: int = 0) -> None:
        self._server = await asyncio.start_server(self._handle_connection, host, port)
        socket = self._server.sockets[0]
        self.port = int(socket.getsockname()[1])

    async def stop(self) -> None:
        if self._server is None:
            return
        self._server.close()
        await self._server.wait_closed()
        self._server = None

    async def _handle_connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request_line = await reader.readline()
            if not request_line:
                return
            method, path, _version = request_line.decode(errors="replace").strip().split(" ", 2)
            headers = await self._read_headers(reader)
            content_length = int(headers.get("content-length", "0") or "0")
            raw_body = b""
            if content_length > 0:
                raw_body = await reader.readexactly(content_length)
            status, payload = self._route(method.upper(), path.split("?", 1)[0], raw_body, headers)
            self._write_response(writer, status, payload)
            await writer.drain()
        except Exception as exc:
            self._write_response(writer, 500, {"error": {"code": "internal_error", "message": str(exc)}})
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    async def _read_headers(self, reader: asyncio.StreamReader) -> dict[str, str]:
        headers: dict[str, str] = {}
        while True:
            line = await reader.readline()
            if line in {b"\r\n", b"\n", b""}:
                return headers
            decoded = line.decode(errors="replace")
            if ":" in decoded:
                key, value = decoded.split(":", 1)
                headers[key.strip().lower()] = value.strip()

    def _route(
        self, method: str, path: str, raw_body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, Any] | RawResponse]:
        if method == "GET" and path == "/":
            return 200, RawResponse.text("Podium\n", "text/plain; charset=utf-8")
        if method == "GET" and path == "/api/v1/health":
            return 200, {"status": "ok"}
        if method == "POST" and path == "/api/v1/conductors/register":
            if self.token and headers.get("authorization") != f"Bearer {self.token}":
                return 401, {"error": {"code": "unauthorized", "message": "Unauthorized"}}
            try:
                payload = json.loads(raw_body.decode() or "{}")
            except json.JSONDecodeError:
                return 400, {"error": {"code": "invalid_json", "message": "Request body must be valid JSON"}}
            try:
                request = ConductorRegistrationRequest.from_dict(payload)
            except RegistrationError as exc:
                return 400, {"error": {"code": exc.code, "message": str(exc)}}
            response = ConductorRegistrationResponse(status="accepted", conductor_id=request.conductor_id)
            return 200, response.to_dict()
        return 404, {"error": {"code": "not_found", "message": f"Route not found: {path}"}}

    def _write_response(self, writer: asyncio.StreamWriter, status: int, payload: dict[str, Any] | RawResponse) -> None:
        if isinstance(payload, RawResponse):
            body = payload.body
            content_type = payload.content_type
        else:
            body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
            content_type = "application/json; charset=utf-8"
        reason = {
            200: "OK",
            400: "Bad Request",
            401: "Unauthorized",
            404: "Not Found",
            500: "Internal Server Error",
        }.get(status, "OK")
        writer.write(
            (
                f"HTTP/1.1 {status} {reason}\r\n"
                f"Content-Type: {content_type}\r\n"
                f"Content-Length: {len(body)}\r\n"
                "Connection: close\r\n"
                "\r\n"
            ).encode()
            + body
        )
