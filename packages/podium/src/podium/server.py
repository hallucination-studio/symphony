from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from performer_api.registration import (
    ConductorRegistrationRequest,
    ConductorRegistrationResponse,
    RegistrationError,
)

from podium.linear_service import LinearService
from podium.onboarding_service import OnboardingService
from podium.routes import RawResponse, Router
from podium.runtime_service import RuntimeService
from podium.store import PodiumStore


class PodiumServer:
    """
    Podium HTTP server for Symphony agent orchestration.

    Thin orchestrator that wires together:
    - Router (routes.py) - HTTP routing to handlers
    - LinearService (linear_service.py) - OAuth, webhooks, GraphQL proxy
    - RuntimeService (runtime_service.py) - runtime enrollment and run visibility
    - OnboardingService (onboarding_service.py) - onboarding state machine
    - PodiumStore (store.py) - JSON persistence

    Legacy routes preserved with exact behavior:
    1. POST /api/v1/conductors/register
    2. POST /api/v1/linear/webhooks/agent-session
    3. POST /api/v1/linear/graphql
    4. GET  /api/v1/linear/oauth/callback

    CRITICAL CONSTRAINTS:
    - Linear OAuth tokens (access_token, refresh_token) must NEVER appear in responses
    - Existing conductor/webhook/proxy routes must preserve exact behavior
    """

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
        data_dir: str | Path | None = None,
    ):
        self.token = token or ""
        self.linear_service = LinearService(
            client_id=linear_client_id or "",
            client_secret=linear_client_secret or "",
            redirect_uri=linear_redirect_uri or "",
            webhook_secret=linear_webhook_secret or "",
            token_exchange=linear_token_exchange,
            installations=linear_installations,
            installations_path=linear_installations_path,
            graphql_transport=linear_graphql_transport,
        )
        self.store = PodiumStore(data_dir=data_dir)
        self.onboarding_service = OnboardingService(
            self.store,
            linear_connected=lambda workspace_id: self.linear_service.get_installation(workspace_id) is not None,
        )
        self.runtime_service = RuntimeService(self.store)
        self.router = Router(self)
        self.dispatch_callback = dispatch_callback or self._default_dispatch
        self.conductors: dict[str, ConductorRegistrationRequest] = {}
        self._server: asyncio.AbstractServer | None = None
        self.port: int | None = None

    # Backwards-compatible access to Linear installations (tests/CLI may inspect)
    @property
    def linear_installations(self) -> dict[str, dict[str, Any]]:
        return self.linear_service.installations

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
        from urllib.parse import parse_qs

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
            status, payload = await self.router.route(method.upper(), raw_path, raw_body, headers, query)
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

    # ===== Legacy handlers (behavior preserved exactly) =====

    def register_conductor(
        self, raw_body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, Any]]:
        """POST /api/v1/conductors/register - conductor registration and routing."""
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

    async def handle_agent_session_webhook(
        self, raw_body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, Any]]:
        """POST /api/v1/linear/webhooks/agent-session - Linear webhook ingestion."""
        if self.linear_service.webhook_secret and not self.linear_service.valid_signature(raw_body, headers):
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

    async def handle_graphql_proxy(
        self, raw_body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, Any]]:
        """POST /api/v1/linear/graphql - GraphQL proxy with OAuth token injection."""
        registration = self._registration_for_proxy(headers.get("authorization") or "")
        if registration is None:
            return 401, {"error": {"code": "unauthorized", "message": "Unauthorized"}}
        workspace_id = str(registration.routing.get("workspace_id") or "")
        installation = self.linear_service.get_installation(workspace_id)
        if not installation:
            return 400, {"error": {"code": "linear_installation_not_found", "message": "Linear installation not found"}}
        try:
            payload = json.loads(raw_body.decode() or "{}")
        except json.JSONDecodeError:
            return 400, {"error": {"code": "invalid_json", "message": "Request body must be valid JSON"}}
        response_payload = await self.linear_service.forward_graphql(
            payload, str(installation.get("access_token") or "")
        )
        return 200, response_payload

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
        import hmac

        prefix = "Bearer "
        token = authorization.removeprefix(prefix) if authorization.startswith(prefix) else authorization
        token = token.strip()
        if not token:
            return None
        for registration in self.conductors.values():
            if registration.proxy_token and hmac.compare_digest(registration.proxy_token, token):
                return registration
        return None

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
    workspace = payload.get("workspace") if isinstance(payload.get("workspace"), dict) else {}
    return {
        "event_type": f"linear.agent_session.{str(payload.get('action') or '').strip() or 'unknown'}",
        "workspace_id": str(workspace.get("id") or payload.get("workspace_id") or ""),
        "project_slug": str(project.get("slugId") or payload.get("project_slug") or ""),
        "issue_id": str(issue.get("id") or payload.get("issue_id") or ""),
        "issue_identifier": str(issue.get("identifier") or payload.get("issue_identifier") or ""),
        "agent_session_id": str(session.get("id") or payload.get("agent_session_id") or ""),
        "raw_action": str(payload.get("action") or ""),
    }
