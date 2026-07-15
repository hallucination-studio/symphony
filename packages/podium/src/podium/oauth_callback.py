from __future__ import annotations

import html
import socket
import time
from dataclasses import dataclass
from urllib.parse import parse_qs, urlsplit

from .linear_manifest import LINEAR_OAUTH_HOST, LINEAR_OAUTH_PATH, LINEAR_OAUTH_PORT


@dataclass
class OAuthState:
    value: str
    expires_at: float
    used: bool = False

    def consume(self, value: str, *, now: float | None = None) -> None:
        current = time.monotonic() if now is None else now
        if self.used:
            raise ValueError("oauth_state_replayed")
        if current >= self.expires_at:
            raise ValueError("oauth_state_expired")
        if value != self.value:
            raise ValueError("oauth_state_mismatch")
        self.used = True


CALLBACK_HEADERS = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
}


@dataclass(frozen=True)
class CallbackResult:
    code: str


class OAuthCallbackListener:
    def __init__(self, state: OAuthState) -> None:
        self.state = state
        self.socket = socket.socket()
        try:
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.socket.bind((LINEAR_OAUTH_HOST, LINEAR_OAUTH_PORT))
            self.socket.listen(1)
        except BaseException:
            self.socket.close()
            raise

    def receive(self, timeout: float) -> CallbackResult:
        deadline = time.monotonic() + timeout
        try:
            self.socket.settimeout(timeout)
            connection, _ = self.socket.accept()
            with connection:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("oauth_callback_timeout")
                connection.settimeout(remaining)
                try:
                    result = self._parse_request(_read_request(connection))
                except ValueError:
                    connection.sendall(_response("Authorization failed. Return to Podium."))
                    raise
                connection.sendall(_response("Authorization complete. Return to Podium."))
                return result
        finally:
            self.socket.close()

    def _parse_request(self, request: bytes) -> CallbackResult:
        try:
            line = request.split(b"\r\n", 1)[0].decode("ascii")
            method, target, _ = line.split(" ", 2)
        except (UnicodeDecodeError, ValueError) as exc:
            raise ValueError("oauth_callback_request_invalid") from exc
        parsed = urlsplit(target)
        if method != "GET" or parsed.path != LINEAR_OAUTH_PATH:
            raise ValueError("oauth_callback_request_invalid")
        query = parse_qs(parsed.query, strict_parsing=True)
        self.state.consume(_single(query, "state"))
        if "error" in query:
            raise ValueError(f"oauth_callback_denied:{_single(query, 'error')}")
        return CallbackResult(code=_single(query, "code"))


def _read_request(connection: socket.socket) -> bytes:
    request = bytearray()
    while b"\r\n\r\n" not in request:
        chunk = connection.recv(4096)
        if not chunk:
            raise ValueError("oauth_callback_request_incomplete")
        request.extend(chunk)
        if len(request) > 16 * 1024:
            raise ValueError("oauth_callback_request_too_large")
    return bytes(request)


def _single(query: dict[str, list[str]], field: str) -> str:
    values = query.get(field, [])
    if len(values) != 1 or not values[0]:
        raise ValueError(f"oauth_callback_{field}_invalid")
    return values[0]


def _response(message: str) -> bytes:
    body = (
        f"<!doctype html><meta charset=utf-8><title>Podium</title>"
        f"<p>{html.escape(message)}</p>"
    ).encode()
    headers = [
        "HTTP/1.1 200 OK",
        "Content-Type: text/html; charset=utf-8",
        *(f"{key}: {value}" for key, value in CALLBACK_HEADERS.items()),
        f"Content-Length: {len(body)}",
        "Connection: close",
        "",
        "",
    ]
    return "\r\n".join(headers).encode() + body
