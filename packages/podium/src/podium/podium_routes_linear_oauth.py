from __future__ import annotations

import logging
import secrets
import urllib.parse
from typing import Any, Awaitable, Callable

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

from .linear_constants import LINEAR_AUTHORIZE_URL, LINEAR_DEFAULT_SCOPE
from .linear_installation_acceptance import (
    LinearInstallationRejected,
    accepted_installation,
    exchange_authorization_code,
    fetch_installation_acceptance,
    invoke_hook,
    rejected_installation,
)
from .podium_linear_installations import LinearApplicationNotConfigured, LinearApplicationVersionConflict
from .podium_linear_projects import bound_project_access_rejection

RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]
LOGGER = logging.getLogger(__name__)

def register_linear_oauth_routes(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    linear_token_exchange: Callable[..., Any] | None,
    linear_installation_fetch: Callable[..., Any] | None,
    linear_graphql_transport: Callable[[httpx.Request], httpx.Response] | None,
    error_response: ErrorResponse,
) -> None:
    _register_installation_status_route(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )

    @app.post("/api/v1/linear/installations/oauth")
    async def start_linear_installation(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        try:
            config = await state.selected_linear_application(str(user["id"]))
        except (LinearApplicationNotConfigured, LinearApplicationVersionConflict) as exc:
            return error_response(400, str(exc), "Linear application is not configured")
        oauth = await state.create_linear_oauth_state(str(user["id"]), config)
        query = urllib.parse.urlencode(
            {
                "client_id": config["client_id"],
                "redirect_uri": config["callback_url"],
                "response_type": "code",
                "scope": LINEAR_DEFAULT_SCOPE,
                "actor": "app",
                "state": oauth["state"],
                "prompt": "consent",
                "code_challenge": oauth["code_challenge"],
                "code_challenge_method": "S256",
            }
        )
        return JSONResponse({"authorization_url": f"{LINEAR_AUTHORIZE_URL}?{query}"})

    @app.get("/api/v1/linear/oauth/callback")
    async def linear_callback(request: Request) -> Response:
        callback_id = secrets.token_urlsafe(12)
        callback_state = str(request.query_params.get("state") or "")
        if not callback_state:
            _log_callback(
                logging.WARNING,
                callback_id=callback_id,
                outcome="rejected",
                error_code="missing_state",
                sanitized_reason="OAuth callback state was missing",
                action_required="restart_authorization",
                retryable=True,
                next_action="restart_authorization",
            )
            return error_response(400, "missing_state", "Missing state parameter")
        state_record = await state.consume_linear_oauth_state(callback_state)
        if state_record is None:
            _log_callback(
                logging.WARNING,
                callback_id=callback_id,
                outcome="rejected",
                error_code="invalid_state",
                sanitized_reason="OAuth callback state was invalid or expired",
                action_required="restart_authorization",
                retryable=True,
                next_action="restart_authorization",
            )
            return error_response(400, "invalid_state", "Invalid or expired state parameter")
        user_id = str(state_record["workspace_id"])
        config = await state.get_linear_application_config(str(state_record["application_config_id"]))
        if not _state_matches_config(state_record, config):
            _log_callback(
                logging.WARNING,
                callback_id=callback_id,
                workspace_id=user_id,
                outcome="rejected",
                error_code="stale_application_config",
                sanitized_reason="OAuth application configuration changed",
                action_required="restart_authorization",
                retryable=True,
                next_action="restart_authorization",
            )
            return error_response(400, "stale_application_config", "OAuth application configuration changed")
        denied = str(request.query_params.get("error") or "")
        if denied:
            installation_id = await _record_denied_callback(
                state,
                user_id=user_id,
                config=config,
            )
            _log_callback(
                logging.INFO,
                callback_id=callback_id,
                workspace_id=user_id,
                installation_id=installation_id,
                outcome="denied",
                error_code="linear_oauth_denied",
                sanitized_reason="Linear authorization was not approved",
                action_required="reauthorize",
                retryable=False,
                next_action="reauthorize",
            )
            return _setup_redirect("denied", "linear_oauth_denied")
        code = str(request.query_params.get("code") or "")
        if not code:
            _log_callback(
                logging.WARNING,
                callback_id=callback_id,
                workspace_id=user_id,
                outcome="rejected",
                error_code="missing_code",
                sanitized_reason="OAuth authorization code was missing",
                action_required="restart_authorization",
                retryable=True,
                next_action="restart_authorization",
            )
            return _setup_redirect("error", "missing_code")
        return await _complete_callback(
            state=state,
            user_id=user_id,
            callback_id=callback_id,
            code=code,
            code_verifier=str(state_record["code_verifier"]),
            config=config,
            linear_token_exchange=linear_token_exchange,
            linear_installation_fetch=linear_installation_fetch,
            linear_graphql_transport=linear_graphql_transport,
            error_response=error_response,
        )


def _register_installation_status_route(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    error_response: ErrorResponse,
) -> None:
    @app.get("/api/v1/linear/installations")
    async def linear_installations(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        user_id = str(user["id"])
        active = await state.get_active_linear_installation(user_id)
        candidate = await state.get_candidate_linear_installation(user_id)
        revocation = await state.get_linear_revocation_failure(user_id)
        return JSONResponse(
            {
                "active": state.linear_installation_public(active),
                "candidate": state.linear_installation_public(candidate),
                "revocation": state.linear_installation_public(revocation),
            }
        )


async def _record_denied_callback(
    state: Any,
    *,
    user_id: str,
    config: dict[str, Any],
) -> str:
    rejection = LinearInstallationRejected(
        "linear_oauth_denied",
        "Linear authorization was not approved",
    )
    record = rejected_installation(
        user_id=user_id,
        application=config,
        installation_id=f"linear_installation_{secrets.token_urlsafe(12)}",
        rejection=rejection,
    )
    await state.save_linear_installation_record(record)
    return str(record["id"])


async def _complete_callback(
    *,
    state: Any,
    user_id: str,
    callback_id: str,
    code: str,
    code_verifier: str,
    config: dict[str, Any],
    linear_token_exchange: Callable[..., Any] | None,
    linear_installation_fetch: Callable[..., Any] | None,
    linear_graphql_transport: Callable[[httpx.Request], httpx.Response] | None,
    error_response: ErrorResponse,
) -> Response:
    installation_id = f"linear_installation_{secrets.token_urlsafe(12)}"
    try:
        token = await _exchange(code, code_verifier, config, linear_token_exchange)
        acceptance = await _fetch(str(token.get("access_token") or ""), linear_installation_fetch, linear_graphql_transport)
        record = accepted_installation(
            user_id=user_id,
            application=config,
            token=token,
            acceptance=acceptance,
            installation_id=installation_id,
        )
        active = await state.get_active_linear_installation(user_id)
        _validate_organization(active, record)
        await state.validate_candidate_project_access(user_id, record)
        await _save_accepted_installation(state, user_id, active, config, record)
    except LinearInstallationRejected as rejection:
        record = rejected_installation(
            user_id=user_id,
            application=config,
            installation_id=installation_id,
            rejection=rejection,
        )
        await state.save_linear_installation_record(record)
        _log_callback(
            logging.ERROR,
            callback_id=callback_id,
            workspace_id=user_id,
            installation_id=installation_id,
            outcome="rejected",
            error_type="LinearInstallationRejected",
            error_code=rejection.code,
            sanitized_reason=rejection.reason,
            action_required=rejection.next_action,
            retryable=rejection.retryable,
            next_action=rejection.next_action,
        )
        return _setup_redirect("error", rejection.code)
    except Exception:
        rejection = LinearInstallationRejected(
            "linear_oauth_callback_failed",
            "Linear OAuth callback failed",
            retryable=True,
            next_action="retry_authorization",
        )
        record = rejected_installation(
            user_id=user_id,
            application=config,
            installation_id=installation_id,
            rejection=rejection,
        )
        await state.save_linear_installation_record(record)
        _log_callback(
            logging.ERROR,
            callback_id=callback_id,
            workspace_id=user_id,
            installation_id=installation_id,
            outcome="failed",
            error_type="OAuthCallbackError",
            error_code=rejection.code,
            sanitized_reason=rejection.reason,
            action_required=rejection.next_action,
            retryable=True,
            next_action=rejection.next_action,
        )
        return _setup_redirect("error", rejection.code)
    await state.mark_linear_connected(user_id)
    _log_callback(
        logging.INFO,
        callback_id=callback_id,
        workspace_id=user_id,
        installation_id=installation_id,
        outcome="connected",
        error_code="none",
        sanitized_reason="Linear OAuth callback completed",
        action_required="review_projects",
        retryable=False,
        next_action="review_projects",
    )
    return _setup_redirect("connected")


def _log_callback(
    level: int,
    *,
    callback_id: str,
    outcome: str,
    error_code: str,
    sanitized_reason: str,
    action_required: str,
    retryable: bool,
    next_action: str,
    workspace_id: str = "",
    installation_id: str = "",
    error_type: str = "none",
) -> None:
    fields = [
        "event=podium_linear_oauth_callback_completed",
        f"callback_id={callback_id}",
    ]
    if workspace_id:
        fields.append(f"workspace_id={workspace_id}")
    if installation_id:
        fields.append(f"installation_id={installation_id}")
    fields.extend(
        (
            f"outcome={outcome}",
            f"error_type={error_type}",
            f"error_code={error_code}",
            f"sanitized_reason={sanitized_reason}",
            f"action_required={action_required}",
            f"retryable={str(retryable).lower()}",
            f"next_action={next_action}",
        )
    )
    LOGGER.log(level, " ".join(fields))


async def _exchange(
    code: str,
    code_verifier: str,
    config: dict[str, Any],
    hook: Callable[..., Any] | None,
) -> dict[str, Any]:
    result = (
        await invoke_hook(hook, code, config)
        if hook is not None
        else await exchange_authorization_code(code, config, code_verifier)
    )
    if not isinstance(result, dict):
        raise LinearInstallationRejected("linear_token_exchange_failed", "Linear token exchange returned invalid data")
    return result


async def _fetch(
    access_token: str,
    hook: Callable[..., Any] | None,
    transport: Callable[[httpx.Request], httpx.Response] | None,
) -> dict[str, Any]:
    result = await invoke_hook(hook, access_token) if hook is not None else await fetch_installation_acceptance(access_token, transport=transport)
    if not isinstance(result, dict):
        raise LinearInstallationRejected("linear_acceptance_query_failed", "Linear acceptance returned invalid data")
    return result


def _state_matches_config(record: dict[str, Any], config: dict[str, Any] | None) -> bool:
    return bool(
        config
        and str(config.get("id") or "") == str(record.get("application_config_id") or "")
        and str(config.get("user_id") or "") == str(record.get("workspace_id") or "")
        and int(config.get("version") or 0) == int(record.get("application_config_version") or 0)
    )


async def _save_accepted_installation(
    state: Any,
    user_id: str,
    active: dict[str, Any] | None,
    config: dict[str, Any],
    record: dict[str, Any],
) -> None:
    if active is None:
        await state.save_linear_installation_record(record)
        await state.activate_linear_installation(user_id, str(record["id"]))
        return
    active_config = await state.get_linear_application_config(str(active["application_config_id"]))
    same_identity = bool(
        active_config
        and active_config.get("client_id") == config.get("client_id")
        and active.get("linear_organization_id") == record.get("linear_organization_id")
        and active.get("app_user_id") == record.get("app_user_id")
    )
    if same_identity:
        active_id = str(active["id"])
        async with state.store.linear_installation_token_lock(active_id):
            current = await state.get_active_linear_installation(user_id)
            if current is None or str(current.get("id") or "") != active_id:
                raise LinearInstallationRejected(
                    "linear_reauthorization_required",
                    "Linear authorization changed before replacement completed",
                )
            record.update(
                {
                    "id": active_id,
                    "active": True,
                    "state": "ready",
                    "created_at": current["created_at"],
                }
            )
            reauthorized_projects = state.linear_projects_for_reauthorization(
                user_id,
                record,
            )
            blocked = await state.save_linear_installation_record(
                record,
                reauthorized_projects=reauthorized_projects,
            )
            if blocked:
                raise bound_project_access_rejection(blocked)
        await state.require_linear_project_review(user_id)
    else:
        record.update({"state": "draining", "next_action": "drain_managed_runs", "action_required": "wait"})
        await state.save_linear_installation_record(record)


def _validate_organization(active: dict[str, Any] | None, record: dict[str, Any]) -> None:
    if active and active.get("linear_organization_id") != record.get("linear_organization_id"):
        raise LinearInstallationRejected(
            "linear_organization_mismatch",
            "The application authorized a different Linear organization",
            next_action="reset_linear_workspace",
        )


def _setup_redirect(status: str, code: str = "") -> RedirectResponse:
    query = {"linear": status}
    if code:
        query["code"] = code
    return RedirectResponse(f"/setup/linear?{urllib.parse.urlencode(query)}", status_code=303)
