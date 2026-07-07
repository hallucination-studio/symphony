from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
import random
from typing import Any
from urllib.parse import parse_qs

from .conductor_models import InstanceCreateRequest, InstancePatchRequest, InstanceRecord
from .conductor_service import ConductorService, ConductorServiceError
from .podium_client import PodiumRuntimeClient


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
        self._podium_poll_task: asyncio.Task[None] | None = None
        self._podium_ws_task: asyncio.Task[None] | None = None
        self._report_tick = 0
        self.port: int | None = None

    async def start(self, *, host: str = "127.0.0.1", port: int = 0) -> None:
        self._server = await asyncio.start_server(self._handle_connection, host, port)
        socket = self._server.sockets[0]
        self.port = int(socket.getsockname()[1])
        self._podium_poll_task = asyncio.create_task(self._poll_podium_dispatches())
        self._podium_ws_task = asyncio.create_task(self._run_podium_ws())

    async def stop(self) -> None:
        if self._podium_ws_task is not None:
            self._podium_ws_task.cancel()
            try:
                await self._podium_ws_task
            except asyncio.CancelledError:
                pass
            self._podium_ws_task = None
        if self._podium_poll_task is not None:
            self._podium_poll_task.cancel()
            try:
                await self._podium_poll_task
            except asyncio.CancelledError:
                pass
            self._podium_poll_task = None
        if self._server is None:
            return
        self._server.close()
        await self._server.wait_closed()
        self._server = None

    async def _poll_podium_dispatches(self) -> None:
        delay = 1.0
        while True:
            try:
                await self.service.post_podium_report()
                result = await self.service.poll_podium_dispatch_once()
                if result.get("reason") == "runtime_unauthorized":
                    self.service.update_podium_connection("poll", status="unauthorized", error="runtime_unauthorized")
                    await asyncio.sleep(60)
                    continue
                self.service.update_podium_connection("poll", status="connected", error=None)
                await self.service.coordinate_background_once()
                self._report_tick += 1
                if self._report_tick >= 10:
                    self._report_tick = 0
                    await self.service.post_podium_report()
                delay = 1.0
            except Exception as exc:
                self.service.update_podium_connection("poll", status="error", error=str(exc))
                delay = min(max(delay * 2, 5), 60)
            await asyncio.sleep(_jitter(delay))

    async def _run_podium_ws(self) -> None:
        client = PodiumRuntimeClient(self.service)
        delay = 5.0
        while True:
            try:
                result = await client.run_ws_once()
                if result.get("reason") == "runtime_unauthorized":
                    self.service.update_podium_connection("ws", status="unauthorized", error="runtime_unauthorized")
                    return
                status = "connected" if result.get("status") == "ok" else str(result.get("status") or "idle")
                self.service.update_podium_connection("ws", status=status, error=None)
                delay = 5.0
            except Exception as exc:
                self.service.update_podium_connection("ws", status="error", error=str(exc))
                delay = min(max(delay * 2, 5), 60)
            await asyncio.sleep(_jitter(delay))

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
            status, payload = await self._route(method.upper(), raw_path, raw_body, query, headers)
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
        query: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, Any] | RawResponse]:
        body = json.loads(raw_body.decode() or "{}") if raw_body else {}
        query = query or {}
        try:
            if method == "GET" and path == "/":
                return 200, {"service": "conductor", "status": "ok"}
            if method == "GET" and path == "/api/pipeline":
                return 200, {"pipeline": self.service.pipeline_store.pipeline_view().to_dict()}
            if method == "POST" and path.startswith("/api/pipeline/human-waits/") and path.endswith("/human-answered"):
                wait_id = path.removeprefix("/api/pipeline/human-waits/").removesuffix("/human-answered")
                command = {
                    "type": "human.answered",
                    "wait_id": wait_id,
                    "child_issue_id": body.get("child_issue_id"),
                    "human_response": body.get("human_response") or body.get("response"),
                }
                return 200, await self.service.handle_podium_ws_command(command)
            if method == "GET" and path == "/api/instances":
                return 200, {
                    "instances": [_public_instance(instance) for instance in self.service.list_instances()]
                }
            if method == "GET" and path == "/api/settings":
                return 200, {"settings": self.service.settings().to_public_dict()}
            if method == "PATCH" and path == "/api/settings":
                settings = self.service.update_settings_json(body)
                return 200, {"settings": settings.to_public_dict()}
            if method == "POST" and path == "/api/instances":
                instance = self.service.create_instance(InstanceCreateRequest(**body))
                return 201, {"instance": _public_instance(instance)}
            if method == "POST" and path == "/api/repo/inspect":
                repo = self.service.inspect_repo(body["repo_source_type"], body["repo_source_value"])
                return 200, {"repo": repo}
            if method == "POST" and path == "/api/repo/clone":
                repo = self.service.clone_repo(body["repo_url"], body["target_path"])
                return 200, {"repo": repo}
            if path.startswith("/api/instances/"):
                return await self._route_instance(method, path, body, query)
        except ConductorServiceError as exc:
            return 400 if exc.code != "instance_not_found" else 404, {
                "error": {"code": exc.code, "message": str(exc), "diagnostics": exc.diagnostics}
            }
        return 404, {"error": {"code": "not_found", "message": f"Route not found: {path}"}}

    async def _route_instance(
        self, method: str, path: str, body: dict[str, Any], query: dict[str, str] | None = None
    ) -> tuple[int, dict[str, Any] | RawResponse]:
        query = query or {}
        suffix = path.removeprefix("/api/instances/")
        if "/" in suffix:
            instance_id, action = suffix.split("/", 1)
        else:
            instance_id, action = suffix, ""
        if method == "GET" and not action:
            instance = await self.service.get_instance_coordinated(instance_id)
            if instance is None:
                return 404, {"error": {"code": "instance_not_found", "message": f"Instance not found: {instance_id}"}}
            return 200, {"instance": _public_instance(instance)}
        if method == "PATCH" and not action:
            if any(key in body for key in {"workflow_content", "workflow_path", "workflow_profile", "workflow_inputs"}):
                raise ConductorServiceError(
                    "workflow_runtime_surface_removed",
                    "Runtime workflow fields are not part of the pipeline instance API.",
                )
            instance = self.service.update_instance(instance_id, InstancePatchRequest(**body))
            return 200, {"instance": _public_instance(instance)}
        if method == "DELETE" and not action:
            self.service.delete_instance(instance_id)
            return 200, {"deleted": True}
        if method == "POST" and action == "start":
            instance = await self.service.start_instance(instance_id)
            return 200, {"instance": _public_instance(instance)}
        if method == "POST" and action == "stop":
            instance = await self.service.stop_instance(instance_id)
            return 200, {"instance": _public_instance(instance)}
        if method == "POST" and action == "restart":
            instance = await self.service.restart_instance(instance_id)
            return 200, {"instance": _public_instance(instance)}
        if method == "GET" and action == "logs":
            if not query:
                return 200, {"logs": self.service.instance_logs(instance_id)}
            logs = self.service.query_instance_logs(
                instance_id,
                tail=_optional_int(query.get("tail"), 200),
                limit_bytes=_int(query.get("limit_bytes"), 1_048_576),
                previous=_bool(query.get("previous")),
                order=query.get("order", "desc"),
                timestamps=_bool(query.get("timestamps")),
                prefix=_bool(query.get("prefix")),
            )
            return 200, {"logs": logs}
        if method == "GET" and action == "runtime":
            return 200, {"runtime": self.service.instance_runtime(instance_id)}
        if method == "POST" and action == "runtime/approve-error":
            return 200, await self.service.approve_runtime_error(instance_id, issue_id=body.get("issue_id"))
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


def _int(value: Any, default: int) -> int:
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return default


def _jitter(seconds: float) -> float:
    return seconds + random.uniform(0, min(seconds * 0.1, 3.0))


def _optional_int(value: Any, default: int | None) -> int | None:
    if value is None:
        return default
    if isinstance(value, str) and value.strip().lower() in {"", "none", "null", "all"}:
        return None
    return _int(value, default or 0)


def _public_instance(instance: InstanceRecord) -> dict[str, Any]:
    return instance.to_public_dict()


def _bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False
