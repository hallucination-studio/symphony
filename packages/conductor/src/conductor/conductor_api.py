from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Any
from urllib.parse import parse_qs

import httpx

from .models import ConductorServiceError, InstanceCreateRequest, InstancePatchRequest, InstanceRecord
from .conductor_service import ConductorService
from .conductor_smoke_protocol import sanitize_reason


LOGGER = logging.getLogger(__name__)


class ConductorApiServer:
    def __init__(self, service: ConductorService):
        self.service = service
        self._server: asyncio.AbstractServer | None = None
        self._podium_poll_task: asyncio.Task[None] | None = None
        self._report_tick = 0
        self.port: int | None = None

    async def start(self, *, host: str = "127.0.0.1", port: int = 0) -> None:
        self._server = await asyncio.start_server(self._handle_connection, host, port)
        socket = self._server.sockets[0]
        self.port = int(socket.getsockname()[1])
        self._podium_poll_task = asyncio.create_task(self._poll_podium_dispatches())

    async def stop(self) -> None:
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
                result = await self._poll_once()
                if result.get("reason") == "runtime_unauthorized":
                    await asyncio.sleep(60)
                    continue
                self._report_tick += 1
                if self._report_tick >= 10:
                    self._report_tick = 0
                    await self.service.post_podium_report()
                delay = 1.0
            except Exception as exc:
                LOGGER.error(
                    "event=conductor_podium_poll_failed error_type=%s error_code=podium_poll_failed "
                    "sanitized_reason=%s action_required=inspect_conductor_log retryable=true next_action=retry_poll",
                    exc.__class__.__name__,
                    sanitize_reason(exc),
                )
                delay = min(max(delay * 2, 5), 60)
            await asyncio.sleep(_jitter(delay))

    async def _poll_once(self) -> dict[str, Any]:
        await self.service.post_podium_report()
        command = await self._poll_command_once()
        if command.get("reason") == "runtime_unauthorized":
            return command
        dispatch = await self.service.poll_podium_dispatch_once()
        if dispatch.get("reason") == "runtime_unauthorized":
            return dispatch
        await self.service.coordinate_background_once()
        return dispatch

    async def _poll_command_once(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> dict[str, Any]:
        settings = self.service.store.get_settings()
        podium_url = settings.podium_url.strip().rstrip("/")
        runtime_token = settings.podium_runtime_token.strip()
        if not podium_url or not runtime_token:
            return {"status": "skipped", "reason": "runtime_not_configured"}
        headers = {"Authorization": f"Bearer {runtime_token}"}
        async with httpx.AsyncClient(timeout=10, trust_env=False, transport=transport) as client:
            lease_response = await client.post(f"{podium_url}/api/v1/runtime/commands/lease", headers=headers)
            if lease_response.status_code == 401:
                return {"status": "skipped", "reason": "runtime_unauthorized"}
            lease_response.raise_for_status()
            command = lease_response.json().get("command")
            if not command:
                return {"status": "idle"}
            try:
                payload = command.get("command") if isinstance(command.get("command"), dict) else None
                if payload is None:
                    raise ValueError("runtime_command_payload_invalid")
                result = await self.service.handle_podium_command(payload)
                result = {**result, "command_type": str(payload.get("type") or "")}
                ack_status = "failed" if result.get("status") in {"failed", "rejected", "error"} else "completed"
            except Exception as exc:
                result = {
                    "status": "failed",
                    "error_code": "runtime_command_failed",
                    "sanitized_reason": sanitize_reason(exc),
                }
                ack_status = "failed"
            ack_response = await client.post(
                f"{podium_url}/api/v1/runtime/commands/ack",
                headers=headers,
                json={
                    "command_id": command.get("id"),
                    "fencing_token": command.get("fencing_token"),
                    "status": ack_status,
                    "result": result,
                },
            )
            if ack_response.status_code == 401:
                return {"status": "skipped", "reason": "runtime_unauthorized"}
            if ack_response.status_code == 409:
                return {"status": "stale", "reason": "stale_runtime_command_lease"}
            ack_response.raise_for_status()
        return {"status": "handled", "command": command, "result": result}

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
            self._write_response(writer, 500, {"error": {"code": "internal_error", "message": sanitize_reason(exc)}})
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
    ) -> tuple[int, dict[str, Any]]:
        body = json.loads(raw_body.decode() or "{}") if raw_body else {}
        query = query or {}
        try:
            if method == "GET" and path == "/":
                return 200, {"service": "conductor", "status": "ok"}
            if method == "GET" and path == "/api/managed-runs":
                return 200, {"managed_runs": self.service.managed_run_view()}
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
                _reject_legacy_instance_fields(body)
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
    ) -> tuple[int, dict[str, Any]]:
        query = query or {}
        suffix = path.removeprefix("/api/instances/")
        if "/" in suffix:
            instance_id, action = suffix.split("/", 1)
        else:
            instance_id, action = suffix, ""
        if method == "GET" and not action:
            instance = self.service.get_instance(instance_id)
            if instance is None:
                return 404, {"error": {"code": "instance_not_found", "message": f"Instance not found: {instance_id}"}}
            return 200, {"instance": _public_instance(instance)}
        if method == "PATCH" and not action:
            _reject_legacy_instance_fields(body)
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
        return 404, {"error": {"code": "not_found", "message": f"Route not found: {path}"}}

    def _write_response(self, writer: asyncio.StreamWriter, status: int, payload: dict[str, Any]) -> None:
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


def _reject_legacy_instance_fields(body: dict[str, Any]) -> None:
    if "managed_run_profile" in body:
        raise ConductorServiceError(
            "legacy_runtime_profile_field",
            "managed_run_profile is no longer accepted by the instance API.",
        )
    if any(key in body for key in {"workflow_content", "workflow_path", "workflow_profile", "workflow_inputs", "pipeline_profile"}):
        raise ConductorServiceError(
            "workflow_runtime_surface_removed",
            "Runtime workflow fields are not part of the managed-run instance API.",
        )


def _public_instance(instance: InstanceRecord) -> dict[str, Any]:
    return instance.to_public_dict()


def _bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False
