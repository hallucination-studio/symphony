from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .podium_routes_runtime_helpers import normalize_agent_session_event
from .podium_shared import utc_now_iso
from .podium_state import SecretDecryptionError

ErrorResponse = Callable[[int, str, str], JSONResponse]
WEBHOOK_WINDOW_MILLISECONDS = 60_000


def register_linear_webhook_route(
    app: FastAPI,
    *,
    state: Any,
    error_response: ErrorResponse,
) -> None:
    @app.post("/api/v1/linear/webhooks")
    async def linear_webhook(request: Request) -> JSONResponse:
        raw = await request.body()
        try:
            payload = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return error_response(400, "invalid_linear_webhook", "Linear webhook body is invalid")
        if not isinstance(payload, dict):
            return error_response(400, "invalid_linear_webhook", "Linear webhook body is invalid")
        organization_id = str(payload.get("organizationId") or "")
        try:
            installation = await state.find_active_linear_installation(organization_id)
            application = (
                await state.get_linear_application_config(str(installation.get("application_config_id") or ""))
                if installation is not None
                else None
            )
        except SecretDecryptionError:
            return error_response(500, "linear_webhook_secret_unreadable", "Linear webhook credentials could not be decrypted")
        if installation is None or application is None:
            return error_response(401, "invalid_linear_webhook_signature", "Linear webhook signature is invalid")
        signature = str(request.headers.get("linear-signature") or "")
        expected = hmac.new(str(application["webhook_secret"]).encode(), raw, hashlib.sha256).hexdigest()
        if not signature or not hmac.compare_digest(signature, expected):
            return error_response(401, "invalid_linear_webhook_signature", "Linear webhook signature is invalid")
        if not _timestamp_is_fresh(payload.get("webhookTimestamp")):
            return error_response(401, "stale_linear_webhook", "Linear webhook timestamp is outside the replay window")
        delivery_id = str(request.headers.get("linear-delivery") or "")
        if not delivery_id:
            return error_response(400, "linear_delivery_required", "Linear-Delivery header is required")
        now = utc_now_iso()
        delivery = {
            "delivery_id": delivery_id,
            "installation_id": str(installation["id"]),
            "status": "received",
            "event_key": "",
            "error_code": "",
            "received_at": now,
            "updated_at": now,
        }
        if not await state.store.claim_linear_webhook_delivery(delivery):
            return JSONResponse({"status": "duplicate", "queued": 0, "delivery_id": delivery_id})
        event = normalize_agent_session_event(payload)
        error = await _validate_event(state, installation, event)
        if error is not None:
            delivery.update({"status": "rejected", "error_code": error[0], "updated_at": utc_now_iso()})
            await state.store.save_linear_webhook_delivery(delivery)
            return error_response(403, error[0], error[1])
        event.update(
            {
                "workspace_id": str(installation["user_id"]),
                "linear_organization_id": str(installation["linear_organization_id"]),
                "agent_app_user_id": str(installation["app_user_id"]),
            }
        )
        queued = await state.queue_dispatches(event)
        delivery.update(
            {
                "status": "accepted",
                "event_key": str(event.get("intake_key") or ""),
                "updated_at": utc_now_iso(),
            }
        )
        await state.store.save_linear_webhook_delivery(delivery)
        await state.update_linear_installation_health(
            installation,
            webhook_state="healthy",
            last_webhook_at=utc_now_iso(),
        )
        return JSONResponse({"status": "accepted", "queued": queued, "delivery_id": delivery_id})


async def _validate_event(
    state: Any,
    installation: dict[str, Any],
    event: dict[str, Any],
) -> tuple[str, str] | None:
    if str(event.get("linear_organization_id") or "") != str(installation.get("linear_organization_id") or ""):
        return "linear_webhook_installation_mismatch", "Linear webhook organization does not match installation"
    app_user_id = str(installation.get("app_user_id") or "")
    if str(event.get("agent_app_user_id") or "") != app_user_id:
        return "linear_webhook_installation_mismatch", "Linear webhook app user does not match installation"
    delegate_id = str(event.get("issue_delegate_id") or "")
    if delegate_id and delegate_id != app_user_id:
        return "linear_webhook_installation_mismatch", "Linear issue delegate does not match installation"
    project_id = str(event.get("linear_project_id") or "")
    selected = {
        str(row.get("linear_project_id") or ""): row
        for row in await state.list_selected_linear_projects(str(installation["user_id"]))
    }
    project = selected.get(project_id)
    if project is None:
        return "linear_project_not_selected", "Linear webhook project is not selected"
    binding = await state.store.get_active_project_binding_for_project(str(installation["user_id"]), project_id)
    if binding is None or binding.get("state") != "ready":
        return "linear_project_not_routable", "Linear webhook project has no ready Conductor binding"
    event["project_slug"] = str(project.get("project_slug") or "")
    return None


def _timestamp_is_fresh(value: Any) -> bool:
    try:
        timestamp = int(value)
    except (TypeError, ValueError):
        return False
    return abs(int(time.time() * 1000) - timestamp) <= WEBHOOK_WINDOW_MILLISECONDS
