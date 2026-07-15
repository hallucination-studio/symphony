from __future__ import annotations

import math
import socket
import time
from urllib.parse import parse_qsl, urlsplit

from .linear_manifest import LINEAR_OAUTH_HOST, LINEAR_OAUTH_PATH, LINEAR_OAUTH_PORT
from .oauth_callback_page import (
    CALLBACK_HEADERS,
    DENIED_PAGE,
    INVALID_PAGE,
    SUCCESS_PAGE,
    callback_response,
)
from .oauth_state import OAuthAttemptManager, OAuthCodeExchange

MAX_CALLBACK_TIMEOUT_SECONDS = 240
MAX_REQUEST_BYTES = 16 * 1024
CALLBACK_AUTHORITY = f"{LINEAR_OAUTH_HOST}:{LINEAR_OAUTH_PORT}"


class OAuthCallbackListener:
    def __init__(self, attempts: OAuthAttemptManager) -> None:
        self.attempts = attempts
        self.socket = socket.socket()
        try:
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.socket.bind((LINEAR_OAUTH_HOST, LINEAR_OAUTH_PORT))
            self.socket.listen(1)
        except OSError:
            self.socket.close()
            raise OSError("oauth_callback_port_unavailable") from None

    def receive(self, timeout: float) -> OAuthCodeExchange:
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout)
            or not 0 < timeout <= MAX_CALLBACK_TIMEOUT_SECONDS
        ):
            self.close()
            raise ValueError("oauth_callback_timeout_invalid")
        deadline = time.monotonic() + timeout
        try:
            self.socket.settimeout(timeout)
            connection, _peer = self.socket.accept()
            with connection:
                connection.settimeout(max(0.001, deadline - time.monotonic()))
                return self._handle_connection(connection)
        except (TimeoutError, socket.timeout):
            raise TimeoutError("oauth_callback_timeout") from None
        finally:
            self.close()

    def close(self) -> None:
        self.socket.close()

    def _handle_connection(self, connection: socket.socket) -> OAuthCodeExchange:
        try:
            kind, fields = _parse_request(_read_request(connection))
            if kind == "denied":
                self.attempts.consume_denial(fields["state"])
                _send(connection, DENIED_PAGE)
                raise ValueError("oauth_callback_denied")
            result = self.attempts.consume(fields["state"], fields["code"])
            _send(connection, SUCCESS_PAGE)
            return result
        except ValueError as error:
            if str(error) != "oauth_callback_denied":
                _send(connection, INVALID_PAGE)
            raise
        except (TimeoutError, socket.timeout):
            raise TimeoutError("oauth_callback_timeout") from None


def _read_request(connection: socket.socket) -> bytes:
    request = bytearray()
    while b"\r\n\r\n" not in request:
        chunk = connection.recv(4096)
        if not chunk:
            raise ValueError("oauth_callback_request_invalid")
        request.extend(chunk)
        if len(request) > MAX_REQUEST_BYTES:
            raise ValueError("oauth_callback_request_invalid")
    return bytes(request)


def _parse_request(request: bytes) -> tuple[str, dict[str, str]]:
    try:
        head = request.split(b"\r\n\r\n", 1)[0].decode("ascii")
        request_line, *header_lines = head.split("\r\n")
        method, target, version = request_line.split(" ")
        headers = _headers(header_lines)
        parsed = urlsplit(target)
        pairs = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
    except (UnicodeDecodeError, ValueError) as error:
        raise ValueError("oauth_callback_request_invalid") from error
    if (
        method != "GET"
        or version != "HTTP/1.1"
        or parsed.scheme
        or parsed.netloc
        or parsed.fragment
        or parsed.path != LINEAR_OAUTH_PATH
        or headers.get("host") != CALLBACK_AUTHORITY
    ):
        raise ValueError("oauth_callback_request_invalid")
    fields = _unique_query(pairs)
    if set(fields) == {"state", "code"} and fields["state"] and fields["code"]:
        return "authorized", fields
    if set(fields) == {"state", "error"} and fields["state"] and fields["error"]:
        return "denied", fields
    raise ValueError("oauth_callback_request_invalid")


def _headers(lines: list[str]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for line in lines:
        name, separator, value = line.partition(":")
        name = name.strip().lower()
        if not separator or not name or name in headers:
            raise ValueError("oauth_callback_request_invalid")
        headers[name] = value.strip()
    return headers


def _unique_query(pairs: list[tuple[str, str]]) -> dict[str, str]:
    fields: dict[str, str] = {}
    for key, value in pairs:
        if key in fields:
            raise ValueError("oauth_callback_request_invalid")
        fields[key] = value
    return fields


def _send(connection: socket.socket, body: bytes) -> None:
    try:
        connection.sendall(callback_response(body))
    except OSError:
        raise OSError("oauth_callback_response_failed") from None
