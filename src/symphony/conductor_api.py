from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs

from .conductor_models import InstanceCreateRequest, InstancePatchRequest
from .conductor_service import ConductorService, ConductorServiceError
from .conductor_web import favicon_ico, manage_web_concept_svg, render_console_html, web_asset_text


@dataclass(frozen=True)
class RawResponse:
    body: bytes
    content_type: str

    @classmethod
    def text(cls, content: str, content_type: str) -> RawResponse:
        return cls(content.encode(), content_type)


class ConductorApiServer:
    def __init__(self, service: ConductorService):
        self.service = service
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
            status, payload = await self._route(method.upper(), raw_path, raw_body, query)
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
        self, method: str, path: str, raw_body: bytes, query: dict[str, str] | None = None
    ) -> tuple[int, dict[str, Any] | RawResponse]:
        body = json.loads(raw_body.decode() or "{}") if raw_body else {}
        query = query or {}
        try:
            if method == "GET" and path == "/":
                return 200, RawResponse.text(render_console_html(), "text/html; charset=utf-8")
            if method == "GET" and path.startswith("/assets/"):
                asset = _web_asset(path)
                if asset is not None:
                    relative_path, content_type = asset
                    return 200, RawResponse.text(web_asset_text(relative_path), content_type)
            if method == "GET" and path == "/assets/manage-web-concept.svg":
                return 200, RawResponse.text(manage_web_concept_svg(), "image/svg+xml; charset=utf-8")
            if method == "GET" and path == "/favicon.ico":
                return 200, RawResponse(favicon_ico(), "image/x-icon")
            if method == "GET" and path == "/api/dashboard":
                return 200, {"dashboard": self.service.dashboard()}
            if method == "GET" and path == "/api/issues":
                return 200, {"issues": self.service.list_issues()}
            if method == "GET" and path.startswith("/api/issues/"):
                suffix = path.removeprefix("/api/issues/")
                if suffix.endswith("/pin"):
                    return 404, {"error": {"code": "not_found", "message": f"Route not found: {path}"}}
                return 200, {"issue": self.service.get_issue(suffix)}
            if method == "POST" and path.startswith("/api/issues/") and path.endswith("/pin"):
                issue_id = path.removeprefix("/api/issues/").removesuffix("/pin")
                return 200, {"retention": self.service.pin_issue(issue_id)}
            if method == "DELETE" and path.startswith("/api/issues/") and path.endswith("/pin"):
                issue_id = path.removeprefix("/api/issues/").removesuffix("/pin")
                return 200, {"retention": self.service.unpin_issue(issue_id)}
            if method == "GET" and path == "/api/runs":
                return 200, {"runs": self.service.list_runs()}
            if method == "GET" and path.startswith("/api/runs/"):
                return 200, {"run": self.service.get_run(path.removeprefix("/api/runs/"))}
            if method == "GET" and path == "/api/traces":
                return 200, {
                    "events": self.service.list_trace_events(
                        issue_id=query.get("issue_id"),
                        run_id=query.get("run_id"),
                        limit=_int(query.get("limit"), 200),
                    )
                }
            if method == "GET" and path == "/api/retention":
                return 200, {"retention": self.service.retention_status()}
            if method == "POST" and path == "/api/retention/collect":
                return 200, {"retention": self.service.collect_retention()}
            if method == "GET" and path == "/api/instances":
                return 200, {
                    "instances": [instance.to_dict(include_workflow_content=False) for instance in self.service.list_instances()]
                }
            if method == "GET" and path == "/api/settings":
                return 200, {"settings": self.service.settings().to_public_dict()}
            if method == "PATCH" and path == "/api/settings":
                settings = self.service.update_settings_json(body)
                return 200, {"settings": settings.to_public_dict()}
            if method == "POST" and path == "/api/instances/preview-workflow":
                instance, validation = self.service.preview_instance(InstanceCreateRequest(**body))
                return 200, {
                    "instance": instance.to_dict(),
                    "validation": validation.to_dict(),
                    "workflow_content": instance.workflow_content,
                }
            if method == "POST" and path == "/api/instances":
                instance = self.service.create_instance(InstanceCreateRequest(**body))
                return 201, {"instance": instance.to_dict()}
            if method == "POST" and path == "/api/repo/inspect":
                repo = self.service.inspect_repo(body["repo_source_type"], body["repo_source_value"])
                return 200, {"repo": repo}
            if method == "POST" and path == "/api/repo/clone":
                repo = self.service.clone_repo(body["repo_url"], body["target_path"])
                return 200, {"repo": repo}
            if method == "GET" and path == "/api/templates/workflow-profiles":
                return 200, {"profiles": self.service.available_workflow_profiles()}
            if path.startswith("/api/instances/"):
                return await self._route_instance(method, path, body)
        except ConductorServiceError as exc:
            return 400 if exc.code != "instance_not_found" else 404, {
                "error": {"code": exc.code, "message": str(exc), "diagnostics": exc.diagnostics}
            }
        return 404, {"error": {"code": "not_found", "message": f"Route not found: {path}"}}

    async def _route_instance(self, method: str, path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any] | RawResponse]:
        suffix = path.removeprefix("/api/instances/")
        if "/" in suffix:
            instance_id, action = suffix.split("/", 1)
        else:
            instance_id, action = suffix, ""
        if method == "GET" and not action:
            instance = self.service.get_instance(instance_id)
            if instance is None:
                return 404, {"error": {"code": "instance_not_found", "message": f"Instance not found: {instance_id}"}}
            return 200, {"instance": instance.to_dict()}
        if method == "PATCH" and not action:
            instance = self.service.update_instance(instance_id, InstancePatchRequest(**body))
            return 200, {"instance": instance.to_dict()}
        if method == "DELETE" and not action:
            self.service.delete_instance(instance_id)
            return 200, {"deleted": True}
        if method == "POST" and action == "generate-workflow":
            instance = self.service.generate_workflow(instance_id)
            return 200, {"instance": instance.to_dict()}
        if method == "POST" and action == "validate-workflow":
            validation = self.service.validate_workflow(instance_id, body.get("workflow_content", ""))
            return 200, {"validation": validation.to_dict()}
        if method == "POST" and action == "start":
            instance = await self.service.start_instance(instance_id)
            return 200, {"instance": instance.to_dict(include_workflow_content=False)}
        if method == "POST" and action == "stop":
            instance = await self.service.stop_instance(instance_id)
            return 200, {"instance": instance.to_dict(include_workflow_content=False)}
        if method == "POST" and action == "restart":
            instance = await self.service.restart_instance(instance_id)
            return 200, {"instance": instance.to_dict(include_workflow_content=False)}
        if method == "GET" and action == "logs":
            return 200, {"logs": self.service.instance_logs(instance_id)}
        if method == "GET" and action == "runtime":
            return 200, {"runtime": self.service.instance_runtime(instance_id)}
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
            201: "Created",
            400: "Bad Request",
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


def _int(value: Any, default: int) -> int:
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return default


def _web_asset(path: str) -> tuple[str, str] | None:
    assets = {
        "/assets/app.css": ("app.css", "text/css; charset=utf-8"),
        "/assets/app.js": ("app.js", "text/javascript; charset=utf-8"),
        "/assets/lib/api.js": ("lib/api.js", "text/javascript; charset=utf-8"),
        "/assets/lib/format.js": ("lib/format.js", "text/javascript; charset=utf-8"),
        "/assets/lib/state.js": ("lib/state.js", "text/javascript; charset=utf-8"),
        "/assets/views/issues.js": ("views/issues.js", "text/javascript; charset=utf-8"),
        "/assets/views/runs.js": ("views/runs.js", "text/javascript; charset=utf-8"),
    }
    return assets.get(path)
