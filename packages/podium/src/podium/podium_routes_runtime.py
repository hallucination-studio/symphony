from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import inspect
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

import httpx
from fastapi import FastAPI, Header, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from performer_api.pipeline import RuntimeConfigEnvelope

from .podium_install import shlex_quote
from .podium_shared import (
    dispatch_belongs_to_workspace,
    dispatch_public,
    hash_secret,
    optional_int,
    query_bool,
    run_public,
    runtime_belongs_to_workspace,
    runtime_public,
    sanitize_runtime_config,
    utc_now_iso,
)
from .podium_state import SecretDecryptionError


RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]


def register_runtime_routes(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    podium_base_url: str,
    linear_graphql_transport: Callable[[httpx.Request], Any] | None,
    error_response: ErrorResponse,
) -> None:
    def group_for_workspace(workspace_id: str) -> str:
        group_id = f"group_{workspace_id}"
        state.runtime_groups.setdefault(
            group_id,
            {
                "id": group_id,
                "linear_workspace_id": workspace_id,
                "project_slug": "",
                "linear_agent_app_user_id": "",
                "pipeline_profile": "default",
            },
        )
        state.persist()
        return group_id

    @app.post("/api/v1/onboarding/runtime/enrollment-token")
    async def onboarding_enrollment_token(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        group_id = group_for_workspace(workspace_id)
        token = secrets.token_urlsafe(32)
        token_hash = hash_secret(token)
        expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
        await state.save_enrollment_token(token_hash, runtime_group_id=group_id, expires_at=expires_at)
        install_command = (
            f"PODIUM_ENROLLMENT_TOKEN={shlex_quote(token)} "
            f"curl -fsSL {podium_base_url}/install.sh | "
            f"PODIUM_ENROLLMENT_TOKEN={shlex_quote(token)} "
            f"bash -s -- --podium-url {podium_base_url}"
        )
        return JSONResponse(
            {
                "enrollment_token": token,
                "install_command": install_command,
                "expires_at": expires_at.isoformat().replace("+00:00", "Z"),
            }
        )

    @app.get("/api/v1/onboarding/runtime/status")
    async def onboarding_runtime_status(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        group_id = f"group_{workspace_id}"
        await state.list_conductors_for_user(workspace_id)
        runtimes = [r for r in state.runtimes.values() if r["runtime_group_id"] == group_id]
        presence = await state.presence_snapshot([str(r["id"]) for r in runtimes])
        online = [r for r in runtimes if r["id"] in presence]
        token_pending = await state.has_pending_enrollment(group_id)
        if online:
            state.mark_runtime_enrolled(workspace_id)
        return JSONResponse(
            {
                "workspace_id": workspace_id,
                "token_pending": token_pending,
                "runtime_count": len(runtimes),
                "online_count": len(online),
                "enrolled": len(runtimes) > 0,
            }
        )

    @app.get("/api/v1/runtimes")
    async def list_runtimes(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        conductors = await state.list_conductors_for_user(workspace_id)
        runtime_ids = [
            str(runtime["id"])
            for runtime in state.runtimes.values()
            if runtime_belongs_to_workspace(runtime, workspace_id, state.runtime_groups)
        ]
        presence = await state.presence_snapshot(runtime_ids)
        return JSONResponse(
            {
                "conductors": conductors,
                "runtimes": [
                    runtime_public(runtime, presence)
                    for runtime in state.runtimes.values()
                    if runtime_belongs_to_workspace(runtime, workspace_id, state.runtime_groups)
                ],
            }
        )

    @app.get("/api/v1/runtimes/{runtime_id}")
    async def runtime_detail(runtime_id: str, request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        runtime = state.runtimes.get(runtime_id)
        if runtime is None or not runtime_belongs_to_workspace(runtime, workspace_id, state.runtime_groups):
            return error_response(404, "not_found", "Runtime not found")
        presence = await state.presence_snapshot([runtime_id])
        return JSONResponse(runtime_public(runtime, presence))

    @app.post("/api/v1/runtime/enrollment-tokens")
    async def create_enrollment_token(request: Request) -> dict[str, str]:
        payload = await request.json()
        token = secrets.token_urlsafe(32)
        token_hash = hash_secret(token)
        runtime_group_id = str(payload.get("runtime_group_id") or f"group_{len(state.runtime_groups) + 1}")
        linear_workspace_id = str(payload.get("linear_workspace_id") or "")
        project_slug = str(payload.get("project_slug") or "")
        state.runtime_groups.setdefault(
            runtime_group_id,
            {
                "id": runtime_group_id,
                "linear_workspace_id": linear_workspace_id,
                "project_slug": project_slug,
                "linear_agent_app_user_id": str(payload.get("linear_agent_app_user_id") or payload.get("agent_app_user_id") or ""),
                "pipeline_profile": str(payload.get("pipeline_profile") or "default"),
            },
        )
        state.persist()
        await state.save_enrollment_token(
            token_hash,
            runtime_group_id=runtime_group_id,
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        )
        return {"enrollment_token": token, "runtime_group_id": runtime_group_id}

    @app.post("/api/v1/runtime/enroll")
    async def enroll_runtime(request: Request) -> JSONResponse:
        payload = await request.json()
        enrollment_token = str(payload.get("enrollment_token") or "")
        token_row, token_error = await state.consume_enrollment_token(enrollment_token)
        if token_error == "invalid_enrollment_token":
            return error_response(400, "invalid_enrollment_token", "Enrollment token is invalid")
        if token_error == "enrollment_token_used":
            return error_response(400, "enrollment_token_used", "Enrollment token has already been used")
        if token_error == "enrollment_token_expired":
            return error_response(400, "enrollment_token_expired", "Enrollment token has expired")
        runtime_id = f"runtime_{secrets.token_urlsafe(12)}"
        runtime_token = secrets.token_urlsafe(32)
        proxy_token = secrets.token_urlsafe(32)
        runtime_group_id = str(token_row["runtime_group_id"])
        state.runtimes[runtime_id] = {
            "id": runtime_id,
            "runtime_group_id": runtime_group_id,
            "user_id": str((state.runtime_groups.get(runtime_group_id) or {}).get("linear_workspace_id") or ""),
            "runtime_token_hash": hash_secret(runtime_token),
            "proxy_token_hash": hash_secret(proxy_token),
            "disabled": False,
            "revoked": False,
            "created_at": utc_now_iso(),
        }
        conductor = state.ensure_conductor_record(runtime_id)
        if state.pg_store is not None:
            await state.pg_store.upsert_conductor(
                {
                    **conductor,
                    "runtime_token_hash": state.runtimes[runtime_id]["runtime_token_hash"],
                    "proxy_token_hash": state.runtimes[runtime_id]["proxy_token_hash"],
                }
            )
        state.persist()
        websocket_url = str(request.base_url).rstrip("/").replace("http://", "ws://").replace("https://", "wss://")
        return JSONResponse(
            {
                "runtime_id": runtime_id,
                "runtime_token": runtime_token,
                "proxy_token": proxy_token,
                "runtime_group_id": runtime_group_id,
                "websocket_url": f"{websocket_url}/api/v1/runtime/ws",
            }
        )

    @app.post("/api/v1/linear/webhooks/agent-session")
    async def linear_agent_session(request: Request, linear_signature: str | None = Header(default=None)) -> JSONResponse:
        raw = await request.body()
        if state.linear_webhook_secret:
            expected = hmac.new(state.linear_webhook_secret.encode(), raw, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(linear_signature or "", expected):
                return error_response(401, "invalid_signature", "Invalid Linear webhook signature")
        try:
            payload = json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            return error_response(400, "invalid_json", "Request body must be valid JSON")
        if payload.get("type") != "AgentSessionEvent":
            return JSONResponse({"status": "ignored", "queued": 0})
        event = normalize_agent_session_event(payload)
        queued = await state.queue_dispatches(event)
        return JSONResponse({"status": "accepted", "queued": queued})

    @app.post("/api/v1/runtime/dispatches/lease")
    async def lease_dispatch(authorization: str | None = Header(default=None)) -> JSONResponse:
        runtime = await state.runtime_for_bearer(authorization or "")
        if runtime is None:
            return error_response(401, "unauthorized", "Unauthorized")
        dispatch = await state.lease_dispatch(str(runtime["id"]))
        if dispatch is None:
            return JSONResponse({"dispatch": None})
        return JSONResponse({"dispatch": dispatch_public(dispatch)})

    @app.post("/api/v1/runtime/report")
    async def runtime_report(request: Request, authorization: str | None = Header(default=None)) -> JSONResponse:
        runtime = await state.runtime_for_bearer(authorization or "")
        if runtime is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        result = await state.apply_runtime_report(str(runtime["id"]), payload if isinstance(payload, dict) else {})
        pipeline = payload.get("pipeline") if isinstance(payload, dict) else None
        if isinstance(pipeline, dict):
            state.pipeline_views[str(runtime.get("runtime_group_id") or "")] = sanitize_runtime_config(pipeline)
            state.persist()
        group_id = str(runtime.get("runtime_group_id") or "")
        config = state.runtime_configs.get(group_id) or {}
        if isinstance(result, dict):
            result = {**result, "config": config}
        return JSONResponse(result)

    @app.post("/api/v1/runtime/config")
    async def runtime_config_push(request: Request, authorization: str | None = Header(default=None)) -> JSONResponse:
        runtime = await state.runtime_for_bearer(authorization or "")
        if runtime is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        if not isinstance(payload, dict):
            return error_response(400, "invalid_config", "Runtime config must be a JSON object")
        group_id = str(runtime.get("runtime_group_id") or "")
        config = {"runtime_group_id": group_id, **payload}
        try:
            RuntimeConfigEnvelope.from_dict(config).validate()
        except Exception as exc:
            response = error_response(400, "invalid_runtime_config", "Runtime config failed pipeline validation")
            body = json.loads(response.body.decode("utf-8"))
            body["error"]["details"] = str(exc)
            return JSONResponse(body, status_code=400)
        sanitized = sanitize_runtime_config(config)
        version = optional_int(sanitized.get("version"), 0) or 0
        current = state.runtime_configs.get(group_id)
        current_version = optional_int((current or {}).get("version"), 0) or 0
        if version <= current_version:
            return error_response(409, "stale_runtime_config", "Runtime config version must increase")
        state.runtime_configs[group_id] = sanitized
        state.persist()
        return JSONResponse({"accepted": True, "config": sanitized})

    @app.get("/api/v1/runtime/config")
    async def runtime_config_read(authorization: str | None = Header(default=None)) -> JSONResponse:
        runtime = await state.runtime_for_bearer(authorization or "")
        if runtime is None:
            return error_response(401, "unauthorized", "Unauthorized")
        group_id = str(runtime.get("runtime_group_id") or "")
        return JSONResponse({"config": state.runtime_configs.get(group_id) or {}})

    @app.get("/api/v1/pipeline")
    async def pipeline_view(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        group_id = f"group_{workspace_id}"
        config = state.runtime_configs.get(group_id) or {}
        view = state.pipeline_views.get(group_id) or {}
        browser_config = sanitize_runtime_config(config, hide_runtime_sources=True)
        scheduler_policy = browser_config.get("scheduler_policy") if isinstance(browser_config.get("scheduler_policy"), dict) else {}
        return JSONResponse(
            {
                "runtime_group_id": group_id,
                "policy_revision": optional_int(scheduler_policy.get("version"), optional_int(browser_config.get("version"), 0)) or 0,
                "profiles": browser_config.get("profiles") if isinstance(browser_config.get("profiles"), dict) else {},
                "pipeline": view,
            }
        )

    @app.get("/api/v1/runtimes/{conductor_id}/instances/{instance_id}/logs")
    async def runtime_instance_logs(conductor_id: str, instance_id: str, request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        if not state.conductor_belongs_to_user(conductor_id, str(user["id"])):
            return error_response(404, "not_found", "Conductor not found")
        tail = optional_int(request.query_params.get("tail"), 200)
        previous = query_bool(request.query_params.get("previous"))
        order = request.query_params.get("order") or "desc"
        if not previous:
            tail_row = state.instance_log_tails.get((conductor_id, instance_id))
            if tail_row is not None:
                lines = list(tail_row.get("lines") or [])
                if tail is not None:
                    lines = lines[:tail]
                return JSONResponse(
                    {
                        "logs": {
                            "conductor_id": conductor_id,
                            "instance_id": instance_id,
                            "generation": tail_row.get("generation"),
                            "order": order,
                            "lines": lines,
                            "cursor": tail_row.get("offset_end", 0),
                            "offset_end": tail_row.get("offset_end", 0),
                        }
                    }
                )
        command = await state.enqueue_runtime_command(
            conductor_id,
            {
                "type": "log.fetch",
                "request_id": secrets.token_urlsafe(12),
                "instance_id": instance_id,
                "tail": tail,
                "previous": previous,
                "order": order,
            },
        )
        return JSONResponse({"status": "pending", "request_id": command["request_id"]}, status_code=202)

    @app.post("/api/v1/runtime/log-chunks")
    async def runtime_log_chunks(request: Request, authorization: str | None = Header(default=None)) -> JSONResponse:
        runtime = await state.runtime_for_bearer(authorization or "")
        if runtime is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        result = await state.apply_log_chunk(str(runtime["id"]), payload if isinstance(payload, dict) else {})
        return JSONResponse({"status": "accepted", "request_id": result.get("request_id")})

    @app.get("/api/v1/runtime/log-fetches/{request_id}")
    async def runtime_log_fetch_result(request_id: str) -> JSONResponse:
        result = await state.get_log_fetch_result(request_id)
        if result is None:
            return error_response(404, "log_fetch_not_found", "Log fetch result not found")
        return JSONResponse({"logs": result})

    @app.post("/api/v1/runtime/dispatches/ack")
    async def ack_dispatch(request: Request, authorization: str | None = Header(default=None)) -> JSONResponse:
        runtime = await state.runtime_for_bearer(authorization or "")
        if runtime is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        try:
            raw_fencing_token = payload.get("fencing_token")
            fencing_token = int(raw_fencing_token) if raw_fencing_token not in {None, ""} else None
        except (TypeError, ValueError):
            return error_response(400, "invalid_fencing_token", "fencing_token must be an integer")
        dispatch = await state.ack_dispatch(
            str(runtime["id"]),
            str(payload.get("dispatch_id") or ""),
            str(payload.get("status") or "accepted"),
            fencing_token=fencing_token,
            reason=payload.get("reason") if isinstance(payload.get("reason"), str) else None,
            pipeline=_pipeline_ack_payload(payload),
        )
        if dispatch is None:
            return error_response(404, "dispatch_not_found", "Dispatch not found")
        if dispatch.get("_ack_error") == "stale_dispatch_lease":
            return error_response(409, "stale_dispatch_lease", "Dispatch lease fencing token is stale")
        return JSONResponse({"dispatch": dispatch_public(dispatch)})

    @app.websocket("/api/v1/runtime/ws")
    async def runtime_ws(websocket: WebSocket) -> None:
        runtime = await state.runtime_for_bearer(websocket.headers.get("authorization") or "")
        if runtime is None:
            await websocket.close(code=4401)
            return
        await websocket.accept()
        runtime_id = str(runtime["id"])
        queue = await state.attach_runtime_ws(runtime_id)
        forward_task = asyncio.create_task(_forward_runtime_commands(websocket, queue))
        redis_forward_task = (
            asyncio.create_task(_relay_redis_runtime_commands(state, runtime_id, queue))
            if state.redis_store is not None
            else None
        )
        try:
            while True:
                message = await websocket.receive_json()
                kind = str(message.get("type") or "")
                if kind in {"hello", "heartbeat"}:
                    await state.set_presence(runtime_id)
                    await websocket.send_json({"type": "ping"})
                elif kind == "dispatch.ack":
                    try:
                        raw_fencing_token = message.get("fencing_token")
                        fencing_token = int(raw_fencing_token) if raw_fencing_token not in {None, ""} else None
                    except (TypeError, ValueError):
                        await websocket.send_json(
                            {
                                "type": "error",
                                "code": "invalid_fencing_token",
                                "message": "fencing_token must be an integer",
                            }
                        )
                        continue
                    dispatch = await state.ack_dispatch(
                        runtime_id,
                        str(message.get("dispatch_id") or ""),
                        str(message.get("status") or "accepted"),
                        fencing_token=fencing_token,
                        reason=message.get("reason") if isinstance(message.get("reason"), str) else None,
                        pipeline=_pipeline_ack_payload(message),
                    )
                    await websocket.send_json({"type": "dispatch.ack.ok", "dispatch": dispatch_public(dispatch) if dispatch else None})
                else:
                    await websocket.send_json({"type": "error", "code": "unsupported_message"})
        except WebSocketDisconnect:
            pass
        finally:
            forward_task.cancel()
            if redis_forward_task is not None:
                redis_forward_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await forward_task
            if redis_forward_task is not None:
                with contextlib.suppress(asyncio.CancelledError):
                    await redis_forward_task
            await state.detach_runtime_ws(runtime_id)

    @app.post("/api/v1/linear/graphql")
    async def linear_graphql(request: Request, authorization: str | None = Header(default=None)) -> JSONResponse:
        runtime = await state.runtime_for_proxy_bearer(authorization or "")
        if runtime is None:
            await state.record_proxy_audit({"allowed": False, "reason": "unauthorized", "timestamp": utc_now_iso()})
            return error_response(401, "unauthorized", "Unauthorized")
        if runtime.get("disabled") or runtime.get("revoked"):
            await state.record_proxy_audit({"runtime_id": runtime["id"], "allowed": False, "reason": "runtime_disabled", "timestamp": utc_now_iso()})
            return error_response(401, "runtime_disabled", "Runtime is disabled")
        payload = await request.json()
        group_id = str(runtime.get("runtime_group_id") or "")
        group = state.runtime_groups.get(group_id) or {}
        workspace_id = str(group.get("linear_workspace_id") or "")
        try:
            installation = await state.get_linear_installation(workspace_id)
        except SecretDecryptionError:
            await state.record_proxy_audit({"runtime_id": runtime["id"], "allowed": False, "reason": "secret_decryption_failed", "timestamp": utc_now_iso()})
            return error_response(400, "secret_decryption_failed", "Stored Linear installation token could not be decrypted")
        upstream_token = str((installation or {}).get("access_token") or "").strip()
        if not upstream_token:
            upstream_token = os.environ.get("PODIUM_LINEAR_ACCESS_TOKEN", "").strip()
        upstream_endpoint = os.environ.get("PODIUM_LINEAR_ENDPOINT", "https://api.linear.app/graphql").strip()
        await state.record_proxy_audit(
            {
                "runtime_id": runtime["id"],
                "allowed": True,
                "operation_name": payload.get("operationName"),
                "workspace_id": workspace_id,
                "timestamp": utc_now_iso(),
            }
        )
        if upstream_token:
            transport = httpx.MockTransport(linear_graphql_transport) if linear_graphql_transport else None
            async with httpx.AsyncClient(timeout=30, trust_env=False, transport=transport) as client:
                upstream = await client.post(
                    upstream_endpoint,
                    json=payload,
                    headers={"Authorization": upstream_token, "Content-Type": "application/json"},
                )
            try:
                upstream_payload = upstream.json()
            except json.JSONDecodeError:
                upstream_payload = {"errors": [{"message": upstream.text}]}
            return JSONResponse(upstream_payload, status_code=upstream.status_code)
        return error_response(400, "linear_installation_not_found", "No Linear installation for runtime workspace")


async def _forward_runtime_commands(websocket: WebSocket, queue: asyncio.Queue[dict[str, Any]]) -> None:
    while True:
        command = await queue.get()
        await websocket.send_json(command)


async def _relay_redis_runtime_commands(
    state: Any,
    runtime_id: str,
    queue: asyncio.Queue[dict[str, Any]],
) -> None:
    if state.redis_store is None:
        return
    pubsub = await state.redis_store.subscribe_runtime_commands(runtime_id)
    try:
        while True:
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if not message:
                await asyncio.sleep(0.05)
                continue
            raw = message.get("data")
            try:
                command = json.loads(str(raw))
            except json.JSONDecodeError:
                continue
            if isinstance(command, dict):
                queue.put_nowait(command)
    finally:
        close = getattr(pubsub, "close", None)
        aclose = getattr(pubsub, "aclose", None)
        if callable(aclose):
            await aclose()
        elif callable(close):
            result = close()
            if inspect.isawaitable(result):
                await result


def _pipeline_ack_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        key: payload.get(key)
        for key in (
            "graph_id",
            "node_id",
            "attempt_id",
            "mode",
            "attempt_status",
            "graph_revision",
            "policy_revision",
            "lease_id",
        )
    }


def normalize_agent_session_event(payload: dict[str, Any]) -> dict[str, Any]:
    session = payload.get("agentSession") if isinstance(payload.get("agentSession"), dict) else {}
    issue = session.get("issue") if isinstance(session.get("issue"), dict) else {}
    project = issue.get("project") if isinstance(issue.get("project"), dict) else {}
    agent = session.get("agent") if isinstance(session.get("agent"), dict) else {}
    workspace = payload.get("workspace") if isinstance(payload.get("workspace"), dict) else {}
    parent = issue.get("parent") if isinstance(issue.get("parent"), dict) else payload.get("parent")
    pipeline_intent = payload.get("pipeline_intent")
    if not isinstance(pipeline_intent, dict):
        pipeline_intent = payload.get("intent")
    if not isinstance(pipeline_intent, dict):
        pipeline_intent = issue.get("pipeline_intent")
    if not isinstance(pipeline_intent, dict):
        pipeline_intent = issue.get("intent")
    return {
        "workspace_id": str(workspace.get("id") or payload.get("workspace_id") or ""),
        "project_slug": str(project.get("slugId") or payload.get("project_slug") or ""),
        "issue_id": str(issue.get("id") or payload.get("issue_id") or ""),
        "issue_identifier": str(issue.get("identifier") or payload.get("issue_identifier") or ""),
        "issue_title": str(issue.get("title") or payload.get("issue_title") or payload.get("title") or ""),
        "issue_description": str(
            issue.get("description") or payload.get("issue_description") or payload.get("description") or ""
        ),
        "agent_session_id": str(session.get("id") or payload.get("agent_session_id") or ""),
        "agent_app_user_id": str(
            session.get("appUserId")
            or session.get("app_user_id")
            or agent.get("appUserId")
            or agent.get("app_user_id")
            or payload.get("appUserId")
            or payload.get("app_user_id")
            or payload.get("agent_app_user_id")
            or ""
        ),
        "issue_delegate_id": str(((issue.get("delegate") or {}) if isinstance(issue.get("delegate"), dict) else {}).get("id") or ""),
        "blocked_by": _webhook_blocked_by_ids(issue.get("blocked_by") or payload.get("blocked_by")),
        "parent_issue_id": _webhook_ref_id(issue.get("parent_issue_id") or parent or payload.get("parent_issue_id")),
        "pipeline_intent": dict(pipeline_intent) if isinstance(pipeline_intent, dict) else {},
    }


def _webhook_blocked_by_ids(value: Any) -> list[str]:
    if value is None:
        return []
    raw_items = value if isinstance(value, list) else [value]
    result: list[str] = []
    for item in raw_items:
        ref = _webhook_ref_id(item)
        if ref:
            result.append(ref)
    return result


def _webhook_ref_id(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("id") or value.get("issue_id") or value.get("identifier") or "").strip()
    return str(value or "").strip()
