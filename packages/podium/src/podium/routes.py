from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from podium.models import RepositoryMappingMode, SessionIdentity

if TYPE_CHECKING:
    from podium.server import PodiumServer


@dataclass(frozen=True)
class RawResponse:
    body: bytes
    content_type: str

    @classmethod
    def text(cls, content: str, content_type: str) -> "RawResponse":
        return cls(content.encode(), content_type)


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

    async def route(
        self,
        method: str,
        path: str,
        raw_body: bytes,
        headers: dict[str, str],
        query: dict[str, str],
    ) -> tuple[int, dict[str, Any] | RawResponse]:
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

        # ===== BFF: bootstrap =====
        if method == "GET" and path == "/api/v1/bootstrap":
            return self._bootstrap(query)

        # ===== BFF: onboarding =====
        if method == "GET" and path == "/api/v1/onboarding/status":
            return self._onboarding_status(query)
        if method == "POST" and path == "/api/v1/onboarding/linear/start":
            return self._onboarding_linear_start(raw_body)
        if method == "GET" and path == "/api/v1/onboarding/linear/scope":
            return await self._onboarding_linear_scope(query)
        if method == "POST" and path == "/api/v1/onboarding/scope":
            return self._onboarding_scope(raw_body)
        if method == "POST" and path == "/api/v1/onboarding/repository":
            return self._onboarding_repository(raw_body)
        if method == "POST" and path == "/api/v1/onboarding/runtime/enrollment-token":
            return self._onboarding_enrollment_token(raw_body)
        if method == "GET" and path == "/api/v1/onboarding/runtime/status":
            return self._onboarding_runtime_status(query)
        if method == "POST" and path == "/api/v1/onboarding/smoke-check":
            return self._onboarding_smoke_check(raw_body)
        if method == "GET" and path == "/api/v1/onboarding/smoke-check/result":
            return self._onboarding_smoke_result(query)

        # ===== BFF: runtimes =====
        if method == "POST" and path == "/api/v1/runtimes/enroll":
            return self._runtime_enroll(raw_body)
        if method == "POST" and path.startswith("/api/v1/runtimes/") and path.endswith("/heartbeat"):
            runtime_id = path[len("/api/v1/runtimes/"):-len("/heartbeat")]
            return self._runtime_heartbeat(runtime_id, raw_body)
        if method == "GET" and path == "/api/v1/runtimes":
            return self._list_runtimes()
        if method == "GET" and path.startswith("/api/v1/runtimes/"):
            runtime_id = path[len("/api/v1/runtimes/"):]
            return self._runtime_detail(runtime_id)

        # ===== BFF: runs =====
        if method == "GET" and path == "/api/v1/runs/recent":
            return self._recent_runs(query)
        if method == "GET" and path.startswith("/api/v1/runs/"):
            run_id = path[len("/api/v1/runs/"):]
            return self._run_detail(run_id)

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

    # ===== BFF handlers =====

    def _bootstrap(self, query: dict[str, str]) -> tuple[int, dict[str, Any]]:
        workspace_id = str(query.get("workspace_id") or "default")
        server = self.server
        session = SessionIdentity(workspace_id=workspace_id)
        progress = server.onboarding_service.get_progress(workspace_id)
        linear_status = server.linear_service.connection_status(workspace_id)
        return 200, {
            "session": session.to_dict(),
            "onboarding": progress.to_dict(),
            "linear": linear_status.to_dict() if linear_status else {"state": "not_connected", "workspace_id": workspace_id},
        }

    def _onboarding_status(self, query: dict[str, str]) -> tuple[int, dict[str, Any]]:
        workspace_id = str(query.get("workspace_id") or "default")
        progress = self.server.onboarding_service.get_progress(workspace_id)
        return 200, progress.to_dict()

    def _onboarding_linear_start(self, raw_body: bytes) -> tuple[int, dict[str, Any]]:
        payload, error = _parse_json(raw_body)
        if error:
            return error
        workspace_id = str(payload.get("workspace_id") or "default")
        url = self.server.linear_service.build_authorization_url(state=workspace_id)
        return 200, {"authorization_url": url, "workspace_id": workspace_id}

    async def _onboarding_linear_scope(self, query: dict[str, str]) -> tuple[int, dict[str, Any]]:
        workspace_id = str(query.get("workspace_id") or "default")
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

    def _onboarding_scope(self, raw_body: bytes) -> tuple[int, dict[str, Any]]:
        payload, error = _parse_json(raw_body)
        if error:
            return error
        workspace_id = str(payload.get("workspace_id") or "default")
        scope = {
            "teams": payload.get("teams") or [],
            "projects": payload.get("projects") or [],
        }
        progress = self.server.onboarding_service.save_scope(workspace_id, scope)
        return 200, {"onboarding": progress.to_dict()}

    def _onboarding_repository(self, raw_body: bytes) -> tuple[int, dict[str, Any]]:
        payload, error = _parse_json(raw_body)
        if error:
            return error
        workspace_id = str(payload.get("workspace_id") or "default")
        mode = str(payload.get("mode") or "")
        value = str(payload.get("value") or "")
        try:
            RepositoryMappingMode(mode)
        except ValueError:
            return 400, _error("invalid_mode", "mode must be 'local_path' or 'git_url'")
        mapping, progress = self.server.onboarding_service.save_repository(workspace_id, mode, value)
        return 200, {"repository": mapping.to_dict(), "onboarding": progress.to_dict()}

    def _onboarding_enrollment_token(self, raw_body: bytes) -> tuple[int, dict[str, Any]]:
        payload, error = _parse_json(raw_body)
        if error:
            return error
        workspace_id = str(payload.get("workspace_id") or "default")
        server = self.server
        token = server.runtime_service.generate_enrollment_token(workspace_id)
        return 200, {
            "enrollment_token": token,
            "workspace_id": workspace_id,
            "install_command": server.build_install_command(token),
            "expires_at": server.runtime_service.enrollment_token_expires_at(token),
        }

    def _onboarding_runtime_status(self, query: dict[str, str]) -> tuple[int, dict[str, Any]]:
        workspace_id = str(query.get("workspace_id") or "default")
        return 200, self.server.runtime_service.enrollment_status(workspace_id)

    def _onboarding_smoke_check(self, raw_body: bytes) -> tuple[int, dict[str, Any]]:
        payload, error = _parse_json(raw_body)
        if error:
            return error
        workspace_id = str(payload.get("workspace_id") or "default")
        result = self.server.onboarding_service.run_smoke_check(workspace_id)
        return 200, result.to_dict()

    def _onboarding_smoke_result(self, query: dict[str, str]) -> tuple[int, dict[str, Any]]:
        workspace_id = str(query.get("workspace_id") or "default")
        result = self.server.onboarding_service.get_smoke_result(workspace_id)
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
