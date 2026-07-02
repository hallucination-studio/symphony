from __future__ import annotations

import asyncio
import hmac
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import parse_qs

import httpx

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
    def __init__(
        self,
        *,
        token: str | None = None,
        linear_client_id: str | None = None,
        linear_client_secret: str | None = None,
        linear_redirect_uri: str | None = None,
        linear_webhook_secret: str | None = None,
        linear_token_exchange: Callable[[str], dict[str, Any]] | None = None,
        linear_installations: dict[str, dict[str, Any]] | None = None,
        linear_installations_path: str | Path | None = None,
        linear_graphql_transport: Callable[[httpx.Request], Awaitable[httpx.Response]] | httpx.AsyncBaseTransport | None = None,
        dispatch_callback: Callable[[dict[str, Any], ConductorRegistrationRequest], Awaitable[None]] | None = None,
    ):
        self.token = token or ""
        self.linear_client_id = linear_client_id or ""
        self.linear_client_secret = linear_client_secret or ""
        self.linear_redirect_uri = linear_redirect_uri or ""
        self.linear_webhook_secret = linear_webhook_secret or ""
        self.linear_token_exchange = linear_token_exchange or self._default_linear_token_exchange
        self.linear_installations_path = Path(linear_installations_path) if linear_installations_path else None
        self.linear_installations = dict(linear_installations or self._load_linear_installations())
        self.linear_graphql_transport = linear_graphql_transport
        self.dispatch_callback = dispatch_callback or self._default_dispatch
        self.conductors: dict[str, ConductorRegistrationRequest] = {}
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
            raw_path, _, raw_query = path.partition("?")
            query = {key: values[-1] for key, values in parse_qs(raw_query).items() if values}
            status, payload = await self._route(method.upper(), raw_path, raw_body, headers, query)
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

    async def _route(
        self,
        method: str,
        path: str,
        raw_body: bytes,
        headers: dict[str, str],
        query: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, Any] | RawResponse]:
        query = query or {}
        if method == "GET" and path == "/":
            return 200, RawResponse.text("Podium\n", "text/plain; charset=utf-8")
        if method == "GET" and path == "/api/v1/health":
            return 200, {"status": "ok"}
        if method == "GET" and path == "/api/v1/linear/oauth/callback":
            return self._linear_oauth_callback(query)
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
            self.conductors[request.conductor_id] = request
            response = ConductorRegistrationResponse(status="accepted", conductor_id=request.conductor_id)
            return 200, response.to_dict()
        if method == "POST" and path == "/api/v1/linear/webhooks/agent-session":
            return await self._linear_agent_session_webhook(raw_body, headers)
        if method == "POST" and path == "/api/v1/linear/graphql":
            return await self._linear_graphql_proxy(raw_body, headers)
        return 404, {"error": {"code": "not_found", "message": f"Route not found: {path}"}}

    def _linear_oauth_callback(self, query: dict[str, str]) -> tuple[int, dict[str, Any]]:
        code = str(query.get("code") or "").strip()
        if not code:
            return 400, {"error": {"code": "missing_code", "message": "OAuth code is required"}}
        exchanged = self.linear_token_exchange(code)
        workspace_id = str(
            exchanged.get("workspace_id")
            or exchanged.get("organization_id")
            or query.get("state")
            or "default"
        )
        expires_in = _int(exchanged.get("expires_in"), 0)
        expires_at = None
        if expires_in > 0:
            expires_at = (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat().replace("+00:00", "Z")
        installation = {
            "workspace_id": workspace_id,
            "access_token": str(exchanged.get("access_token") or ""),
            "refresh_token": str(exchanged.get("refresh_token") or ""),
            "expires_at": expires_at,
            "scope": str(exchanged.get("scope") or ""),
            "app_user_id": str(exchanged.get("app_user_id") or ""),
        }
        self.linear_installations[workspace_id] = installation
        self._save_linear_installations()
        return 200, {
            "installation": {
                "workspace_id": workspace_id,
                "scope": installation["scope"],
                "app_user_id": installation["app_user_id"],
                "expires_at": expires_at,
            }
        }

    async def _linear_agent_session_webhook(
        self, raw_body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, Any]]:
        if self.linear_webhook_secret and not self._valid_linear_signature(raw_body, headers):
            return 401, {"error": {"code": "invalid_signature", "message": "Invalid Linear webhook signature"}}
        try:
            payload = json.loads(raw_body.decode() or "{}")
        except json.JSONDecodeError:
            return 400, {"error": {"code": "invalid_json", "message": "Request body must be valid JSON"}}
        event_type = payload.get("type") or payload.get("eventType")
        if event_type != "AgentSessionEvent":
            return 200, {"status": "ignored", "reason": "unsupported_event_type", "dispatched": 0}
        event = _normalize_agent_session_event(payload)
        dispatched = 0
        for registration in self._matching_conductors(event):
            await self.dispatch_callback(event, registration)
            dispatched += 1
        return 200, {"status": "accepted", "dispatched": dispatched}

    async def _linear_graphql_proxy(
        self, raw_body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, Any]]:
        registration = self._registration_for_proxy(headers.get("authorization") or "")
        if registration is None:
            return 401, {"error": {"code": "unauthorized", "message": "Unauthorized"}}
        workspace_id = str(registration.routing.get("workspace_id") or "")
        installation = self.linear_installations.get(workspace_id)
        if not installation:
            return 400, {"error": {"code": "linear_installation_not_found", "message": "Linear installation not found"}}
        try:
            payload = json.loads(raw_body.decode() or "{}")
        except json.JSONDecodeError:
            return 400, {"error": {"code": "invalid_json", "message": "Request body must be valid JSON"}}
        response_payload = await self._forward_linear_graphql(payload, str(installation.get("access_token") or ""))
        return 200, response_payload

    async def _forward_linear_graphql(self, payload: dict[str, Any], access_token: str) -> dict[str, Any]:
        headers = {"Authorization": linear_authorization_header(access_token), "Content-Type": "application/json"}
        if callable(self.linear_graphql_transport):
            request = httpx.Request("POST", "https://api.linear.app/graphql", json=payload, headers=headers)
            response = await self.linear_graphql_transport(request)
        else:
            async with httpx.AsyncClient(
                timeout=30,
                transport=self.linear_graphql_transport,
                trust_env=False,
            ) as client:
                response = await client.post("https://api.linear.app/graphql", json=payload, headers=headers)
        try:
            data = response.json()
        except json.JSONDecodeError as exc:
            raise RuntimeError("Linear response was not valid JSON") from exc
        if not isinstance(data, dict):
            raise RuntimeError("Linear response was not an object")
        return data

    def _valid_linear_signature(self, raw_body: bytes, headers: dict[str, str]) -> bool:
        actual = headers.get("linear-signature") or headers.get("x-linear-signature") or ""
        expected = hmac.new(self.linear_webhook_secret.encode(), raw_body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(actual, expected)

    def _matching_conductors(self, event: dict[str, Any]) -> list[ConductorRegistrationRequest]:
        matches: list[ConductorRegistrationRequest] = []
        for registration in self.conductors.values():
            routing = registration.routing
            workspace_id = str(routing.get("workspace_id") or "")
            project_slug = str(routing.get("project_slug") or "")
            if workspace_id and workspace_id != event.get("workspace_id"):
                continue
            if project_slug and project_slug != event.get("project_slug"):
                continue
            matches.append(registration)
        return matches

    def _registration_for_proxy(self, authorization: str) -> ConductorRegistrationRequest | None:
        prefix = "Bearer "
        token = authorization.removeprefix(prefix) if authorization.startswith(prefix) else authorization
        token = token.strip()
        if not token:
            return None
        for registration in self.conductors.values():
            if registration.proxy_token and hmac.compare_digest(registration.proxy_token, token):
                return registration
        return None

    def _default_linear_token_exchange(self, code: str) -> dict[str, Any]:
        if not self.linear_client_id or not self.linear_client_secret or not self.linear_redirect_uri:
            raise RuntimeError("Linear OAuth token exchange is not configured")
        data = {
            "client_id": self.linear_client_id,
            "client_secret": self.linear_client_secret,
            "redirect_uri": self.linear_redirect_uri,
            "code": code,
            "grant_type": "authorization_code",
        }
        try:
            response = httpx.post("https://api.linear.app/oauth/token", data=data, timeout=30, trust_env=False)
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Linear OAuth token exchange failed: {exc}") from exc
        if response.status_code != 200:
            raise RuntimeError(f"Linear OAuth token exchange returned HTTP {response.status_code}: {response.text}")
        payload = response.json()
        if not isinstance(payload, dict):
            raise RuntimeError("Linear OAuth token exchange returned a non-object response")
        return payload

    def _load_linear_installations(self) -> dict[str, dict[str, Any]]:
        if self.linear_installations_path is None or not self.linear_installations_path.exists():
            return {}
        try:
            payload = json.loads(self.linear_installations_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        if not isinstance(payload, dict):
            return {}
        return {str(key): value for key, value in payload.items() if isinstance(value, dict)}

    def _save_linear_installations(self) -> None:
        if self.linear_installations_path is None:
            return
        self.linear_installations_path.parent.mkdir(parents=True, exist_ok=True)
        self.linear_installations_path.write_text(
            json.dumps(self.linear_installations, indent=2, sort_keys=True),
            encoding="utf-8",
        )

    async def _default_dispatch(self, payload: dict[str, Any], registration: ConductorRegistrationRequest) -> None:
        if not registration.callback_url:
            return
        if not registration.dispatch_token:
            return
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            await client.post(
                registration.callback_url,
                json=payload,
                headers={"Authorization": f"Bearer {registration.dispatch_token}"},
            )

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


def _normalize_agent_session_event(payload: dict[str, Any]) -> dict[str, Any]:
    session = payload.get("agentSession") if isinstance(payload.get("agentSession"), dict) else {}
    issue = session.get("issue") if isinstance(session.get("issue"), dict) else {}
    project = issue.get("project") if isinstance(issue.get("project"), dict) else {}
    assignee = issue.get("assignee") if isinstance(issue.get("assignee"), dict) else {}
    agent = session.get("agent") if isinstance(session.get("agent"), dict) else {}
    agent_user = agent.get("user") if isinstance(agent.get("user"), dict) else {}
    workspace = payload.get("workspace") if isinstance(payload.get("workspace"), dict) else {}
    return {
        "event_type": f"linear.agent_session.{str(payload.get('action') or '').strip() or 'unknown'}",
        "workspace_id": str(workspace.get("id") or payload.get("workspace_id") or ""),
        "project_slug": str(project.get("slugId") or payload.get("project_slug") or ""),
        "issue_id": str(issue.get("id") or payload.get("issue_id") or ""),
        "issue_identifier": str(issue.get("identifier") or payload.get("issue_identifier") or ""),
        "agent_session_id": str(session.get("id") or payload.get("agent_session_id") or ""),
        "assignee_id": str(
            assignee.get("id")
            or agent_user.get("id")
            or agent.get("userId")
            or session.get("agentUserId")
            or payload.get("assignee_id")
            or ""
        ),
        "raw_action": str(payload.get("action") or ""),
    }


def linear_authorization_header(token: str) -> str:
    token = token.strip()
    if token.lower().startswith("bearer "):
        return token
    if token.startswith("lin_api_"):
        return token
    return f"Bearer {token}"


def _int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
