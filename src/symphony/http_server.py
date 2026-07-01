from __future__ import annotations

import asyncio
import json
from datetime import timezone
from typing import Any, Awaitable, Callable
from urllib.parse import unquote

from .config import ServiceConfig
from .models import utc_now
from .orchestrator import OrchestratorState
from .snapshot import build_issue_snapshot, build_runtime_snapshot


RefreshCallback = Callable[[], Awaitable[None]]


class SymphonyHttpServer:
    def __init__(self, config: ServiceConfig, state: OrchestratorState, refresh: RefreshCallback):
        self.config = config
        self.state = state
        self.refresh = refresh
        self._server: asyncio.AbstractServer | None = None
        self.port: int | None = None

    async def start(self, *, host: str | None = None, port: int | None = None) -> None:
        bind_host = host or self.config.observability.host or self.config.server.host
        bind_port = self.config.server.port if port is None else port
        if bind_port is None:
            raise ValueError("HTTP server port is not configured")
        self._server = await asyncio.start_server(self._handle_connection, bind_host, bind_port)
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
            if content_length > 0:
                await reader.readexactly(content_length)
            status, content_type, body = await self._route(method.upper(), path)
            self._write_response(writer, status, content_type, body)
            await writer.drain()
        except Exception as exc:
            body = _json_bytes(_error("internal_error", str(exc)))
            self._write_response(writer, 500, "application/json; charset=utf-8", body)
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

    async def _route(self, method: str, path: str) -> tuple[int, str, bytes]:
        clean_path = path.split("?", 1)[0]
        if clean_path == "/":
            if method != "GET":
                return self._method_not_allowed()
            return 200, "text/html; charset=utf-8", _dashboard_html(build_runtime_snapshot(self.config, self.state))
        if clean_path == "/api/v1/state":
            if method != "GET":
                return self._method_not_allowed()
            return 200, "application/json; charset=utf-8", _json_bytes(build_runtime_snapshot(self.config, self.state))
        if clean_path == "/api/v1/refresh":
            if method != "POST":
                return self._method_not_allowed()
            if not self.config.observability.allow_refresh:
                return (
                    403,
                    "application/json; charset=utf-8",
                    _json_bytes(_error("refresh_disabled", "Refresh endpoint is disabled")),
                )
            try:
                await self.refresh()
            except Exception as exc:
                return (
                    503,
                    "application/json; charset=utf-8",
                    _json_bytes(_error("unavailable", str(exc))),
                )
            return (
                202,
                "application/json; charset=utf-8",
                _json_bytes(
                    {
                        "queued": True,
                        "coalesced": False,
                        "requested_at": utc_now().astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                        "operations": ["poll", "reconcile"],
                    }
                ),
            )
        if clean_path.startswith("/api/v1/"):
            if method != "GET":
                return self._method_not_allowed()
            identifier = unquote(clean_path.removeprefix("/api/v1/"))
            detail = build_issue_snapshot(self.config, self.state, identifier)
            if detail is None:
                return (
                    404,
                    "application/json; charset=utf-8",
                    _json_bytes(_error("issue_not_found", f"Issue not found: {identifier}")),
                )
            return 200, "application/json; charset=utf-8", _json_bytes(detail)
        return 404, "application/json; charset=utf-8", _json_bytes(_error("not_found", f"Route not found: {clean_path}"))

    def _method_not_allowed(self) -> tuple[int, str, bytes]:
        return (
            405,
            "application/json; charset=utf-8",
            _json_bytes(_error("method_not_allowed", "Method not allowed")),
        )

    def _write_response(self, writer: asyncio.StreamWriter, status: int, content_type: str, body: bytes) -> None:
        reason = {
            200: "OK",
            202: "Accepted",
            404: "Not Found",
            403: "Forbidden",
            405: "Method Not Allowed",
            503: "Service Unavailable",
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


def _json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()


def _error(code: str, message: str) -> dict[str, Any]:
    return {"error": {"code": code, "message": message}}


def _dashboard_html(snapshot: dict[str, Any]) -> bytes:
    counts = snapshot["counts"]
    running_items = "".join(
        f"<li>{_escape_html(row['issue_identifier'])} - {_escape_html(row['state'])} - turns {row['turn_count']}</li>"
        for row in snapshot["running"]
    )
    retry_items = "".join(
        f"<li>{_escape_html(row['issue_identifier'])} - attempt {row['attempt']} - {_escape_html(row.get('error'))}</li>"
        for row in snapshot["retrying"]
    )
    continuation_items = "".join(
        f"<li>{_escape_html(row['issue_identifier'])} - attempt {row['attempt']} - {_escape_html(row.get('last_message'))}</li>"
        for row in snapshot.get("continuing", [])
    )
    html = f"""<!doctype html>
<html>
<head><title>Symphony</title></head>
<body>
<h1>Symphony</h1>
<p>Running: {counts['running']}</p>
<p>Retrying: {counts['retrying']}</p>
<p>Continuing: {counts.get('continuing', 0)}</p>
<p>Total tokens: {snapshot['codex_totals']['total_tokens']}</p>
<h2>Running</h2>
<ul>{running_items}</ul>
<h2>Retrying</h2>
<ul>{retry_items}</ul>
<h2>Continuing</h2>
<ul>{continuation_items}</ul>
</body>
</html>"""
    return html.encode()


def _escape_html(value: Any) -> str:
    text = "" if value is None else str(value)
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#x27;")
    )
