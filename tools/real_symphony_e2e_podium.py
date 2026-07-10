from __future__ import annotations

import asyncio
import os
import socket
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from real_symphony_e2e_common import Evidence
from real_symphony_e2e_errors import E2EConfigurationError


OAUTH_START_PATH = "/api/v1/linear/installations/oauth"
INSTALLATIONS_PATH = "/api/v1/linear/installations"
PROJECTS_PATH = "/api/v1/linear/projects"

FIXTURE_CREDENTIAL_KEYS = (
    "SYMPHONY_E2E_LINEAR_FIXTURE_TOKEN",
    "PODIUM_LINEAR_APP_ACCESS_TOKEN",
    "PODIUM_LINEAR_APPLICATION_ID",
    "PODIUM_LINEAR_ACCESS_TOKEN",
    "LINEAR_API_KEY",
)
REQUIRED_LINEAR_SCOPES = {"read", "write", "app:assignable"}


def podium_managed_env(
    base_env: dict[str, str],
    *,
    database_url: str,
    podium_base_url: str,
    secret_key: str,
) -> dict[str, str]:
    managed = managed_runtime_env(base_env)
    managed.update(
        {
            "PODIUM_DATABASE_URL": database_url,
            "PODIUM_BASE_URL": podium_base_url,
            "PODIUM_SECRET_KEY": secret_key,
            "PODIUM_DEBUG_AUTH": "1",
            "PODIUM_SECURE_COOKIES": "0",
            "PODIUM_DISABLE_TURNSTILE": "1",
            "PODIUM_LINEAR_RECONCILIATION_INTERVAL_SECONDS": "1",
        }
    )
    return managed


def managed_runtime_env(base_env: dict[str, str]) -> dict[str, str]:
    managed = dict(base_env)
    for key in FIXTURE_CREDENTIAL_KEYS:
        managed.pop(key, None)
    return managed


def podium_runtime_from_env(env: dict[str, str]) -> tuple[str, int]:
    missing = [key for key in ("LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "LINEAR_REDIRECT_URI") if not env.get(key, "").strip()]
    if missing:
        raise _config_error(
            "linear_oauth_application_required",
            f"Linear OAuth application configuration is missing: {', '.join(missing)}",
            "set_linear_oauth_application",
        )
    redirect = urlsplit(env["LINEAR_REDIRECT_URI"].strip())
    if (
        redirect.path != "/api/v1/linear/oauth/callback"
        or redirect.scheme not in {"http", "https"}
        or not redirect.hostname
        or redirect.username
        or redirect.password
        or redirect.query
        or redirect.fragment
    ):
        raise _config_error(
            "linear_oauth_callback_invalid",
            "LINEAR_REDIRECT_URI must target /api/v1/linear/oauth/callback",
            "fix_linear_oauth_callback",
        )
    origin = f"{redirect.scheme}://{redirect.netloc}"
    configured_port = str(env.get("SYMPHONY_E2E_PODIUM_LOCAL_PORT") or "").strip()
    try:
        port = int(configured_port) if configured_port else int(redirect.port or (443 if redirect.scheme == "https" else 80))
    except ValueError as exc:
        raise _config_error(
            "podium_callback_port_invalid",
            "The local Podium callback port must be an integer",
            "fix_podium_callback_port",
        ) from exc
    if not 1 <= port <= 65535:
        raise _config_error(
            "podium_callback_port_invalid",
            "The local Podium callback port must be between 1 and 65535",
            "fix_podium_callback_port",
        )
    return origin, port


def require_local_port_available(port: int) -> None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", port))
    except OSError as exc:
        raise _config_error(
            "podium_callback_port_unavailable",
            f"The local Podium callback port is unavailable: {port}",
            "free_podium_callback_port",
        ) from exc


def resolve_installation_project(projects: list[dict[str, Any]], requested: str) -> dict[str, Any]:
    needle = requested.strip().casefold()
    for project in projects:
        values = (project.get("id"), project.get("slug_id"), project.get("name"))
        if any(str(value or "").casefold() == needle for value in values):
            return project
    raise _config_error(
        "linear_project_not_found",
        f"Selected Linear project was not discovered: {requested}",
        "select_accessible_linear_project",
    )


class PodiumSession:
    def __init__(self, base_url: str, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.client = httpx.AsyncClient(
            base_url=base_url,
            timeout=30,
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        )

    async def authenticate(self) -> dict[str, Any]:
        payload = await self.request("GET", "/api/v1/auth/me")
        user = payload.get("user") if isinstance(payload.get("user"), dict) else {}
        if not user.get("id"):
            raise _config_error("podium_debug_session_missing", "Podium did not create the E2E session", "inspect_podium_auth")
        return user

    async def request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        response = await self.client.request(method, path, json=payload)
        body = _response_json(response)
        if response.status_code >= 400:
            error = body.get("error") if isinstance(body.get("error"), dict) else {}
            raise _config_error(
                str(error.get("code") or f"podium_http_{response.status_code}"),
                str(error.get("message") or "Podium request failed"),
                "inspect_podium_log",
            )
        return body

    async def close(self) -> None:
        await self.client.aclose()


async def authorize_default_application(
    session: PodiumSession,
    *,
    root: Path,
    evidence: Evidence,
    timeout_seconds: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    user = await session.authenticate()
    application = (await session.request("GET", "/api/v1/linear/application")).get("application") or {}
    evidence.check(
        "linear-oauth:default-application-selected",
        application.get("source") == "default",
        source=application.get("source"),
        version=application.get("version"),
        callback_url=application.get("callback_url"),
    )
    if application.get("source") != "default":
        raise _config_error(
            "linear_default_application_not_selected",
            "The real acceptance run requires Podium's default Linear application",
            "select_default_linear_application",
        )
    before = await session.request("GET", INSTALLATIONS_PATH)
    previous_active = before.get("active") if isinstance(before.get("active"), dict) else {}
    previous_candidate = before.get("candidate") if isinstance(before.get("candidate"), dict) else {}
    started = await session.request("POST", OAUTH_START_PATH)
    authorization_url = str(started.get("authorization_url") or "")
    _validate_authorization_url(authorization_url)
    pending_path = root / ".linear-authorization-url"
    _write_private(pending_path, authorization_url)
    print(f"event=e2e_linear_oauth_action_required authorization_url_path={pending_path}", flush=True)
    try:
        installation = await _wait_for_active_installation(
            session,
            timeout_seconds,
            previous_active_fingerprint=_installation_fingerprint(previous_active),
            previous_candidate_id=str(previous_candidate.get("id") or ""),
        )
    finally:
        pending_path.unlink(missing_ok=True)
    _record_installation(evidence, installation)
    return user, installation


async def select_linear_project(
    session: PodiumSession,
    requested: str,
    evidence: Evidence,
) -> dict[str, Any]:
    projects = (await session.request("GET", PROJECTS_PATH)).get("projects") or []
    project = resolve_installation_project([row for row in projects if isinstance(row, dict)], requested)
    selected = await session.request("PUT", PROJECTS_PATH, {"project_ids": [str(project["id"])]})
    selected_rows = selected.get("projects") if isinstance(selected.get("projects"), list) else []
    selected_ids = [str(row.get("id") or "") for row in selected_rows if isinstance(row, dict) and row.get("selected")]
    evidence.check(
        "linear-project:selected-one",
        selected_ids == [str(project["id"])],
        project_id=project.get("id"),
        project_slug=project.get("slug_id"),
        selected_ids=selected_ids,
    )
    if selected_ids != [str(project["id"])]:
        raise _config_error(
            "linear_project_selection_unconfirmed",
            "Podium did not confirm exactly one selected Linear project",
            "select_linear_project_again",
        )
    return project


async def _wait_for_active_installation(
    session: PodiumSession,
    timeout_seconds: int,
    *,
    previous_active_fingerprint: tuple[str, ...],
    previous_candidate_id: str,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        payload = await session.request("GET", INSTALLATIONS_PATH)
        active = payload.get("active") if isinstance(payload.get("active"), dict) else None
        if (
            active
            and active.get("state") == "ready"
            and _installation_fingerprint(active) != previous_active_fingerprint
        ):
            return active
        candidate = payload.get("candidate") if isinstance(payload.get("candidate"), dict) else None
        if candidate and candidate.get("id") != previous_candidate_id and candidate.get("state") == "failed":
            raise _config_error(
                str(candidate.get("error_code") or "linear_oauth_failed"),
                str(candidate.get("sanitized_reason") or "Linear authorization failed"),
                str(candidate.get("next_action") or "reauthorize_linear"),
            )
        await asyncio.sleep(0.5)
    raise _config_error("linear_oauth_timeout", "Linear OAuth callback was not completed", "complete_linear_oauth")


def _installation_fingerprint(installation: dict[str, Any]) -> tuple[str, ...]:
    return tuple(
        str(installation.get(key) or "")
        for key in ("id", "updated_at", "expires_at", "application_config_version")
    )


def _record_installation(evidence: Evidence, installation: dict[str, Any]) -> None:
    accepted = _installation_acceptance_complete(installation)
    evidence.check(
        "linear-oauth:callback-accepted",
        accepted,
        installation_id=installation.get("id"),
        application_source=installation.get("application_source"),
        organization_id=installation.get("linear_organization_id"),
        organization_name=installation.get("organization_name"),
        app_user_id=installation.get("app_user_id"),
        actor=installation.get("actor"),
        scopes=installation.get("scope"),
        project_count=installation.get("project_count"),
        expires_at=installation.get("expires_at"),
    )
    validate_active_installation(installation)


def validate_active_installation(installation: dict[str, Any]) -> None:
    if _installation_acceptance_complete(installation):
        return
    raise _config_error(
        "linear_installation_acceptance_incomplete",
        "The active Linear installation is missing required acceptance identity or scopes",
        "reauthorize_linear",
    )


def _installation_acceptance_complete(installation: dict[str, Any]) -> bool:
    return bool(
        installation.get("id")
        and installation.get("state") == "ready"
        and installation.get("actor") == "app"
        and set(installation.get("scope") or []) == REQUIRED_LINEAR_SCOPES
        and installation.get("linear_organization_id")
        and installation.get("app_user_id")
        and installation.get("application_source") in {"default", "custom"}
        and int(installation.get("project_count") or 0) > 0
        and installation.get("expires_at")
    )


def _response_json(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _write_private(path: Path, value: str) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(value)


def _validate_authorization_url(value: str) -> None:
    parsed = urlsplit(value)
    if (
        parsed.scheme == "https"
        and parsed.netloc == "linear.app"
        and parsed.path == "/oauth/authorize"
        and not parsed.fragment
    ):
        return
    raise _config_error(
        "linear_authorization_url_invalid",
        "Podium returned an invalid Linear authorization URL",
        "inspect_podium_oauth",
    )


def _config_error(code: str, reason: str, next_action: str) -> E2EConfigurationError:
    return E2EConfigurationError(
        failure_class="environment_failure",
        error_code=code,
        sanitized_reason=reason,
        retryable=False,
        next_action=next_action,
    )
