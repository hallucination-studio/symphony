from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from typing import Any
from urllib.parse import parse_qs
from uuid import uuid4

import httpx
from performer_api.performer_control import (
    CONTROL_OPERATIONS,
    PerformerControlError,
    PerformerControlRequest,
    PerformerControlResult,
    PerformerSecretInput,
)
from performer_api.runtime_policy import RuntimePolicy, canonical_sha256

_LIVE_CONTROL_ERROR_CODES = frozenset(
    {
        "execution_policy_hash_mismatch",
        "performer_binding_generation_invalid",
        "performer_binding_required",
        "performer_capability_version_invalid",
        "performer_control_arguments_invalid",
        "performer_control_busy",
        "performer_control_process_exited",
        "performer_control_protocol_invalid",
        "performer_control_request_id_missing",
        "performer_control_timeout",
        "performer_login_secret_not_allowed",
        "performer_login_secret_required",
        "stale_fencing_token",
    }
)

from .models import ConductorServiceError, InstanceCreateRequest, InstancePatchRequest, InstanceRecord
from .conductor_service import ConductorService
from .conductor_smoke_protocol import sanitize_reason
from .performer_control import PerformerCoordinatorError


LOGGER = logging.getLogger(__name__)


class ConductorApiServer:
    def __init__(self, service: ConductorService):
        self.service = service
        self._server: asyncio.AbstractServer | None = None
        self._report_tick = 0
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
        live = await self._poll_live_once()
        if live.get("reason") == "runtime_unauthorized":
            return live
        command = await self._poll_command_once()
        if command.get("reason") == "runtime_unauthorized":
            return command
        # Apply Podium configuration before reporting the local binding. This lets a
        # Conductor refresh an older binding that Podium will reject until its
        # current profile has been applied.
        await self.service.post_podium_report()
        dispatch = await self.service.poll_podium_dispatch_once()
        if dispatch.get("reason") == "runtime_unauthorized":
            return dispatch
        await self.service.coordinate_background_once()
        return dispatch

    async def _poll_live_once(self, *, transport: httpx.AsyncBaseTransport | None = None) -> dict[str, Any]:
        settings = self.service.store.get_settings()
        podium_url = settings.podium_url.strip().rstrip("/")
        runtime_token = settings.podium_runtime_token.strip()
        if not podium_url or not runtime_token:
            return {"status": "skipped", "reason": "runtime_not_configured"}
        headers = {"Authorization": f"Bearer {runtime_token}"}
        async with httpx.AsyncClient(timeout=80, trust_env=False, transport=transport) as client:
            response = await client.post(f"{podium_url}/api/v1/runtime/live/lease", headers=headers)
            if response.status_code == 401:
                return {"status": "skipped", "reason": "runtime_unauthorized"}
            response.raise_for_status()
            request = response.json().get("request")
            if not request:
                return {"status": "idle"}
            operation = str(request.get("operation") or "")
            request_id = str(request.get("request_id") or uuid4().hex)
            try:
                deadline_ms = _safe_int(request.get("deadline_unix_ms"), 0)
                remaining = deadline_ms / 1000 - time.time() if deadline_ms else 30.0
                if remaining <= 0:
                    raise PerformerCoordinatorError(
                        "performer_control_timeout",
                        "Performer control lease expired before execution",
                        action_required=False,
                        retryable=True,
                        next_action="request_a_new_live_operation",
                    )
                control_request, secret_input = _build_live_control_request(self.service, request)
                events: list[dict[str, Any]] = []
                await self.service.ensure_performer_control_started()
                remaining = deadline_ms / 1000 - time.time() if deadline_ms else 30.0
                if remaining <= 0:
                    raise PerformerCoordinatorError(
                        "performer_control_timeout",
                        "Performer control lease expired before execution",
                        action_required=False,
                        retryable=True,
                        next_action="request_a_new_live_operation",
                    )
                control_result = await self.service.performer_coordinator.request(
                    control_request,
                    secret_input=secret_input,
                    timeout_seconds=min(remaining, 75.0),
                    event_collector=lambda event: events.append(event.to_dict()),
                )
                result = control_result.to_dict()
                self.service.apply_performer_control_result(control_result)
            except Exception as exc:
                result = _live_control_failure(request_id, operation, exc)
                if operation in CONTROL_OPERATIONS:
                    try:
                        self.service.apply_performer_control_result(
                            PerformerControlResult.from_dict(result)
                        )
                    except Exception as apply_exc:
                        LOGGER.error(
                            "event=performer_control_result_persist_failed operation=%s "
                            "error_code=performer_control_state_persist_failed sanitized_reason=%s "
                            "action_required=true retryable=true next_action=inspect_conductor_state",
                            operation,
                            sanitize_reason(apply_exc).replace(" ", "_")[:160],
                        )
                LOGGER.warning(
                    "event=conductor_live_operation_rejected operation=%s error_code=%s "
                    "sanitized_reason=%s action_required=%s retryable=%s next_action=%s",
                    operation.replace("\r", "_").replace("\n", "_")[:100],
                    str(result.get("error", {}).get("error_code") or result.get("error_code") or "performer_control_protocol_invalid"),
                    str(result.get("error", {}).get("sanitized_reason") or result.get("sanitized_reason") or "control_request_rejected").replace(" ", "_")[:160],
                    str(result.get("error", {}).get("action_required") if isinstance(result.get("error"), dict) else result.get("action_required", True)).lower(),
                    str(result.get("error", {}).get("retryable") if isinstance(result.get("error"), dict) else result.get("retryable", False)).lower(),
                    str(result.get("error", {}).get("next_action") if isinstance(result.get("error"), dict) else result.get("next_action", "inspect_performer_control")).replace(" ", "_")[:160],
                )
            reply = await client.post(
                f"{podium_url}/api/v1/runtime/live/reply",
                headers=headers,
                json={
                    "request_id": request_id,
                    "lease_token": request.get("lease_token"),
                    "result": result,
                    "events": events if "events" in locals() else [],
                },
            )
            if reply.status_code == 409:
                return {"status": "stale"}
            reply.raise_for_status()
            return {"status": "handled", "operation": operation}

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
                return 200, {
                    "managed_runs": self.service.managed_run_view(),
                    "performer_control": self.service.store.get_performer_control_state(),
                }
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


def _safe_int(value: Any, default: int) -> int:
    if isinstance(value, bool):
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _build_live_control_request(
    service: ConductorService,
    live_request: dict[str, Any],
) -> tuple[PerformerControlRequest, bytes | None]:
    expected_fields = {
        "request_id",
        "lease_token",
        "operation",
        "payload",
        "deadline_unix_ms",
    }
    if not isinstance(live_request, dict) or set(live_request) != expected_fields:
        raise ValueError("performer_control_protocol_invalid")
    operation = live_request.get("operation")
    if operation not in CONTROL_OPERATIONS:
        raise ValueError("unsupported_live_operation")
    request_id = live_request.get("request_id")
    lease_token = live_request.get("lease_token")
    deadline_unix_ms = live_request.get("deadline_unix_ms")
    if (
        not isinstance(request_id, str)
        or not request_id
        or not isinstance(lease_token, str)
        or not lease_token
        or isinstance(deadline_unix_ms, bool)
        or not isinstance(deadline_unix_ms, int)
        or deadline_unix_ms <= 0
    ):
        raise ValueError("performer_control_protocol_invalid")
    payload = live_request.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("performer_control_protocol_invalid")
    instances = service.store.list_instances()
    if len(instances) != 1:
        raise ValueError("performer_binding_required")
    filters = instances[0].linear_filters if isinstance(instances[0].linear_filters, dict) else {}
    performer_kind = str(filters.get("performer_kind") or "")
    if not performer_kind:
        raise ValueError("performer_binding_required")
    arguments: dict[str, Any]
    secret_input: bytes | None = None
    secret_meta: PerformerSecretInput | None = None
    if operation in {"performer.status", "performer.config.read"}:
        if payload:
            raise ValueError("performer_control_arguments_invalid")
        arguments = {}
    elif operation == "performer.login":
        method = str(payload.get("method") or "")
        expected_keys = {"method", "api_key"} if method == "api_key" else {"method"}
        if set(payload) != expected_keys:
            raise ValueError("performer_control_arguments_invalid")
        arguments = {"method": method}
        raw_secret = payload.get("api_key")
        if method == "api_key":
            if not isinstance(raw_secret, str) or not raw_secret:
                raise ValueError("performer_login_secret_required")
            secret_input = raw_secret.encode("utf-8")
            secret_meta = PerformerSecretInput(kind="api_key", length=len(secret_input))
        elif raw_secret is not None:
            raise ValueError("performer_login_secret_not_allowed")
    elif operation == "performer.session.delete":
        if set(payload) != {"action"}:
            raise ValueError("performer_control_arguments_invalid")
        arguments = {"action": str(payload.get("action") or "")}
    elif operation == "performer.config.write":
        if set(payload) != {"setting", "value"}:
            raise ValueError("performer_control_arguments_invalid")
        arguments = {"setting": payload.get("setting"), "value": payload.get("value")}
    else:  # performer.check
        if payload:
            raise ValueError("performer_control_arguments_invalid")
        policy = RuntimePolicy.from_dict(filters.get("execution_policy"))
        binding_generation = filters.get("performer_binding_generation")
        if isinstance(binding_generation, bool) or not isinstance(binding_generation, int) or binding_generation <= 0:
            raise ValueError("performer_binding_generation_invalid")
        arguments = {
            "binding_generation": binding_generation,
            "execution_policy": policy.to_dict(),
            "execution_policy_sha256": canonical_sha256(policy.to_dict()),
        }
    return (
        PerformerControlRequest(
            protocol_version=1,
            request_id=request_id,
            operation=operation,
            performer_kind=performer_kind,
            arguments=arguments,
            secret_input=secret_meta,
        ),
        secret_input,
    )


def _live_control_failure(request_id: str, operation: str, exc: Exception) -> dict[str, Any]:
    error_code = str(
        getattr(exc, "error_code", "") or getattr(exc, "code", "") or ""
    )
    if error_code not in _LIVE_CONTROL_ERROR_CODES:
        error_code = "performer_control_protocol_invalid"
    if operation not in CONTROL_OPERATIONS:
        error_code = "unsupported_live_operation"
    retryable = bool(getattr(exc, "retryable", False))
    action_required = bool(getattr(exc, "action_required", not retryable))
    next_action = "inspect_performer_control"
    sanitized_reason = "The Performer control request was rejected."
    if error_code != "performer_control_protocol_invalid":
        candidate_next_action = getattr(exc, "next_action", next_action)
        candidate_reason = getattr(exc, "sanitized_reason", sanitized_reason)
        if isinstance(candidate_next_action, str):
            next_action = candidate_next_action
        if isinstance(candidate_reason, str):
            sanitized_reason = candidate_reason
    if operation not in CONTROL_OPERATIONS:
        sanitized_reason = "The requested Performer operation is not supported."
        next_action = "Refresh Podium and retry with a supported Performer operation."
        retryable = False
        action_required = False
    try:
        error = PerformerControlError(
            error_code=error_code,
            sanitized_reason=sanitized_reason[:500],
            action_required=action_required,
            retryable=retryable,
            attempt_number=None,
            next_action=next_action[:500],
        )
    except ValueError:
        error = PerformerControlError(
            error_code="performer_control_protocol_invalid",
            sanitized_reason="The Performer control request was rejected.",
            action_required=True,
            retryable=False,
            attempt_number=None,
            next_action="inspect_performer_control",
        )
    if operation not in CONTROL_OPERATIONS:
        return {
            "status": "failed",
            "error_code": error.error_code,
            "sanitized_reason": error.sanitized_reason,
            "action_required": error.action_required,
            "retryable": error.retryable,
            "next_action": error.next_action,
        }
    return PerformerControlResult(
        protocol_version=1,
        request_id=request_id,
        operation=operation,
        status="failed",
        capabilities=None,
        readiness=None,
        account=None,
        login=None,
        configuration=None,
        check=None,
        error=error,
    ).to_dict()
