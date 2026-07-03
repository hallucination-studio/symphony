from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from podium.models import RepositoryMappingMode, SessionIdentity, User

if TYPE_CHECKING:
    from podium.server import PodiumServer


@dataclass(frozen=True)
class RawResponse:
    body: bytes
    content_type: str

    @classmethod
    def text(cls, content: str, content_type: str) -> "RawResponse":
        return cls(content.encode(), content_type)


# Cookie name for the server-side session.
SESSION_COOKIE = "podium_session"


@dataclass(frozen=True)
class SetCookie:
    """Directive for the server to emit a Set-Cookie header.

    ``value=""`` with ``max_age=0`` clears the cookie.
    """
    name: str
    value: str
    max_age: int | None = None


class Unauthenticated(Exception):
    """Raised internally when a protected route has no valid session."""


def _error(code: str, message: str) -> dict[str, Any]:
    return {"error": {"code": code, "message": message}}


def _parse_json(raw_body: bytes) -> tuple[dict[str, Any] | None, tuple[int, dict[str, Any]] | None]:
    """Parse a JSON body, returning (payload, None) or (None, error_response)."""
    try:
        payload = json.loads(raw_body.decode() or "{}")
    except json.JSONDecodeError:
        return None, (400, _error("invalid_json", "Request body must be valid JSON"))
    if not isinstance(payload, dict):
        return None, (400, _error("invalid_json", "Request body must be a JSON object"))
    return payload, None


class Router:
    """
    Routes HTTP requests to the appropriate service handlers.

    Preserves exact behavior of legacy routes:
    - POST /api/v1/conductors/register
    - POST /api/v1/linear/webhooks/agent-session
    - POST /api/v1/linear/graphql
    - GET  /api/v1/linear/oauth/callback

    Adds BFF (backend-for-frontend) routes for the web onboarding UI.

    SECURITY: UI-facing responses never expose Linear OAuth tokens.
    """

    def __init__(self, server: "PodiumServer"):
        self.server = server
        # Set by handlers during a single route() call; the server reads it
        # synchronously immediately after route() returns (no interleaving).
        self.pending_cookie: SetCookie | None = None

    async def route(
        self,
        method: str,
        path: str,
        raw_body: bytes,
        headers: dict[str, str],
        query: dict[str, str],
    ) -> tuple[int, dict[str, Any] | RawResponse]:
        self.pending_cookie = None
        server = self.server

        # ===== Static / health =====
        if method == "GET" and path == "/api/v1/health":
            return 200, {"status": "ok"}
        if method == "GET" and path == "/":
            static = self._serve_static(path)
            if static is not None:
                return static
            return 200, RawResponse.text("Podium\n", "text/plain; charset=utf-8")

        # ===== Legacy Linear OAuth callback =====
        if method == "GET" and path == "/api/v1/linear/oauth/callback":
            return server.linear_service.handle_oauth_callback(query)

        # ===== Legacy conductor registration =====
        if method == "POST" and path == "/api/v1/conductors/register":
            return server.register_conductor(raw_body, headers)

        # ===== Legacy Linear webhook =====
        if method == "POST" and path == "/api/v1/linear/webhooks/agent-session":
            return await server.handle_agent_session_webhook(raw_body, headers)

        # ===== Legacy Linear GraphQL proxy =====
        if method == "POST" and path == "/api/v1/linear/graphql":
            return await server.handle_graphql_proxy(raw_body, headers)

        # ===== Auth =====
        if method == "POST" and path == "/api/v1/auth/register":
            return self._auth_register(raw_body)
        if method == "POST" and path == "/api/v1/auth/login":
            return self._auth_login(raw_body)
        if method == "POST" and path == "/api/v1/auth/logout":
            return self._auth_logout(headers)
        if method == "GET" and path == "/api/v1/auth/me":
            return self._auth_me(headers)

        # ===== Account: custom Linear app =====
        if method == "PUT" and path == "/api/v1/account/linear-app":
            return self._account_set_linear_app(raw_body, headers)
        if method == "DELETE" and path == "/api/v1/account/linear-app":
            return self._account_clear_linear_app(headers)

        # ===== BFF: bootstrap (session-derived workspace) =====
        if method == "GET" and path == "/api/v1/bootstrap":
            try:
                return self._bootstrap(headers)
            except Unauthenticated:
                return self._unauthenticated()

        # ===== BFF: onboarding (session-derived workspace) =====
        try:
            if method == "GET" and path == "/api/v1/onboarding/status":
                return self._onboarding_status(headers)
            if method == "POST" and path == "/api/v1/onboarding/linear/start":
                return self._onboarding_linear_start(raw_body, headers)
            if method == "GET" and path == "/api/v1/onboarding/linear/scope":
                return await self._onboarding_linear_scope(headers)
            if method == "POST" and path == "/api/v1/onboarding/scope":
                return self._onboarding_scope(raw_body, headers)
            if method == "POST" and path == "/api/v1/onboarding/repository":
                return self._onboarding_repository(raw_body, headers)
            if method == "POST" and path == "/api/v1/onboarding/runtime/enrollment-token":
                return self._onboarding_enrollment_token(raw_body, headers)
            if method == "GET" and path == "/api/v1/onboarding/runtime/status":
                return self._onboarding_runtime_status(headers)
            if method == "POST" and path == "/api/v1/onboarding/smoke-check":
                return self._onboarding_smoke_check(raw_body, headers)
            if method == "GET" and path == "/api/v1/onboarding/smoke-check/result":
                return self._onboarding_smoke_result(headers)
        except Unauthenticated:
            return self._unauthenticated()

        # ===== BFF: runtimes =====
        # Machine-called enroll/heartbeat routes are token/enrollment-based, NOT
        # user-session gated.
        if method == "POST" and path == "/api/v1/runtimes/enroll":
            return self._runtime_enroll(raw_body)
        if method == "POST" and path.startswith("/api/v1/runtimes/") and path.endswith("/heartbeat"):
            runtime_id = path[len("/api/v1/runtimes/"):-len("/heartbeat")]
            return self._runtime_heartbeat(runtime_id, raw_body)
        # Listing/detail are user-facing but runtime records are global today.
        try:
            if method == "GET" and path == "/api/v1/runtimes":
                self._require_user(headers)
                return self._list_runtimes()
            if method == "GET" and path.startswith("/api/v1/runtimes/"):
                self._require_user(headers)
                runtime_id = path[len("/api/v1/runtimes/"):]
                return self._runtime_detail(runtime_id)

            # ===== BFF: runs =====
            if method == "GET" and path == "/api/v1/runs/recent":
                self._require_user(headers)
                return self._recent_runs(query)
            if method == "GET" and path.startswith("/api/v1/runs/"):
                self._require_user(headers)
                run_id = path[len("/api/v1/runs/"):]
                return self._run_detail(run_id)
        except Unauthenticated:
            return self._unauthenticated()

        # ===== Static assets / SPA fallback (non-API GET only) =====
        if method == "GET" and not path.startswith("/api/"):
            static = self._serve_static(path)
            if static is not None:
                return static

        return 404, _error("not_found", f"Route not found: {path}")

    def _serve_static(self, path: str) -> tuple[int, RawResponse] | None:
        static_files = getattr(self.server, "static_files", None)
        if static_files is None:
            return None
        return static_files.serve(path)

    # ===== Session helpers =====

    def _session_id(self, headers: dict[str, str]) -> str:
        """Extract the podium_session cookie value from the Cookie header."""
        raw = headers.get("cookie") or ""
        for part in raw.split(";"):
            name, _, value = part.strip().partition("=")
            if name == SESSION_COOKIE:
                return value.strip()
        return ""

    def _current_user(self, headers: dict[str, str]) -> User | None:
        auth = getattr(self.server, "auth_service", None)
        if auth is None:
            return None
        return auth.session_user(self._session_id(headers))

    def _require_user(self, headers: dict[str, str]) -> User:
        user = self._current_user(headers)
        if user is None:
            raise Unauthenticated()
        return user

    def _unauthenticated(self) -> tuple[int, dict[str, Any]]:
        return 401, _error("unauthenticated", "Authentication required")

    def _auth_unavailable(self) -> tuple[int, dict[str, Any]]:
        return 500, _error(
            "auth_unavailable",
            "Authentication is not configured (missing PODIUM_SECRET_KEY)",
        )

    # ===== Auth handlers =====

    def _auth_register(self, raw_body: bytes) -> tuple[int, dict[str, Any]]:
        from podium.auth_service import AuthError

        auth = getattr(self.server, "auth_service", None)
        if auth is None:
            return self._auth_unavailable()
        payload, error = _parse_json(raw_body)
        if error:
            return error
        try:
            user = auth.register(
                str(payload.get("email") or ""),
                str(payload.get("password") or ""),
            )
            session = auth.create_session(user)
        except AuthError as exc:
            return 400, _error(exc.code, exc.message)
        self.pending_cookie = SetCookie(SESSION_COOKIE, session.session_id)
        return 200, {"user": user.to_public_dict()}

    def _auth_login(self, raw_body: bytes) -> tuple[int, dict[str, Any]]:
        from podium.auth_service import AuthError

        auth = getattr(self.server, "auth_service", None)
        if auth is None:
            return self._auth_unavailable()
        payload, error = _parse_json(raw_body)
        if error:
            return error
        try:
            user = auth.authenticate(
                str(payload.get("email") or ""),
                str(payload.get("password") or ""),
            )
            session = auth.create_session(user)
        except AuthError as exc:
            return 401, _error(exc.code, exc.message)
        self.pending_cookie = SetCookie(SESSION_COOKIE, session.session_id)
        return 200, {"user": user.to_public_dict()}

    def _auth_logout(self, headers: dict[str, str]) -> tuple[int, dict[str, Any]]:
        auth = getattr(self.server, "auth_service", None)
        if auth is not None:
            auth.delete_session(self._session_id(headers))
        self.pending_cookie = SetCookie(SESSION_COOKIE, "", max_age=0)
        return 200, {"ok": True}

    def _auth_me(self, headers: dict[str, str]) -> tuple[int, dict[str, Any]]:
        user = self._current_user(headers)
        if user is None:
            return self._unauthenticated()
        return 200, {"user": user.to_public_dict()}

    # ===== Account: custom Linear app =====

    def _account_set_linear_app(
        self, raw_body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, Any]]:
        user = self._current_user(headers)
        if user is None:
            return self._unauthenticated()
        auth = self.server.auth_service
        payload, error = _parse_json(raw_body)
        if error:
            return error
        client_id = str(payload.get("client_id") or "").strip()
        client_secret = str(payload.get("client_secret") or "").strip()
        redirect_uri = payload.get("redirect_uri")
        redirect_uri = str(redirect_uri).strip() if redirect_uri else None
        if not client_id or not client_secret:
            return 400, _error(
                "invalid_request", "client_id and client_secret are required"
            )
        try:
            updated = auth.set_linear_app(user, client_id, client_secret, redirect_uri)
        except RuntimeError as exc:
            return 500, _error("encryption_unavailable", str(exc))
        return 200, {"linear_app": updated.linear_app.to_public_dict()}

    def _account_clear_linear_app(
        self, headers: dict[str, str]
    ) -> tuple[int, dict[str, Any]]:
        user = self._current_user(headers)
        if user is None:
            return self._unauthenticated()
        self.server.auth_service.clear_linear_app(user)
        return 200, {"ok": True, "linear_app": None}

    # ===== BFF handlers =====

    def _bootstrap(self, headers: dict[str, str]) -> tuple[int, dict[str, Any]]:
        user = self._require_user(headers)
        workspace_id = user.workspace_id
        server = self.server
        session = SessionIdentity(workspace_id=workspace_id, user_id=user.user_id)
        progress = server.onboarding_service.get_progress(workspace_id)
        linear_status = server.linear_service.connection_status(workspace_id)
        return 200, {
            "session": session.to_dict(),
            "onboarding": progress.to_dict(),
            "linear": linear_status.to_dict() if linear_status else {"state": "not_connected", "workspace_id": workspace_id},
        }

    def _onboarding_status(self, headers: dict[str, str]) -> tuple[int, dict[str, Any]]:
        user = self._require_user(headers)
        progress = self.server.onboarding_service.get_progress(user.workspace_id)
        return 200, progress.to_dict()

    def _onboarding_linear_start(
        self, raw_body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, Any]]:
        user = self._require_user(headers)
        payload, error = _parse_json(raw_body)
        if error:
            return error
        workspace_id = user.workspace_id
        url = self.server.linear_service.build_authorization_url(state=workspace_id)
        return 200, {"authorization_url": url, "workspace_id": workspace_id}

    async def _onboarding_linear_scope(
        self, headers: dict[str, str]
    ) -> tuple[int, dict[str, Any]]:
        user = self._require_user(headers)
        workspace_id = user.workspace_id
        server = self.server
        installation = server.linear_service.get_installation(workspace_id)
        if not installation:
            return 400, _error("linear_installation_not_found", "Linear installation not found")
        graphql_query = (
            "query Scope { teams { nodes { id name } } projects { nodes { id name } } }"
        )
        result = await server.linear_service.forward_graphql(
            {"query": graphql_query},
            str(installation.get("access_token") or ""),
        )
        data = result.get("data") or {}
        teams = (data.get("teams") or {}).get("nodes") or []
        projects = (data.get("projects") or {}).get("nodes") or []
        return 200, {"teams": teams, "projects": projects}

    def _onboarding_scope(
        self, raw_body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, Any]]:
        user = self._require_user(headers)
        payload, error = _parse_json(raw_body)
        if error:
            return error
        workspace_id = user.workspace_id
        scope = {
            "teams": payload.get("teams") or [],
            "projects": payload.get("projects") or [],
        }
        progress = self.server.onboarding_service.save_scope(workspace_id, scope)
        return 200, {"onboarding": progress.to_dict()}

    def _onboarding_repository(
        self, raw_body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, Any]]:
        user = self._require_user(headers)
        payload, error = _parse_json(raw_body)
        if error:
            return error
        workspace_id = user.workspace_id
        mode = str(payload.get("mode") or "")
        value = str(payload.get("value") or "")
        try:
            RepositoryMappingMode(mode)
        except ValueError:
            return 400, _error("invalid_mode", "mode must be 'local_path' or 'git_url'")
        mapping, progress = self.server.onboarding_service.save_repository(workspace_id, mode, value)
        return 200, {"repository": mapping.to_dict(), "onboarding": progress.to_dict()}

    def _onboarding_enrollment_token(
        self, raw_body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, Any]]:
        user = self._require_user(headers)
        payload, error = _parse_json(raw_body)
        if error:
            return error
        workspace_id = user.workspace_id
        server = self.server
        token = server.runtime_service.generate_enrollment_token(workspace_id)
        return 200, {
            "enrollment_token": token,
            "workspace_id": workspace_id,
            "install_command": server.build_install_command(token),
            "expires_at": server.runtime_service.enrollment_token_expires_at(token),
        }

    def _onboarding_runtime_status(
        self, headers: dict[str, str]
    ) -> tuple[int, dict[str, Any]]:
        user = self._require_user(headers)
        return 200, self.server.runtime_service.enrollment_status(user.workspace_id)

    def _onboarding_smoke_check(
        self, raw_body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, Any]]:
        user = self._require_user(headers)
        payload, error = _parse_json(raw_body)
        if error:
            return error
        result = self.server.onboarding_service.run_smoke_check(user.workspace_id)
        return 200, result.to_dict()

    def _onboarding_smoke_result(
        self, headers: dict[str, str]
    ) -> tuple[int, dict[str, Any]]:
        user = self._require_user(headers)
        result = self.server.onboarding_service.get_smoke_result(user.workspace_id)
        if not result:
            return 404, _error("not_found", "No smoke check result found")
        return 200, result.to_dict()

    def _list_runtimes(self) -> tuple[int, dict[str, Any]]:
        runtimes = self.server.runtime_service.list_runtimes()
        return 200, {"runtimes": [r.to_dict() for r in runtimes]}

    def _runtime_enroll(self, raw_body: bytes) -> tuple[int, dict[str, Any]]:
        """
        POST /api/v1/runtimes/enroll — a real runtime (Conductor) enrolls with a
        one-time enrollment token, coming online. Closes the onboarding loop.
        """
        payload, error = _parse_json(raw_body)
        if error:
            return error
        token = str(payload.get("enrollment_token") or "").strip()
        if not token:
            return 400, _error("invalid_enrollment_token", "enrollment_token is required")
        metadata = payload.get("metadata")
        record = self.server.runtime_service.enroll_runtime(
            token,
            hostname=str(payload["hostname"]) if payload.get("hostname") else None,
            version=str(payload["version"]) if payload.get("version") else None,
            metadata=metadata if isinstance(metadata, dict) else None,
        )
        if record is None:
            return 400, _error(
                "invalid_enrollment_token",
                "Enrollment token is invalid, expired, or already used. Generate a new one in the runtime setup step.",
            )
        return 200, record.to_dict()

    def _runtime_heartbeat(self, runtime_id: str, raw_body: bytes) -> tuple[int, dict[str, Any]]:
        """POST /api/v1/runtimes/:id/heartbeat — keep an enrolled runtime online."""
        payload, error = _parse_json(raw_body)
        if error:
            return error
        record = self.server.runtime_service.heartbeat(
            runtime_id,
            version=str(payload["version"]) if payload.get("version") else None,
            status=str(payload["status"]) if payload.get("status") else None,
        )
        if record is None:
            return 404, _error("not_found", f"Runtime not found: {runtime_id}")
        return 200, record.to_dict()

    def _runtime_detail(self, runtime_id: str) -> tuple[int, dict[str, Any]]:
        record = self.server.runtime_service.get_runtime(runtime_id)
        if not record:
            return 404, _error("not_found", f"Runtime not found: {runtime_id}")
        return 200, record.to_dict()

    def _recent_runs(self, query: dict[str, str]) -> tuple[int, dict[str, Any]]:
        try:
            limit = int(query.get("limit", "10"))
        except ValueError:
            limit = 10
        runs = self.server.runtime_service.recent_runs(limit=limit)
        return 200, {"runs": [r.to_dict() for r in runs]}

    def _run_detail(self, run_id: str) -> tuple[int, dict[str, Any]]:
        run = self.server.runtime_service.get_run(run_id)
        if not run:
            return 404, _error("not_found", f"Run not found: {run_id}")
        return 200, run.to_dict()
