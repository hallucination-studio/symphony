from __future__ import annotations

import inspect
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

import httpx

from .linear_constants import (
    LINEAR_ACCEPTANCE_QUERY,
    LINEAR_GRAPHQL_URL,
    LINEAR_REQUIRED_SCOPES,
    LINEAR_TOKEN_URL,
    normalize_scopes,
)
from .podium_shared import utc_now_iso


class LinearInstallationRejected(RuntimeError):
    def __init__(self, code: str, reason: str, *, retryable: bool = False, next_action: str = "reauthorize") -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason
        self.retryable = retryable
        self.next_action = next_action


async def exchange_authorization_code(
    code: str,
    application: dict[str, Any],
    code_verifier: str,
) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
        response = await client.post(
            LINEAR_TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "client_id": application["client_id"],
                "client_secret": application["client_secret"],
                "redirect_uri": application["callback_url"],
                "code_verifier": code_verifier,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    payload = response.json()
    if response.status_code != 200 or not isinstance(payload, dict):
        raise LinearInstallationRejected("linear_token_exchange_failed", "Linear token exchange failed", retryable=True)
    return payload


async def fetch_installation_acceptance(
    access_token: str,
    *,
    transport: Callable[[httpx.Request], httpx.Response] | None = None,
) -> dict[str, Any]:
    client_transport = httpx.MockTransport(transport) if transport is not None else None
    async with httpx.AsyncClient(timeout=30, trust_env=False, transport=client_transport) as client:
        response = await client.post(
            LINEAR_GRAPHQL_URL,
            json={"query": LINEAR_ACCEPTANCE_QUERY},
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        )
    payload = response.json()
    if response.status_code != 200 or not isinstance(payload, dict) or payload.get("errors"):
        raise LinearInstallationRejected("linear_acceptance_query_failed", "Linear installation acceptance query failed", retryable=True)
    data = payload.get("data")
    return dict(data) if isinstance(data, dict) else {}


async def invoke_hook(hook: Callable[..., Any], *args: Any) -> Any:
    result = hook(*args)
    return await result if inspect.isawaitable(result) else result


def accepted_installation(
    *,
    user_id: str,
    application: dict[str, Any],
    token: dict[str, Any],
    acceptance: dict[str, Any],
    installation_id: str,
) -> dict[str, Any]:
    access_token, refresh_token, scopes, expires_at = _validate_token(token)
    viewer, organization, projects = _validate_identity(acceptance)
    now = utc_now_iso()
    return {
        "id": installation_id,
        "user_id": user_id,
        "application_config_id": str(application["id"]),
        "application_config_version": int(application["version"]),
        "application_source": str(application["source"]),
        "state": "accepted",
        "active": False,
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": str(token.get("token_type") or "Bearer"),
        "actor": "app",
        "scope": sorted(scopes),
        "expires_at": expires_at,
        "linear_organization_id": str(organization["id"]),
        "organization_url_key": str(organization["urlKey"]),
        "organization_name": str(organization["name"]),
        "app_user_id": str(viewer["id"]),
        "projects": projects,
        "reconciliation_state": "pending",
        "last_reconciliation_at": None,
        "reconciliation_error": "",
        "reconciliation_retry_count": 0,
        "error_code": "",
        "sanitized_reason": "",
        "retryable": False,
        "action_required": "",
        "next_action": "activate",
        "created_at": now,
        "updated_at": now,
    }


def rejected_installation(
    *,
    user_id: str,
    application: dict[str, Any],
    installation_id: str,
    rejection: LinearInstallationRejected,
) -> dict[str, Any]:
    now = utc_now_iso()
    return {
        "id": installation_id,
        "user_id": user_id,
        "application_config_id": str(application["id"]),
        "application_config_version": int(application["version"]),
        "application_source": str(application["source"]),
        "state": "failed",
        "active": False,
        "access_token": "",
        "refresh_token": "",
        "token_type": "",
        "actor": "",
        "scope": [],
        "expires_at": None,
        "linear_organization_id": "",
        "organization_url_key": "",
        "organization_name": "",
        "app_user_id": "",
        "projects": [],
        "reconciliation_state": "pending",
        "last_reconciliation_at": None,
        "reconciliation_error": "",
        "reconciliation_retry_count": 0,
        "error_code": rejection.code,
        "sanitized_reason": rejection.reason,
        "retryable": rejection.retryable,
        "action_required": rejection.next_action,
        "next_action": rejection.next_action,
        "created_at": now,
        "updated_at": now,
    }


def _validate_token(token: dict[str, Any]) -> tuple[str, str, set[str], str]:
    access_token = str(token.get("access_token") or "")
    refresh_token = str(token.get("refresh_token") or "")
    token_type = str(token.get("token_type") or "Bearer")
    actor = str(token.get("actor") or "app").lower()
    scopes = normalize_scopes(token.get("scope"))
    if not access_token or not refresh_token or token_type.lower() != "bearer":
        raise LinearInstallationRejected("linear_token_metadata_invalid", "Linear OAuth token metadata is incomplete")
    if actor != "app":
        raise LinearInstallationRejected("linear_actor_not_app", "Linear OAuth actor is not app")
    missing = sorted(LINEAR_REQUIRED_SCOPES - scopes)
    if missing:
        raise LinearInstallationRejected("linear_scope_missing", f"Linear OAuth scopes are missing: {', '.join(missing)}")
    unexpected = sorted(scopes - LINEAR_REQUIRED_SCOPES)
    if unexpected:
        raise LinearInstallationRejected(
            "linear_scope_unexpected",
            f"Linear OAuth scopes are unexpected: {', '.join(unexpected)}",
        )
    try:
        expires_in = int(token.get("expires_in") or 0)
    except (TypeError, ValueError) as exc:
        raise LinearInstallationRejected("linear_token_metadata_invalid", "Linear OAuth expiry metadata is invalid") from exc
    if expires_in <= 0:
        raise LinearInstallationRejected("linear_token_metadata_invalid", "Linear OAuth expiry metadata is invalid")
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat().replace("+00:00", "Z")
    return access_token, refresh_token, scopes, expires_at


def _validate_identity(acceptance: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, str]]]:
    viewer = acceptance.get("viewer") if isinstance(acceptance.get("viewer"), dict) else {}
    organization = acceptance.get("organization") if isinstance(acceptance.get("organization"), dict) else {}
    raw_projects = acceptance.get("projects")
    if isinstance(raw_projects, dict):
        raw_projects = raw_projects.get("nodes")
    if not viewer.get("app"):
        raise LinearInstallationRejected("linear_viewer_not_app", "Linear viewer is not an app user")
    if not str(viewer.get("id") or ""):
        raise LinearInstallationRejected("linear_app_user_missing", "Linear app user id is missing")
    if not all(str(organization.get(key) or "") for key in ("id", "name", "urlKey")):
        raise LinearInstallationRejected("linear_organization_missing", "Linear organization identity is incomplete")
    projects = [_project(project) for project in (raw_projects or []) if isinstance(project, dict)]
    if not projects:
        raise LinearInstallationRejected("linear_project_access_missing", "No accessible Linear projects were discovered")
    return viewer, organization, projects


def _project(raw: dict[str, Any]) -> dict[str, str]:
    project = {
        "id": str(raw.get("id") or ""),
        "name": str(raw.get("name") or ""),
        "slug_id": str(raw.get("slugId") or raw.get("slug_id") or ""),
    }
    if not project["id"] or not project["name"]:
        raise LinearInstallationRejected("linear_project_metadata_invalid", "Linear project metadata is incomplete")
    return project
