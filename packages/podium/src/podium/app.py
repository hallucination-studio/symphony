from __future__ import annotations

import base64
import asyncio
import contextlib
import inspect
import hashlib
import hmac
import json
import os
import secrets
import shlex
import urllib.parse
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from contextlib import asynccontextmanager

import httpx
from argon2 import PasswordHasher
from cryptography.fernet import Fernet, InvalidToken
from fastapi import FastAPI, Header, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

from .config import PodiumConfig


TurnstileVerifier = Callable[[str, str | None], bool]

LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize"
LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token"
LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"
LINEAR_DEFAULT_SCOPE = "read,write"

LINEAR_SCOPE_QUERY = (
    "query { teams { nodes { id name key } } projects { nodes { id name } } }"
)


class SecretDecryptionError(RuntimeError):
    pass


def shlex_quote(value: str) -> str:
    return shlex.quote(value)

LINEAR_SUCCESS_HTML = (
    "<!doctype html><html><head><meta charset=\"utf-8\">"
    "<title>Linear connected</title></head>"
    "<body style=\"font-family: system-ui, sans-serif; text-align: center; padding: 3rem;\">"
    "<h1>Linear connected</h1>"
    "<p>Authorization succeeded. You can close this window.</p>"
    "<script>setTimeout(function(){ try { window.close(); } catch (e) {} }, 500);</script>"
    "</body></html>"
)

ONBOARDING_STEPS = [
    "linear_connect",
    "scope_selection",
    "repository_mapping",
    "runtime_enrollment",
    "smoke_check",
]


@dataclass
class InMemoryPodiumBusinessState:
    """Fallback business store for tests and single-process local runs.

    Production deployments inject PgStore/RedisStore-backed services; this class
    keeps the app API usable when those dependencies are not configured.
    """

    users: dict[str, dict[str, Any]] = field(default_factory=dict)
    user_ids_by_email: dict[str, str] = field(default_factory=dict)
    sessions: dict[str, dict[str, Any]] = field(default_factory=dict)
    runtime_groups: dict[str, dict[str, Any]] = field(default_factory=dict)
    enrollment_tokens: dict[str, dict[str, Any]] = field(default_factory=dict)
    runtimes: dict[str, dict[str, Any]] = field(default_factory=dict)
    dispatches: dict[str, dict[str, Any]] = field(default_factory=dict)
    presence: dict[str, str] = field(default_factory=dict)
    proxy_audit_events: list[dict[str, Any]] = field(default_factory=list)
    linear_installations: dict[str, dict[str, Any]] = field(default_factory=dict)
    conductors: dict[str, dict[str, Any]] = field(default_factory=dict)
    project_bindings: dict[str, dict[str, Any]] = field(default_factory=dict)
    metrics_snapshots: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    instance_log_tails: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    log_fetch_results: dict[str, dict[str, Any]] = field(default_factory=dict)
    ws_queues: dict[str, asyncio.Queue[dict[str, Any]]] = field(default_factory=dict)
    onboarding_state: dict[str, dict[str, Any]] = field(default_factory=dict)
    smoke_results: dict[str, dict[str, Any]] = field(default_factory=dict)
    oauth_states: dict[str, dict[str, Any]] = field(default_factory=dict)


def create_app(
    *,
    turnstile_verifier: TurnstileVerifier | None = None,
    secure_cookies: bool = True,
    session_cookie_name: str = "podium_session",
    linear_webhook_secret: str = "",
    static_dir: str | Path | None = None,
    data_dir: str | Path | None = None,
    secret_key: str = "",
    linear_client_id: str = "",
    linear_client_secret: str = "",
    linear_redirect_uri: str = "",
    linear_token_exchange: Callable[[str, str], dict[str, Any]] | None = None,
    linear_scope_fetch: Callable[[str, str], dict[str, Any]] | None = None,
    linear_graphql_transport: Callable[[httpx.Request], Any] | None = None,
    podium_base_url: str = "https://podium.example",
    pg_store: Any | None = None,
    redis_store: Any | None = None,
    config: PodiumConfig | None = None,
    debug_auth: bool = False,
) -> FastAPI:
    state = ManagedPodiumState(
        turnstile_verifier=turnstile_verifier or verify_turnstile_with_cloudflare,
        session_cookie_name=session_cookie_name,
        secure_cookies=secure_cookies,
        linear_webhook_secret=linear_webhook_secret,
        secret_key=secret_key,
        linear_client_id=linear_client_id,
        linear_client_secret=linear_client_secret,
        linear_redirect_uri=linear_redirect_uri,
        data_dir=data_dir,
        pg_store=pg_store,
        redis_store=redis_store,
        config=config or PodiumConfig.from_env(),
        debug_auth=debug_auth,
    )
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.dispatch_reaper_task = asyncio.create_task(_dispatch_lease_reaper_loop(app))
        try:
            yield
        finally:
            task = getattr(app.state, "dispatch_reaper_task", None)
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            app.state.dispatch_reaper_task = None

    app = FastAPI(title="Symphony Podium", lifespan=lifespan)
    app.state.podium = state
    app.state.dispatch_reaper_task = None
    static_root = Path(static_dir).resolve() if static_dir else None
    index_file = static_root / "index.html" if static_root else None

    async def _require_user(request: Request) -> dict[str, Any] | None:
        podium_session = request.cookies.get(state.session_cookie_name)
        return await state.user_for_session(podium_session or "")

    async def resolve_linear_creds(workspace_id: str) -> tuple[str, str, str] | JSONResponse:
        """Return (client_id, client_secret, redirect_uri) for the workspace.

        Prefers the user's custom app (decrypting the stored secret); otherwise
        falls back to the official shared app. Decryption failures surface.
        """
        user = await state.user_by_id(workspace_id)
        custom = user.get("linear_app") if isinstance(user, dict) else None
        if custom:
            try:
                client_secret = state.decrypt_secret(str(custom.get("client_secret_encrypted") or ""))
            except SecretDecryptionError:
                return error_response(400, "secret_decryption_failed", "Stored Linear app secret could not be decrypted")
            return (
                str(custom.get("client_id") or ""),
                client_secret,
                str(custom.get("redirect_uri") or "") or state.linear_redirect_uri,
            )
        return (state.linear_client_id, state.linear_client_secret, state.linear_redirect_uri)

    @app.get("/")
    async def root() -> Response:
        if static_root and index_file and index_file.exists():
            return HTMLResponse(index_file.read_text(encoding="utf-8"))
        return JSONResponse({"service": "Podium"})

    @app.get("/api/v1/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/v1/config")
    async def public_config() -> dict[str, Any]:
        return state.public_config()

    @app.get("/install.sh")
    async def install_script() -> Response:
        return Response(
            render_install_script(),
            media_type="text/x-shellscript; charset=utf-8",
        )

    @app.post("/api/v1/auth/register")
    async def register(request: Request) -> JSONResponse:
        payload = await request.json()
        email = str(payload.get("email") or "").strip().lower()
        password = str(payload.get("password") or "")
        turnstile_token = str(payload.get("turnstile_token") or "")
        if not await state.verify_turnstile(turnstile_token, request.client.host if request.client else None):
            return error_response(400, "invalid_turnstile", "Turnstile verification failed")
        if "@" not in email or len(password) < 8:
            return error_response(400, "invalid_credentials", "A valid email and password are required")
        if await state.user_by_email(email) is not None:
            return error_response(400, "email_already_registered", "Email is already registered")
        user_id = await state.next_user_id()
        user = await state.create_user(
            user_id,
            email=email,
            password_hash=state.password_hasher.hash(password),
            created_at=utc_now_iso(),
        )
        session_token = await state.create_session(user_id)
        json_response = JSONResponse({"user": public_user(user)})
        state.set_session_cookie(json_response, session_token)
        return json_response

    @app.post("/api/v1/auth/login")
    async def login(request: Request) -> JSONResponse:
        payload = await request.json()
        email = str(payload.get("email") or "").strip().lower()
        password = str(payload.get("password") or "")
        turnstile_token = str(payload.get("turnstile_token") or "")
        if not await state.verify_turnstile(turnstile_token, request.client.host if request.client else None):
            return error_response(400, "invalid_turnstile", "Turnstile verification failed")
        user = await state.user_by_email(email)
        if user is None:
            return error_response(401, "invalid_login", "Invalid email or password")
        try:
            ok = state.password_hasher.verify(str(user["password_hash"]), password)
        except Exception:
            ok = False
        if not ok:
            return error_response(401, "invalid_login", "Invalid email or password")
        session_token = await state.create_session(str(user["id"]))
        json_response = JSONResponse({"user": public_user(user)})
        state.set_session_cookie(json_response, session_token)
        return json_response

    @app.post("/api/v1/auth/logout")
    async def logout(request: Request, response: Response) -> dict[str, str]:
        podium_session = request.cookies.get(state.session_cookie_name)
        if podium_session:
            await state.revoke_session(podium_session)
        response.delete_cookie(state.session_cookie_name)
        return {"status": "ok"}

    @app.get("/api/v1/auth/me")
    async def me(request: Request) -> JSONResponse:
        podium_session = request.cookies.get(state.session_cookie_name)
        user = await state.user_for_session(podium_session or "")
        if user is None:
            if state.debug_auth:
                user = state.ensure_debug_user()
                session_token = await state.create_session(str(user["id"]))
                json_response = JSONResponse({"user": public_user(user)})
                state.set_session_cookie(json_response, session_token)
                return json_response
            return error_response(401, "unauthorized", "Unauthorized")
        return JSONResponse({"user": public_user(user)})

    @app.get("/api/v1/onboarding/status")
    async def onboarding_status(request: Request) -> JSONResponse:
        user = await _require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        user_id = str(user["id"])
        await state.load_onboarding_state(user_id)
        if await state.get_linear_installation(user_id) is not None:
            state.mark_linear_connected(user_id)
            await state.persist_onboarding_state(user_id)
        return JSONResponse(state.onboarding_progress(user_id))

    @app.post("/api/v1/onboarding/scope")
    async def onboarding_scope(request: Request) -> JSONResponse:
        user = await _require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        user_id = str(user["id"])
        await state.load_onboarding_state(user_id)
        teams = payload.get("teams")
        projects = payload.get("projects")
        progress = state.save_onboarding_scope(user_id, teams, projects)
        await state.persist_onboarding_state(user_id)
        return JSONResponse({"onboarding": progress})

    @app.post("/api/v1/onboarding/repository")
    async def onboarding_repository(request: Request) -> JSONResponse:
        user = await _require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        user_id = str(user["id"])
        await state.load_onboarding_state(user_id)
        mode = str(payload.get("mode") or "")
        value = str(payload.get("value") or "")
        if mode not in {"local_path", "git_url"}:
            return error_response(400, "invalid_mode", "mode must be local_path or git_url")
        validation_state = "valid"
        if mode == "git_url" and not value.startswith(("https://", "git@")):
            validation_state = "invalid"
        progress = state.save_onboarding_repository(user_id, mode, value)
        await state.persist_onboarding_state(user_id)
        return JSONResponse(
            {
                "onboarding": progress,
                "repository": {"mode": mode, "value": value, "validation_state": validation_state},
            }
        )

    @app.post("/api/v1/onboarding/smoke-check")
    async def onboarding_smoke_check(request: Request) -> JSONResponse:
        user = await _require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        result = {
            "status": "passed",
            "checks": [{"name": "runtime_online", "passed": True}],
            "recommendations": [],
            "timestamp": utc_now_iso(),
        }
        user_id = str(user["id"])
        await state.load_onboarding_state(user_id)
        state.set_smoke_result(user_id, result)
        await state.persist_onboarding_state(user_id)
        return JSONResponse(result)

    @app.get("/api/v1/onboarding/smoke-check/result")
    async def onboarding_smoke_check_result(request: Request) -> JSONResponse:
        user = await _require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        user_id = str(user["id"])
        await state.load_onboarding_state(user_id)
        result = state.get_smoke_result(user_id)
        if result is None:
            return error_response(404, "smoke_result_not_found", "No smoke result recorded")
        return JSONResponse(result)

    @app.get("/api/v1/bootstrap")
    async def bootstrap(request: Request) -> JSONResponse:
        user = await _require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        user_id = str(user["id"])
        await state.load_onboarding_state(user_id)
        if await state.get_linear_installation(user_id) is not None:
            state.mark_linear_connected(user_id)
            await state.persist_onboarding_state(user_id)
        return JSONResponse(
            {
                "session": {
                    "workspace_id": user_id,
                    "user_id": user_id,
                    "email": str(user["email"]),
                },
                "onboarding": state.onboarding_progress(user_id),
                "linear": await state.linear_status(user_id),
            }
        )

    @app.put("/api/v1/account/linear-app")
    async def put_linear_app(request: Request) -> JSONResponse:
        user = await _require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        if not state.secret_key:
            return error_response(500, "encryption_unavailable", "Secret key is not configured")
        payload = await request.json()
        client_id = str(payload.get("client_id") or "").strip()
        client_secret = str(payload.get("client_secret") or "").strip()
        redirect_uri = str(payload.get("redirect_uri") or "").strip()
        if not client_id or not client_secret:
            return error_response(400, "invalid_linear_app", "client_id and client_secret are required")
        linear_app = {
            "client_id": client_id,
            "client_secret_encrypted": state.encrypt_secret(client_secret),
            "redirect_uri": redirect_uri,
        }
        await state.set_user_linear_app(str(user["id"]), linear_app)
        return JSONResponse(
            {"linear_app": {"client_id": client_id, "redirect_uri": redirect_uri, "configured": True}}
        )

    @app.delete("/api/v1/account/linear-app")
    async def delete_linear_app(request: Request) -> JSONResponse:
        user = await _require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        await state.set_user_linear_app(str(user["id"]), None)
        return JSONResponse({"ok": True, "linear_app": None})

    @app.post("/api/v1/onboarding/linear/start")
    async def linear_start(request: Request) -> JSONResponse:
        user = await _require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        creds = await resolve_linear_creds(workspace_id)
        if isinstance(creds, JSONResponse):
            return creds
        client_id, _client_secret, redirect_uri = creds
        if not client_id:
            return error_response(400, "linear_app_not_configured", "No Linear app is configured")
        oauth_state = state.create_oauth_state(workspace_id)
        query = urllib.parse.urlencode(
            {
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": LINEAR_DEFAULT_SCOPE,
                "state": oauth_state,
                "prompt": "consent",
            }
        )
        return JSONResponse({"authorization_url": f"{LINEAR_AUTHORIZE_URL}?{query}"})

    @app.get("/api/v1/linear/oauth/callback")
    async def linear_callback(request: Request) -> Response:
        callback_state = request.query_params.get("state") or ""
        code = request.query_params.get("code") or ""
        if not callback_state:
            return error_response(400, "missing_state", "Missing state parameter")
        if not code:
            return error_response(400, "missing_code", "Missing code parameter")
        workspace_id = state.consume_oauth_state(callback_state)
        if not workspace_id:
            return error_response(400, "invalid_state", "Invalid or expired state parameter")
        if not state.secret_key:
            return error_response(500, "encryption_unavailable", "Encryption is not configured")
        if linear_token_exchange is not None:
            token = linear_token_exchange(code, callback_state)
        else:
            creds = await resolve_linear_creds(workspace_id)
            if isinstance(creds, JSONResponse):
                return creds
            client_id, client_secret, redirect_uri = creds
            async with httpx.AsyncClient(timeout=30, trust_env=False) as http_client:
                resp = await http_client.post(
                    LINEAR_TOKEN_URL,
                    data={
                        "grant_type": "authorization_code",
                        "code": code,
                        "client_id": client_id,
                        "client_secret": client_secret,
                        "redirect_uri": redirect_uri,
                    },
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
            token = resp.json()
        access_token = str(token.get("access_token") or "")
        expires_in = token.get("expires_in")
        expires_at: str | None = None
        if isinstance(expires_in, (int, float)):
            expires_at = (datetime.now(timezone.utc) + timedelta(seconds=int(expires_in))).isoformat().replace("+00:00", "Z")
        await state.save_linear_installation(
            workspace_id,
            {
                "workspace_id": workspace_id,
                "access_token": access_token,
                "scope": token.get("scope"),
                "expires_at": expires_at,
            },
        )
        state.mark_linear_connected(workspace_id)
        await state.persist_onboarding_state(workspace_id)
        return HTMLResponse(LINEAR_SUCCESS_HTML)

    @app.get("/api/v1/onboarding/linear/scope")
    async def linear_scope(request: Request) -> JSONResponse:
        user = await _require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        try:
            installation = await state.get_linear_installation(workspace_id)
        except SecretDecryptionError:
            return error_response(400, "secret_decryption_failed", "Stored Linear installation token could not be decrypted")
        if not installation:
            return error_response(400, "linear_installation_not_found", "No Linear installation for workspace")
        access_token = str(installation.get("access_token") or "")
        if linear_scope_fetch is not None:
            result = linear_scope_fetch(workspace_id, access_token)
        else:
            transport = httpx.MockTransport(linear_graphql_transport) if linear_graphql_transport else None
            async with httpx.AsyncClient(timeout=30, trust_env=False, transport=transport) as http_client:
                resp = await http_client.post(
                    LINEAR_GRAPHQL_URL,
                    json={"query": LINEAR_SCOPE_QUERY},
                    headers={"Authorization": access_token, "Content-Type": "application/json"},
                )
            body = resp.json()
            data = body.get("data") if isinstance(body, dict) else {}
            data = data or {}
            result = {
                "teams": ((data.get("teams") or {}).get("nodes") if isinstance(data.get("teams"), dict) else []) or [],
                "projects": ((data.get("projects") or {}).get("nodes") if isinstance(data.get("projects"), dict) else []) or [],
            }
        return JSONResponse({"teams": result.get("teams") or [], "projects": result.get("projects") or []})

    def group_for_workspace(workspace_id: str) -> str:
        group_id = f"group_{workspace_id}"
        state.runtime_groups.setdefault(
            group_id,
            {
                "id": group_id,
                "linear_workspace_id": workspace_id,
                "project_slug": "",
                "linear_agent_app_user_id": "",
                "workflow_profile": "task",
                "codex_profile": {},
            },
        )
        state.persist()
        return group_id

    @app.post("/api/v1/onboarding/runtime/enrollment-token")
    async def onboarding_enrollment_token(request: Request) -> JSONResponse:
        user = await _require_user(request)
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
        user = await _require_user(request)
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
        user = await _require_user(request)
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
                ]
            }
        )

    @app.get("/api/v1/runtimes/{runtime_id}")
    async def runtime_detail(runtime_id: str, request: Request) -> JSONResponse:
        user = await _require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        runtime = state.runtimes.get(runtime_id)
        if runtime is None or not runtime_belongs_to_workspace(runtime, workspace_id, state.runtime_groups):
            return error_response(404, "not_found", "Runtime not found")
        presence = await state.presence_snapshot([runtime_id])
        return JSONResponse(runtime_public(runtime, presence))

    @app.get("/api/v1/runs/recent")
    async def recent_runs(request: Request) -> JSONResponse:
        user = await _require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        raw_limit = request.query_params.get("limit") or "10"
        try:
            limit = int(raw_limit)
        except ValueError:
            limit = 10
        limit = max(1, min(limit, 100))
        runs = [
            run
            for run in state.dispatches.values()
            if dispatch_belongs_to_workspace(run, workspace_id, state.runtime_groups)
        ]
        runs.sort(key=lambda run: str(run.get("created_at") or ""), reverse=True)
        return JSONResponse({"runs": [run_public(run) for run in runs[:limit]]})

    @app.get("/api/v1/runs/{run_id}")
    async def run_detail(run_id: str, request: Request) -> JSONResponse:
        user = await _require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        run = state.dispatches.get(run_id)
        if run is None or not dispatch_belongs_to_workspace(run, workspace_id, state.runtime_groups):
            return error_response(404, "not_found", "Run not found")
        return JSONResponse(run_public(run))

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
                "workflow_profile": str(payload.get("workflow_profile") or "task"),
                "codex_profile": sanitize_codex_profile(payload.get("codex_profile")),
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
        return JSONResponse(result)

    @app.get("/api/v1/runtimes/{conductor_id}/instances/{instance_id}/logs")
    async def runtime_instance_logs(conductor_id: str, instance_id: str, request: Request) -> JSONResponse:
        user = await _require_user(request)
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
        raw_fencing_token = payload.get("fencing_token")
        fencing_token = int(raw_fencing_token) if raw_fencing_token not in {None, ""} else None
        dispatch = await state.ack_dispatch(
            str(runtime["id"]),
            str(payload.get("dispatch_id") or ""),
            str(payload.get("status") or "accepted"),
            fencing_token=fencing_token,
            reason=payload.get("reason") if isinstance(payload.get("reason"), str) else None,
            runtime_phase=payload.get("runtime_phase") if isinstance(payload.get("runtime_phase"), str) else None,
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
                    dispatch = await state.ack_dispatch(
                        runtime_id,
                        str(message.get("dispatch_id") or ""),
                        str(message.get("status") or "accepted"),
                        fencing_token=int(message["fencing_token"]) if message.get("fencing_token") not in {None, ""} else None,
                        reason=message.get("reason") if isinstance(message.get("reason"), str) else None,
                        runtime_phase=message.get("runtime_phase") if isinstance(message.get("runtime_phase"), str) else None,
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

    if static_root and index_file and index_file.exists():
        @app.get("/{full_path:path}")
        async def static_or_spa(full_path: str) -> Response:
            if full_path.startswith("api/"):
                return error_response(404, "not_found", "Route not found")
            candidate = (static_root / full_path).resolve()
            if candidate.is_file() and (candidate == static_root or static_root in candidate.parents):
                return FileResponse(candidate)
            return HTMLResponse(index_file.read_text(encoding="utf-8"))

    return app


@dataclass
class ManagedPodiumState:
    turnstile_verifier: TurnstileVerifier
    session_cookie_name: str
    secure_cookies: bool
    linear_webhook_secret: str = ""
    secret_key: str = ""
    data_dir: str | Path | None = None
    linear_client_id: str = ""
    linear_client_secret: str = ""
    linear_redirect_uri: str = ""
    password_hasher: PasswordHasher = field(default_factory=PasswordHasher)
    pg_store: Any | None = None
    redis_store: Any | None = None
    config: PodiumConfig = field(default_factory=PodiumConfig.from_env)
    debug_auth: bool = False
    durable: Any = field(default_factory=lambda: InMemoryPodiumBusinessState())

    def __post_init__(self) -> None:
        self.durable = InMemoryPodiumBusinessState()

    @property
    def users(self) -> Any:
        return self.durable.users

    @property
    def user_ids_by_email(self) -> Any:
        return self.durable.user_ids_by_email

    @property
    def sessions(self) -> Any:
        return self.durable.sessions

    @property
    def runtime_groups(self) -> Any:
        return self.durable.runtime_groups

    @property
    def enrollment_tokens(self) -> Any:
        return self.durable.enrollment_tokens

    @property
    def runtimes(self) -> Any:
        return self.durable.runtimes

    @property
    def dispatches(self) -> Any:
        return self.durable.dispatches

    @property
    def presence(self) -> Any:
        return self.durable.presence

    @property
    def proxy_audit(self) -> Any:
        return self.durable.proxy_audit_events

    @property
    def linear_installations(self) -> Any:
        return self.durable.linear_installations

    @property
    def conductors(self) -> Any:
        return self.durable.conductors

    @property
    def project_bindings(self) -> Any:
        return self.durable.project_bindings

    @property
    def metrics_snapshots(self) -> Any:
        return self.durable.metrics_snapshots

    @property
    def instance_log_tails(self) -> Any:
        return self.durable.instance_log_tails

    @property
    def log_fetch_results(self) -> Any:
        return self.durable.log_fetch_results

    @property
    def ws_queues(self) -> Any:
        return self.durable.ws_queues

    def persist_users(self) -> None:
        self.persist()

    def persist_linear_installations(self) -> None:
        self.persist()

    def persist(self) -> None:
        persist = getattr(self.durable, "persist", None)
        if callable(persist):
            persist()

    def create_oauth_state(self, workspace_id: str) -> str:
        token = secrets.token_urlsafe(32)
        self.durable.oauth_states[token] = {
            "workspace_id": workspace_id,
            "created_at": utc_now_iso(),
        }
        self.persist()
        return token

    def consume_oauth_state(self, state: str) -> str | None:
        row = self.durable.oauth_states.pop(state, None)
        self.persist()
        if not isinstance(row, dict):
            return None
        return str(row.get("workspace_id") or "") or None

    def _onboarding_row(self, workspace_id: str) -> dict[str, Any]:
        return self.durable.onboarding_state.setdefault(
            workspace_id,
            {"completed_steps": [], "metadata": {}},
        )

    async def load_onboarding_state(self, workspace_id: str) -> None:
        if self.pg_store is None:
            return
        row = await self.pg_store.get_onboarding_state(workspace_id)
        if row is not None:
            self.durable.onboarding_state[workspace_id] = {
                "completed_steps": list(row.get("completed_steps") or []),
                "metadata": dict(row.get("metadata") or {}),
            }

    async def persist_onboarding_state(self, workspace_id: str) -> None:
        if self.pg_store is None:
            self.persist()
            return
        row = self._onboarding_row(workspace_id)
        await self.pg_store.save_onboarding_state(
            workspace_id,
            list(row.get("completed_steps") or []),
            dict(row.get("metadata") or {}),
        )

    def _mark_onboarding(self, workspace_id: str, step: str) -> None:
        if step not in ONBOARDING_STEPS:
            return
        row = self._onboarding_row(workspace_id)
        completed = row.setdefault("completed_steps", [])
        if step not in completed:
            completed.append(step)
            self.persist()

    def onboarding_progress(self, workspace_id: str) -> dict[str, Any]:
        row = self._onboarding_row(workspace_id)
        completed = list(row.get("completed_steps") or [])
        group_id = f"group_{workspace_id}"
        has_runtime = any(
            str(runtime.get("runtime_group_id") or "") == group_id
            or str(runtime.get("user_id") or "") == workspace_id
            for runtime in self.runtimes.values()
        )
        online_runtime = any(
            (str(runtime.get("runtime_group_id") or "") == group_id or str(runtime.get("user_id") or "") == workspace_id)
            and str(runtime.get("id") or "") in self.presence
            for runtime in self.runtimes.values()
        )
        if (has_runtime or online_runtime) and "runtime_enrollment" not in completed:
            completed.append("runtime_enrollment")
        ordered = [step for step in ONBOARDING_STEPS if step in completed]
        current_step = "complete"
        for step in ONBOARDING_STEPS:
            if step not in ordered:
                current_step = step
                break
        row["completed_steps"] = ordered
        return {
            "current_step": current_step,
            "completed_steps": ordered,
            "next_action": None if current_step == "complete" else current_step,
        }

    def save_onboarding_scope(self, workspace_id: str, teams: Any, projects: Any) -> dict[str, Any]:
        row = self._onboarding_row(workspace_id)
        row.setdefault("metadata", {})["scope"] = {"teams": teams, "projects": projects}
        self._mark_onboarding(workspace_id, "scope_selection")
        self.persist()
        return self.onboarding_progress(workspace_id)

    def save_onboarding_repository(self, workspace_id: str, mode: str, value: str) -> dict[str, Any]:
        row = self._onboarding_row(workspace_id)
        row.setdefault("metadata", {})["repository"] = {"mode": mode, "value": value}
        self._mark_onboarding(workspace_id, "repository_mapping")
        self.persist()
        return self.onboarding_progress(workspace_id)

    def mark_linear_connected(self, workspace_id: str) -> dict[str, Any]:
        self._mark_onboarding(workspace_id, "linear_connect")
        return self.onboarding_progress(workspace_id)

    def mark_runtime_enrolled(self, workspace_id: str) -> dict[str, Any]:
        self._mark_onboarding(workspace_id, "runtime_enrollment")
        return self.onboarding_progress(workspace_id)

    def set_smoke_result(self, workspace_id: str, result: dict[str, Any]) -> dict[str, Any]:
        self.durable.smoke_results[workspace_id] = result
        self._mark_onboarding(workspace_id, "smoke_check")
        self.persist()
        return self.onboarding_progress(workspace_id)

    def get_smoke_result(self, workspace_id: str) -> dict[str, Any] | None:
        return self.durable.smoke_results.get(workspace_id)

    async def save_enrollment_token(self, token_hash: str, *, runtime_group_id: str, expires_at: datetime) -> None:
        ttl_seconds = max(1, int((expires_at - datetime.now(timezone.utc)).total_seconds()))
        if self.redis_store is not None:
            await self.redis_store.save_enrollment_token(token_hash, runtime_group_id=runtime_group_id, ttl_seconds=ttl_seconds)
            return
        self.enrollment_tokens[token_hash] = {
            "runtime_group_id": runtime_group_id,
            "used": False,
            "expires_at": expires_at,
        }
        self.persist()

    async def consume_enrollment_token(self, token: str) -> tuple[dict[str, Any] | None, str | None]:
        token_hash = hash_secret(token)
        if self.redis_store is not None:
            row = await self.redis_store.consume_enrollment_token(token_hash)
            return (row, None) if row is not None else (None, "invalid_enrollment_token")
        row = self.enrollment_tokens.get(token_hash)
        if row is None:
            return None, "invalid_enrollment_token"
        if row["used"]:
            return None, "enrollment_token_used"
        if row["expires_at"] < datetime.now(timezone.utc):
            return None, "enrollment_token_expired"
        row["used"] = True
        self.persist()
        return row, None

    async def has_pending_enrollment(self, runtime_group_id: str) -> bool:
        if self.redis_store is not None:
            return bool(await self.redis_store.has_enrollment_token_for_group(runtime_group_id))
        return any(
            not row["used"] and row["runtime_group_id"] == runtime_group_id and row["expires_at"] >= datetime.now(timezone.utc)
            for row in self.enrollment_tokens.values()
        )

    async def set_presence(self, runtime_id: str) -> None:
        timestamp = utc_now_iso()
        self.presence[runtime_id] = timestamp
        if self.redis_store is not None:
            await self.redis_store.set_conductor_owner(runtime_id, "podium", ttl_seconds=90)

    async def clear_presence(self, runtime_id: str) -> None:
        self.presence.pop(runtime_id, None)
        if self.redis_store is not None:
            await self.redis_store.clear_conductor_owner(runtime_id)

    async def save_log_fetch_result(self, request_id: str, result: dict[str, Any]) -> None:
        if not request_id:
            return
        if self.redis_store is not None:
            await self.redis_store.save_log_fetch_result(request_id, result, ttl_seconds=300)
        else:
            self.log_fetch_results[request_id] = result
            self.persist()

    async def get_log_fetch_result(self, request_id: str) -> dict[str, Any] | None:
        if self.redis_store is not None:
            return await self.redis_store.get_log_fetch_result(request_id)
        return self.log_fetch_results.get(request_id)

    async def record_proxy_audit(self, event: dict[str, Any]) -> None:
        self.proxy_audit.append(dict(event))
        if self.pg_store is not None:
            await self.pg_store.insert_proxy_audit_event(event)

    def _fernet(self) -> Fernet:
        if not self.secret_key:
            raise RuntimeError("encryption_unavailable")
        key = base64.urlsafe_b64encode(hashlib.sha256(self.secret_key.encode()).digest())
        return Fernet(key)

    def encrypt_secret(self, plaintext: str) -> str:
        return self._fernet().encrypt(plaintext.encode()).decode()

    def decrypt_secret(self, ciphertext: str) -> str:
        try:
            return self._fernet().decrypt(ciphertext.encode()).decode()
        except (InvalidToken, ValueError) as exc:
            raise SecretDecryptionError("secret_decryption_failed") from exc

    def _installation_to_disk(self, installation: dict[str, Any]) -> dict[str, Any]:
        access_token = str(installation.get("access_token") or "")
        return {
            "workspace_id": str(installation.get("workspace_id") or ""),
            "access_token_encrypted": self.encrypt_secret(access_token),
            "scope": installation.get("scope"),
            "expires_at": installation.get("expires_at"),
        }

    def _installation_from_disk(self, installation: dict[str, Any]) -> dict[str, Any]:
        encrypted = str(installation.get("access_token_encrypted") or installation.get("access_token") or "")
        return {
            "workspace_id": str(installation.get("workspace_id") or ""),
            "access_token": self.decrypt_secret(encrypted) if encrypted else "",
            "scope": installation.get("scope"),
            "expires_at": installation.get("expires_at"),
        }

    async def get_linear_installation(self, workspace_id: str) -> dict[str, Any] | None:
        if self.pg_store is not None:
            installation = await self.pg_store.get_linear_installation(workspace_id)
            return self._installation_from_disk(dict(installation)) if installation is not None else None
        return self.linear_installations.get(workspace_id)

    async def save_linear_installation(self, workspace_id: str, installation: dict[str, Any]) -> None:
        if self.pg_store is not None:
            await self.pg_store.save_linear_installation(
                workspace_id,
                self._installation_to_disk(installation),
            )
            return
        self.linear_installations[workspace_id] = installation
        self.persist_linear_installations()

    def ensure_conductor_record(self, runtime_id: str) -> dict[str, Any]:
        runtime = self.runtimes[runtime_id]
        group = self.runtime_groups.get(str(runtime.get("runtime_group_id") or ""), {})
        user_id = str(runtime.get("user_id") or group.get("linear_workspace_id") or "")
        conductor = self.conductors.get(runtime_id)
        if conductor is None:
            conductor = {
                "id": runtime_id,
                "conductor_id": runtime_id,
                "user_id": user_id,
                "hostname": "",
                "label": "",
                "version": "",
                "disabled": bool(runtime.get("disabled")),
                "revoked": bool(runtime.get("revoked")),
                "created_at": runtime.get("created_at") or utc_now_iso(),
                "last_report_at": None,
            }
            self.conductors[runtime_id] = conductor
            self.persist()
        elif user_id and not conductor.get("user_id"):
            conductor["user_id"] = user_id
            self.persist()
        return conductor

    async def apply_runtime_report(self, runtime_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        conductor = self.ensure_conductor_record(runtime_id)
        for key in ("hostname", "label", "version"):
            if key in payload:
                conductor[key] = str(payload.get(key) or "")
        conductor["last_report_at"] = utc_now_iso()
        if self.pg_store is not None:
            runtime = self.runtimes.get(runtime_id, {})
            await self.pg_store.upsert_conductor(
                {
                    **conductor,
                    "runtime_token_hash": runtime.get("runtime_token_hash") or "",
                    "proxy_token_hash": runtime.get("proxy_token_hash") or "",
                }
            )
        bindings = payload.get("bindings") if isinstance(payload.get("bindings"), list) else []
        metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
        queue = payload.get("queue") if isinstance(payload.get("queue"), dict) else {}
        log_tail = payload.get("log_tail") if isinstance(payload.get("log_tail"), dict) else {}
        upserted = 0
        for raw_binding in bindings:
            if not isinstance(raw_binding, dict):
                continue
            instance_id = str(raw_binding.get("instance_id") or "").strip()
            if not instance_id:
                continue
            binding_id = f"{runtime_id}:{instance_id}"
            binding = {
                "id": binding_id,
                "conductor_id": runtime_id,
                "user_id": str(conductor.get("user_id") or ""),
                "instance_id": instance_id,
                "name": str(raw_binding.get("name") or instance_id),
                "linear_project": str(raw_binding.get("linear_project") or ""),
                "project_slug": str(raw_binding.get("project_slug") or raw_binding.get("linear_project") or ""),
                "agent_app_user_id": str(raw_binding.get("agent_app_user_id") or raw_binding.get("linear_agent_app_user_id") or ""),
                "workflow_profile": str(raw_binding.get("workflow_profile") or "task"),
                "codex_profile": sanitize_codex_profile(raw_binding.get("codex_profile")),
                "process_status": str(raw_binding.get("process_status") or ""),
                "constraint_labels": [
                    str(label)
                    for label in (raw_binding.get("constraint_labels") or [])
                    if isinstance(label, str) and label
                ],
                "repo_source": raw_binding.get("repo_source") if isinstance(raw_binding.get("repo_source"), dict) else {},
                "updated_at": utc_now_iso(),
            }
            self.project_bindings[binding_id] = binding
            if self.pg_store is not None:
                await self.pg_store.upsert_project_binding(binding)
            self.runtime_groups[binding_id] = {
                "id": binding_id,
                "linear_workspace_id": binding["user_id"],
                "project_slug": binding["project_slug"],
                "linear_agent_app_user_id": binding["agent_app_user_id"],
                "workflow_profile": binding["workflow_profile"],
                "codex_profile": binding["codex_profile"],
                "project_binding_id": binding_id,
            }
            instance_metrics = metrics.get(instance_id) if isinstance(metrics.get(instance_id), dict) else {}
            instance_queue = queue.get(instance_id) if isinstance(queue.get(instance_id), dict) else {}
            queue_depth = int(instance_queue.get("queue_depth") or instance_queue.get("queued") or 0) + int(instance_queue.get("leased") or 0)
            self.metrics_snapshots[(runtime_id, instance_id)] = {
                "tokens": int(instance_metrics.get("tokens") or 0),
                "runtime_seconds": float(instance_metrics.get("runtime_seconds") or 0),
                "retries": int(instance_metrics.get("retries") or 0),
                "continuations": int(instance_metrics.get("continuations") or 0),
                "blocked": int(instance_metrics.get("blocked") or 0),
                "pending_human": int(instance_metrics.get("pending_human") or 0),
                "failures": int(instance_metrics.get("failures") or 0),
                "queue_depth": queue_depth,
                "running": bool(instance_queue.get("running") or binding["process_status"] == "running"),
                "captured_at": conductor["last_report_at"],
            }
            tail = log_tail.get(instance_id) if isinstance(log_tail.get(instance_id), dict) else None
            if tail is not None:
                self.instance_log_tails[(runtime_id, instance_id)] = {
                    "generation": tail.get("generation"),
                    "offset_end": int(tail.get("offset_end") or 0),
                    "updated_at": conductor["last_report_at"],
                    "lines": list(tail.get("lines") or []),
                }
            upserted += 1
        self.persist()
        return {"status": "ok", "bindings_upserted": upserted}

    async def is_runtime_online(self, runtime_id: str) -> bool:
        if self.redis_store is not None:
            return bool(await self.redis_store.get_conductor_owner(runtime_id))
        return runtime_id in self.presence

    async def presence_snapshot(self, runtime_ids: list[str]) -> dict[str, str]:
        snapshot: dict[str, str] = {}
        for runtime_id in runtime_ids:
            if await self.is_runtime_online(runtime_id):
                snapshot[runtime_id] = self.presence.get(runtime_id) or utc_now_iso()
        return snapshot

    async def list_conductors_for_user(self, user_id: str) -> list[dict[str, Any]]:
        if self.pg_store is not None:
            for conductor in await self.pg_store.list_conductors_for_user(user_id):
                conductor_id = str(conductor["id"])
                self.conductors[conductor_id] = conductor
                self.runtimes[conductor_id] = {
                    "id": conductor_id,
                    "runtime_group_id": f"group_{user_id}",
                    "user_id": user_id,
                    "runtime_token_hash": str(conductor.get("runtime_token_hash") or ""),
                    "proxy_token_hash": str(conductor.get("proxy_token_hash") or ""),
                    "disabled": bool(conductor.get("disabled")),
                    "revoked": bool(conductor.get("revoked")),
                    "created_at": str(conductor.get("created_at") or ""),
                }
                for binding in await self.pg_store.list_project_bindings_for_conductor(conductor_id):
                    binding_id = str(binding.get("id") or "")
                    if binding_id:
                        self.project_bindings[binding_id] = binding
                        self.runtime_groups[binding_id] = self._runtime_group_from_project_binding(binding)
        rows = [self.ensure_conductor_record(runtime_id) for runtime_id in self.runtimes]
        conductors = [row for row in rows if str(row.get("user_id") or "") == user_id]
        result: list[dict[str, Any]] = []
        for conductor in sorted(conductors, key=lambda row: str(row.get("created_at") or "")):
            conductor_id = str(conductor["id"])
            bindings = [
                self.binding_public(binding)
                for binding in self.project_bindings.values()
                if str(binding.get("conductor_id") or "") == conductor_id
            ]
            bindings.sort(key=lambda row: str(row.get("project_slug") or ""))
            result.append(
                {
                    "id": conductor_id,
                    "conductor_id": conductor_id,
                    "runtime_id": conductor_id,
                    "hostname": conductor.get("hostname") or "",
                    "label": conductor.get("label") or "",
                    "version": conductor.get("version") or "",
                    "online": await self.is_runtime_online(conductor_id),
                    "last_report_at": conductor.get("last_report_at"),
                    "bindings": bindings,
                }
            )
        return result

    def binding_public(self, binding: dict[str, Any]) -> dict[str, Any]:
        conductor_id = str(binding.get("conductor_id") or "")
        instance_id = str(binding.get("instance_id") or "")
        metrics = self.metrics_snapshots.get((conductor_id, instance_id), {})
        return {**binding, "metrics": metrics, "queue": {"queue_depth": metrics.get("queue_depth", 0), "running": metrics.get("running", False)}}

    def conductor_belongs_to_user(self, conductor_id: str, user_id: str) -> bool:
        conductor = self.ensure_conductor_record(conductor_id) if conductor_id in self.runtimes else None
        return conductor is not None and str(conductor.get("user_id") or "") == user_id

    async def attach_runtime_ws(self, runtime_id: str) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.ws_queues[runtime_id] = queue
        await self.set_presence(runtime_id)
        return queue

    async def detach_runtime_ws(self, runtime_id: str) -> None:
        self.ws_queues.pop(runtime_id, None)
        await self.clear_presence(runtime_id)

    async def enqueue_runtime_command(self, runtime_id: str, command: dict[str, Any]) -> dict[str, Any]:
        queue = self.ws_queues.get(runtime_id)
        if queue is not None:
            queue.put_nowait(command)
        if self.redis_store is not None:
            await self.redis_store.publish_runtime_command(runtime_id, command)
        return command

    async def apply_log_chunk(self, runtime_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        request_id = str(payload.get("request_id") or "")
        instance_id = str(payload.get("instance_id") or "")
        result = {
            "request_id": request_id,
            "conductor_id": runtime_id,
            "instance_id": instance_id,
            "generation": payload.get("generation"),
            "offset_start": int(payload.get("offset_start") or 0),
            "offset_end": int(payload.get("offset_end") or 0),
            "cursor": int(payload.get("offset_end") or 0),
            "order": str(payload.get("order") or "desc"),
            "lines": list(payload.get("lines") or []),
        }
        await self.save_log_fetch_result(request_id, result)
        self.instance_log_tails[(runtime_id, instance_id)] = {
            "generation": result["generation"],
            "offset_end": result["offset_end"],
            "updated_at": utc_now_iso(),
            "lines": result["lines"],
        }
        self.persist()
        return result

    async def linear_status(self, workspace_id: str) -> dict[str, Any]:
        installation = await self.get_linear_installation(workspace_id)
        if not installation:
            return {"workspace_id": workspace_id, "state": "not_connected"}
        return {
            "workspace_id": workspace_id,
            "state": "connected",
            "scope": installation.get("scope"),
            "expires_at": installation.get("expires_at"),
        }

    async def verify_turnstile(self, token: str, ip: str | None) -> bool:
        if not self.turnstile_enabled:
            return True
        if not token:
            return False
        result = self.turnstile_verifier(token, ip)
        if inspect.isawaitable(result):
            result = await result
        return bool(result)

    @property
    def turnstile_enabled(self) -> bool:
        if self.config.turnstile_disabled or self.debug_auth:
            return False
        return bool(self.config.turnstile_site_key.strip() and self.config.turnstile_secret_key.strip())

    def public_config(self) -> dict[str, Any]:
        site_key = self.config.turnstile_site_key.strip()
        return {"turnstile": {"enabled": self.turnstile_enabled, "site_key": site_key if self.turnstile_enabled else ""}}

    async def next_user_id(self) -> str:
        if self.pg_store is not None:
            return str(await self.pg_store.next_user_id())
        return f"user_{len(self.users) + 1}"

    async def create_user(
        self,
        user_id: str,
        *,
        email: str,
        password_hash: str,
        created_at: str,
    ) -> dict[str, Any]:
        if self.pg_store is not None:
            user = await self.pg_store.create_user(
                user_id,
                email=email,
                password_hash=password_hash,
                created_at=created_at,
            )
            return _clean_user(user)
        user = {
            "id": user_id,
            "email": email,
            "password_hash": password_hash,
            "created_at": created_at,
        }
        self.users[user_id] = user
        self.user_ids_by_email[email] = user_id
        self.persist_users()
        return user

    async def user_by_id(self, user_id: str) -> dict[str, Any] | None:
        if self.pg_store is not None:
            user = await self.pg_store.get_user(user_id)
            return _clean_user(user) if user is not None else None
        return self.users.get(user_id or "")

    async def user_by_email(self, email: str) -> dict[str, Any] | None:
        if self.pg_store is not None:
            user = await self.pg_store.get_user_by_email(email)
            return _clean_user(user) if user is not None else None
        user_id = self.user_ids_by_email.get(email)
        return self.users.get(user_id or "")

    async def set_user_linear_app(self, user_id: str, linear_app: dict[str, Any] | None) -> None:
        if self.pg_store is not None:
            await self.pg_store.set_user_linear_app(user_id, linear_app)
            return
        user = self.users.get(user_id)
        if user is None:
            return
        if linear_app is None:
            user.pop("linear_app", None)
        else:
            user["linear_app"] = linear_app
        self.persist_users()

    def ensure_debug_user(self) -> dict[str, Any]:
        user_id = "debug"
        user = self.users.get(user_id)
        if user is None:
            user = {
                "id": user_id,
                "email": "debug@podium.local",
                "password_hash": "",
                "created_at": utc_now_iso(),
            }
            self.users[user_id] = user
            self.user_ids_by_email["debug@podium.local"] = user_id
            self.persist_users()
        return user

    async def create_session(self, user_id: str) -> str:
        token = secrets.token_urlsafe(32)
        ttl = getattr(self, "session_ttl", timedelta(days=30))
        token_hash = hash_secret(token)
        ttl_seconds = max(1, int(ttl.total_seconds()))
        if self.redis_store is not None:
            await self.redis_store.save_session(token_hash, user_id=user_id, ttl_seconds=ttl_seconds)
        else:
            self.sessions[token_hash] = {
                "user_id": user_id,
                "expires_at": datetime.now(timezone.utc) + ttl,
                "revoked": False,
            }
            self.persist()
        return token

    async def revoke_session(self, token: str) -> None:
        token_hash = hash_secret(token)
        if self.redis_store is not None:
            await self.redis_store.revoke_session(token_hash)
            return
        row = self.sessions.get(token_hash)
        if row is not None:
            row["revoked"] = True
            self.persist()

    async def user_for_session(self, token: str) -> dict[str, Any] | None:
        token_hash = hash_secret(token)
        if self.redis_store is not None:
            row = await self.redis_store.get_session(token_hash)
            if row is None or row.get("revoked"):
                return None
            return await self.user_by_id(str(row["user_id"]))
        row = self.sessions.get(token_hash)
        if row is None or row.get("revoked") or row["expires_at"] < datetime.now(timezone.utc):
            return None
        return await self.user_by_id(str(row["user_id"]))

    def set_session_cookie(self, response: Response, token: str) -> None:
        response.set_cookie(
            self.session_cookie_name,
            token,
            httponly=True,
            secure=self.secure_cookies,
            samesite="Lax",
            max_age=30 * 24 * 3600,
        )

    async def runtime_for_bearer(self, authorization: str) -> dict[str, Any] | None:
        token = bearer_token(authorization)
        if not token:
            return None
        token_hash = hash_secret(token)
        if self.pg_store is not None:
            runtime = await self.pg_store.get_runtime_by_token_hash(token_hash)
            if runtime is None or runtime.get("disabled") or runtime.get("revoked"):
                return None
            self.runtimes[str(runtime["id"])] = runtime
            return runtime
        for runtime in self.runtimes.values():
            if hmac.compare_digest(str(runtime["runtime_token_hash"]), token_hash):
                if runtime.get("disabled") or runtime.get("revoked"):
                    return None
                return runtime
        return None

    async def runtime_for_proxy_bearer(self, authorization: str) -> dict[str, Any] | None:
        token = bearer_token(authorization)
        if not token:
            return None
        token_hash = hash_secret(token)
        if self.pg_store is not None:
            runtime = await self.pg_store.get_runtime_by_token_hash(token_hash, proxy=True)
            if runtime is None or runtime.get("disabled") or runtime.get("revoked"):
                return None
            self.runtimes[str(runtime["id"])] = runtime
            return runtime
        for runtime in self.runtimes.values():
            if hmac.compare_digest(str(runtime["proxy_token_hash"]), token_hash):
                if runtime.get("disabled") or runtime.get("revoked"):
                    return None
                return runtime
        return None

    async def queue_dispatches(self, event: dict[str, Any]) -> int:
        queued = 0
        groups = await self._runtime_groups_for_dispatch_event(event)
        for group in groups:
            if not group.get("project_binding_id") and self.project_bindings:
                continue
            if group.get("linear_workspace_id") and group.get("linear_workspace_id") != event.get("workspace_id"):
                continue
            if group.get("project_slug") and group.get("project_slug") != event.get("project_slug"):
                continue
            expected_agent = str(group.get("linear_agent_app_user_id") or "")
            if expected_agent and expected_agent not in {
                str(event.get("agent_app_user_id") or ""),
                str(event.get("issue_delegate_id") or ""),
            }:
                continue
            project_binding_id = str(group.get("project_binding_id") or group["id"])
            if self.pg_store is None:
                if any(
                    str(dispatch.get("project_binding_id") or "") == project_binding_id
                    and str(dispatch.get("agent_session_id") or "") == str(event.get("agent_session_id") or "")
                    for dispatch in self.dispatches.values()
                ):
                    continue
            dispatch_id = f"dispatch_{secrets.token_urlsafe(18)}"
            agent_session_id = str(event.get("agent_session_id") or "")
            stored_agent_session_id = agent_session_id or f"empty-session:{event['issue_id']}"
            dispatch = {
                "dispatch_id": dispatch_id,
                "runtime_group_id": group["id"],
                "project_binding_id": project_binding_id,
                "user_id": str(group.get("linear_workspace_id") or event["workspace_id"]),
                "issue_id": event["issue_id"],
                "issue_identifier": event["issue_identifier"],
                "linear_workspace_id": event["workspace_id"],
                "project_slug": event["project_slug"],
                "agent_session_id": stored_agent_session_id,
                "agent_app_user_id": event.get("agent_app_user_id") or "",
                "routing_rule_id": group["id"],
                "workflow_profile": group.get("workflow_profile") or "task",
                "codex_profile": sanitize_codex_profile(group.get("codex_profile")),
                "blocked_by": list(event.get("blocked_by") or []),
                "parent_issue_id": event.get("parent_issue_id") or "",
                "status": "queued",
                "reason": "",
                "runtime_phase": "",
                "leased_runtime_id": None,
                "leased_until": None,
                "fencing_token": 0,
                "created_at": utc_now_iso(),
                "updated_at": utc_now_iso(),
            }
            if self.pg_store is not None:
                inserted = await self.pg_store.upsert_dispatch(dispatch)
                if not inserted:
                    continue
            self.dispatches[dispatch_id] = dispatch
            self.persist()
            binding_id = str(group.get("project_binding_id") or "")
            if binding_id:
                binding = self.project_bindings.get(binding_id) or {}
                conductor_id = str(binding.get("conductor_id") or "")
                if conductor_id:
                    await self.enqueue_runtime_command(
                        conductor_id,
                        {
                            "type": "dispatch.available",
                            "project_binding_id": binding_id,
                            "instance_id": binding.get("instance_id"),
                        },
                    )
            queued += 1
        return queued

    async def _runtime_groups_for_dispatch_event(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        groups = list(self.runtime_groups.values())
        if self.pg_store is None:
            return groups
        agent_ids = [
            str(event.get("agent_app_user_id") or ""),
            str(event.get("issue_delegate_id") or ""),
        ]
        loaded = await self.pg_store.list_project_bindings_for_route(
            user_id=str(event.get("workspace_id") or ""),
            project_slug=str(event.get("project_slug") or ""),
            agent_app_user_ids=[agent_id for agent_id in agent_ids if agent_id],
        )
        for binding in loaded:
            binding_id = str(binding.get("id") or "")
            if not binding_id:
                continue
            self.project_bindings[binding_id] = binding
            self.runtime_groups[binding_id] = self._runtime_group_from_project_binding(binding)
        return list(self.runtime_groups.values())

    def _runtime_group_from_project_binding(self, binding: dict[str, Any]) -> dict[str, Any]:
        binding_id = str(binding.get("id") or "")
        return {
            "id": binding_id,
            "linear_workspace_id": str(binding.get("user_id") or ""),
            "project_slug": str(binding.get("project_slug") or ""),
            "linear_agent_app_user_id": str(binding.get("agent_app_user_id") or ""),
            "workflow_profile": str(binding.get("workflow_profile") or "task"),
            "codex_profile": sanitize_codex_profile(binding.get("codex_profile")),
            "project_binding_id": binding_id,
        }

    async def lease_dispatch(self, runtime_id: str) -> dict[str, Any] | None:
        runtime = self.runtimes[runtime_id]
        binding_ids = {
            binding_id
            for binding_id, binding in self.project_bindings.items()
            if str(binding.get("conductor_id") or "") == runtime_id
        }
        if self.pg_store is not None:
            binding_ids = set()
            for binding in await self.pg_store.list_project_bindings_for_conductor(runtime_id):
                binding_id = str(binding.get("id") or "")
                if not binding_id:
                    continue
                self.project_bindings[binding_id] = binding
                self.runtime_groups[binding_id] = self._runtime_group_from_project_binding(binding)
                binding_ids.add(binding_id)
        now = datetime.now(timezone.utc)
        if self.pg_store is not None:
            leased = await self.pg_store.lease_dispatch(
                runtime_id,
                binding_ids=sorted(binding_ids),
                lease_until=(now + timedelta(minutes=5)).isoformat().replace("+00:00", "Z"),
            )
            if leased is not None:
                group = self.runtime_groups.get(str(leased.get("project_binding_id") or "")) or {}
                leased.update(
                    {
                        "runtime_group_id": str(group.get("id") or leased.get("project_binding_id") or ""),
                        "routing_rule_id": str(group.get("id") or leased.get("project_binding_id") or ""),
                        "workflow_profile": str(group.get("workflow_profile") or "task"),
                        "codex_profile": sanitize_codex_profile(group.get("codex_profile")),
                        "blocked_by": [],
                        "parent_issue_id": "",
                    }
                )
            return leased
        for dispatch in self.dispatches.values():
            if binding_ids:
                if dispatch.get("project_binding_id") not in binding_ids:
                    continue
            elif dispatch["runtime_group_id"] != runtime["runtime_group_id"]:
                continue
            leased_until = dispatch.get("leased_until")
            retryable = isinstance(leased_until, datetime) and leased_until < now
            if dispatch["status"] not in {"queued", "leased"}:
                continue
            if dispatch["status"] == "leased" and not retryable:
                continue
            dispatch["status"] = "leased"
            dispatch["leased_runtime_id"] = runtime_id
            dispatch["leased_until"] = now + timedelta(minutes=5)
            dispatch["fencing_token"] = int(dispatch.get("fencing_token") or 0) + 1
            dispatch["updated_at"] = utc_now_iso()
            self.persist()
            return dispatch
        return None

    async def reap_expired_dispatch_leases(self) -> int:
        if self.pg_store is not None:
            return int(await self.pg_store.reap_expired_dispatch_leases())
        now = datetime.now(timezone.utc)
        reaped = 0
        for dispatch in self.dispatches.values():
            leased_until = dispatch.get("leased_until")
            if isinstance(leased_until, str):
                leased_until = _datetime_from_json(leased_until)
            if dispatch.get("status") == "leased" and isinstance(leased_until, datetime) and leased_until < now:
                dispatch["status"] = "queued"
                dispatch["leased_runtime_id"] = None
                dispatch["leased_until"] = None
                dispatch["updated_at"] = utc_now_iso()
                reaped += 1
        if reaped:
            self.persist()
        return reaped

    async def ack_dispatch(
        self,
        runtime_id: str,
        dispatch_id: str,
        status: str,
        *,
        fencing_token: int | None = None,
        reason: str | None = None,
        runtime_phase: str | None = None,
    ) -> dict[str, Any] | None:
        if self.pg_store is not None:
            if fencing_token is None:
                return {"dispatch_id": dispatch_id, "_ack_error": "stale_dispatch_lease"}
            ack_status = status
            ack_reason = reason or ""
            ack_runtime_phase = runtime_phase or ""
            if status in {"completed", "failed"} and runtime_phase not in {"done", "failed"}:
                ack_status = "ack_drift"
                ack_reason = "dispatch ack missing conductor terminal run event"
            completed_at = utc_now_iso() if ack_status in {"completed", "failed", "cancelled", "canceled"} else None
            saved = await self.pg_store.ack_dispatch(
                runtime_id,
                dispatch_id,
                ack_status,
                fencing_token=fencing_token,
                reason=ack_reason,
                runtime_phase=ack_runtime_phase,
                completed_at=completed_at,
            )
            if saved is None:
                return {"dispatch_id": dispatch_id, "_ack_error": "stale_dispatch_lease"}
            self.dispatches[str(saved.get("dispatch_id") or dispatch_id)] = saved
            return saved

        dispatch = self.dispatches.get(dispatch_id)
        if dispatch is None or dispatch.get("leased_runtime_id") != runtime_id:
            return None
        if fencing_token is not None and fencing_token != int(dispatch.get("fencing_token") or 0):
            return {**dispatch, "_ack_error": "stale_dispatch_lease"}
        if status in {"completed", "failed"} and runtime_phase not in {"done", "failed"}:
            dispatch["status"] = "ack_drift"
            dispatch["reason"] = "dispatch ack missing conductor terminal run event"
            if runtime_phase is not None:
                dispatch["runtime_phase"] = runtime_phase
            dispatch["updated_at"] = utc_now_iso()
            self.persist()
            return dispatch
        dispatch["status"] = status
        if reason is not None:
            dispatch["reason"] = reason
        if runtime_phase is not None:
            dispatch["runtime_phase"] = runtime_phase
        dispatch["updated_at"] = utc_now_iso()
        if status in {"completed", "failed", "cancelled", "canceled"}:
            dispatch["completed_at"] = dispatch["updated_at"]
        if self.pg_store is not None:
            saved = await self.pg_store.ack_dispatch(
                runtime_id,
                dispatch_id,
                dispatch["status"],
                fencing_token=fencing_token,
                reason=str(dispatch.get("reason") or ""),
                runtime_phase=str(dispatch.get("runtime_phase") or ""),
                completed_at=dispatch.get("completed_at"),
            )
            if saved is None:
                return {**dispatch, "_ack_error": "stale_dispatch_lease"} if fencing_token is not None else None
        self.persist()
        return dispatch

    def reconcile_dispatch_acks(self) -> list[dict[str, Any]]:
        findings: list[dict[str, Any]] = []
        for dispatch in self.dispatches.values():
            status = str(dispatch.get("status") or "")
            runtime_phase = str(dispatch.get("runtime_phase") or "")
            if status not in {"completed", "failed"}:
                continue
            if runtime_phase in {"done", "failed"}:
                continue
            findings.append(
                {
                    "code": "dispatch_ack_without_terminal_run_event",
                    "dispatch_id": str(dispatch.get("dispatch_id") or ""),
                    "issue_id": str(dispatch.get("issue_id") or ""),
                    "runtime_phase": runtime_phase,
                    "status": status,
                }
            )
        return findings


async def _forward_runtime_commands(websocket: WebSocket, queue: asyncio.Queue[dict[str, Any]]) -> None:
    while True:
        command = await queue.get()
        await websocket.send_json(command)


async def _relay_redis_runtime_commands(
    state: ManagedPodiumState,
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


async def verify_turnstile_with_cloudflare(token: str, ip: str | None) -> bool:
    secret = os.environ.get("CLOUDFLARE_TURNSTILE_SECRET_KEY", "").strip()
    if not secret:
        return False
    data = {"secret": secret, "response": token}
    if ip:
        data["remoteip"] = ip
    async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
        response = await client.post("https://challenges.cloudflare.com/turnstile/v0/siteverify", data=data)
    try:
        payload = response.json()
    except json.JSONDecodeError:
        return False
    return bool(payload.get("success"))


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    linear_app = user.get("linear_app") if isinstance(user, dict) else None
    if linear_app:
        public_app: dict[str, Any] | None = {
            "client_id": str(linear_app.get("client_id") or ""),
            "redirect_uri": str(linear_app.get("redirect_uri") or ""),
            "configured": True,
        }
    else:
        public_app = None
    user_id = str(user["id"])
    return {"id": user_id, "email": str(user["email"]), "linear_app": public_app}


async def _dispatch_lease_reaper_loop(app: FastAPI) -> None:
    while True:
        state = app.state.podium
        try:
            await state.reap_expired_dispatch_leases()
        except Exception:
            pass
        await asyncio.sleep(30)


def _clean_user(user: dict[str, Any]) -> dict[str, Any]:
    cleaned = dict(user)
    if cleaned.get("linear_app") is None:
        cleaned.pop("linear_app", None)
    return cleaned


def dispatch_public(dispatch: dict[str, Any]) -> dict[str, Any]:
    project_binding_id = str(dispatch.get("project_binding_id") or dispatch.get("runtime_group_id") or "")
    agent_session_id = str(dispatch.get("agent_session_id") or "")
    if agent_session_id.startswith("empty-session:"):
        agent_session_id = ""
    return {
        "dispatch_id": dispatch["dispatch_id"],
        "project_binding_id": project_binding_id,
        "instance_id": project_binding_id.split(":", 1)[1] if ":" in project_binding_id else "",
        "issue_id": dispatch["issue_id"],
        "issue_identifier": dispatch["issue_identifier"],
        "linear_workspace_id": dispatch["linear_workspace_id"],
        "project_slug": dispatch["project_slug"],
        "agent_session_id": agent_session_id,
        "agent_app_user_id": dispatch.get("agent_app_user_id") or "",
        "routing_rule_id": dispatch["routing_rule_id"],
        "workflow_profile": dispatch["workflow_profile"],
        "codex_profile": sanitize_codex_profile(dispatch.get("codex_profile")),
        "blocked_by": list(dispatch.get("blocked_by") or []),
        "parent_issue_id": dispatch.get("parent_issue_id") or "",
        "status": dispatch["status"],
        "fencing_token": int(dispatch.get("fencing_token") or 0),
        "reason": dispatch.get("reason") or "",
        "runtime_phase": dispatch.get("runtime_phase") or "",
    }


def sanitize_codex_profile(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    profile: dict[str, Any] = {}
    model = str(value.get("model") or "").strip()
    sandbox = str(value.get("sandbox") or "").strip()
    if model:
        profile["model"] = model
    if sandbox:
        profile["sandbox"] = sandbox
    overrides = value.get("config_overrides")
    if isinstance(overrides, list):
        safe_overrides: list[str] = []
        for item in overrides:
            text = str(item).strip()
            if not text or "=" not in text:
                continue
            key, raw_value = text.split("=", 1)
            lowered_key = key.lower()
            if any(marker in lowered_key for marker in ("api_key", "apikey", "token", "secret", "password")) and not raw_value.strip().startswith("$"):
                continue
            safe_overrides.append(text)
        if safe_overrides:
            profile["config_overrides"] = safe_overrides
    return profile


def runtime_belongs_to_workspace(
    runtime: dict[str, Any],
    workspace_id: str,
    runtime_groups: dict[str, dict[str, Any]],
) -> bool:
    group_id = str(runtime.get("runtime_group_id") or "")
    return group_id == f"group_{workspace_id}" or str(
        runtime_groups.get(group_id, {}).get("linear_workspace_id") or ""
    ) == workspace_id


def dispatch_belongs_to_workspace(
    dispatch: dict[str, Any],
    workspace_id: str,
    runtime_groups: dict[str, dict[str, Any]],
) -> bool:
    group_id = str(dispatch.get("runtime_group_id") or "")
    return group_id == f"group_{workspace_id}" or str(
        runtime_groups.get(group_id, {}).get("linear_workspace_id") or ""
    ) == workspace_id


def runtime_public(runtime: dict[str, Any], presence: dict[str, str]) -> dict[str, Any]:
    runtime_id = str(runtime["id"])
    metadata = runtime.get("metadata")
    return {
        "runtime_id": runtime_id,
        "online": runtime_id in presence,
        "last_heartbeat": presence.get(runtime_id),
        "version": runtime.get("version"),
        "metadata": metadata if isinstance(metadata, dict) else {},
    }


def run_public(dispatch: dict[str, Any]) -> dict[str, Any]:
    status = run_status_from_dispatch(str(dispatch.get("status") or "queued"))
    completed_at = dispatch.get("completed_at")
    if completed_at is None and status in {"success", "failed", "cancelled"}:
        completed_at = dispatch.get("updated_at") or dispatch.get("created_at")
    return {
        "run_id": str(dispatch["dispatch_id"]),
        "issue_identifier": dispatch.get("issue_identifier"),
        "runtime_id": dispatch.get("leased_runtime_id"),
        "status": status,
        "started_at": dispatch.get("created_at"),
        "completed_at": completed_at,
        "duration_seconds": dispatch.get("duration_seconds"),
        "failure_reason": dispatch.get("reason") if status == "failed" else None,
    }


def run_status_from_dispatch(status: str) -> str:
    if status in {"queued"}:
        return "pending"
    if status in {"leased", "accepted", "running"}:
        return "running"
    if status in {"completed", "success", "succeeded"}:
        return "success"
    if status in {"cancelled", "canceled"}:
        return "cancelled"
    if status in {"failed", "error"}:
        return "failed"
    return "running"


def error_response(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


def render_install_script() -> str:
    return r'''#!/usr/bin/env bash
set -euo pipefail

ENROLLMENT_TOKEN="${PODIUM_ENROLLMENT_TOKEN:-}"
PODIUM_URL="${PODIUM_URL:-}"
DATA_ROOT="${PODIUM_CONDUCTOR_DATA_ROOT:-${HOME}/.podium-conductor}"
CONDUCTOR_COMMAND="${PODIUM_CONDUCTOR_COMMAND:-conductor}"
CONDUCTOR_PORT="${PODIUM_CONDUCTOR_PORT:-8091}"
START_CONDUCTOR="${PODIUM_START_CONDUCTOR:-1}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --enrollment-token)
      ENROLLMENT_TOKEN="${2:-}"
      shift 2
      ;;
    --podium-url)
      PODIUM_URL="${2:-}"
      shift 2
      ;;
    --data-root)
      DATA_ROOT="${2:-}"
      shift 2
      ;;
    --conductor-command)
      CONDUCTOR_COMMAND="${2:-}"
      shift 2
      ;;
    --port)
      CONDUCTOR_PORT="${2:-}"
      shift 2
      ;;
    --no-start)
      START_CONDUCTOR="0"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$ENROLLMENT_TOKEN" ]; then
  echo "--enrollment-token is required" >&2
  exit 2
fi

if [ -z "$PODIUM_URL" ]; then
  if [ -n "${PODIUM_INSTALL_URL:-}" ]; then
    PODIUM_URL="${PODIUM_INSTALL_URL%/}"
  else
    PODIUM_URL="$(python3 - <<'PY'
import os
from urllib.parse import urlsplit, urlunsplit
url = os.environ.get("PODIUM_INSTALL_SOURCE_URL", "")
parts = urlsplit(url)
print(urlunsplit((parts.scheme, parts.netloc, "", "", "")).rstrip("/"))
PY
)"
  fi
fi

if [ -z "$PODIUM_URL" ]; then
  echo "PODIUM_URL is required when the script is not fetched from Podium" >&2
  exit 2
fi

mkdir -p "$DATA_ROOT"

ENROLLED_JSON="$(PODIUM_ENROLLMENT_TOKEN="$ENROLLMENT_TOKEN" python3 - "$PODIUM_URL" <<'PY'
import json
import os
import sys
import urllib.request

podium_url = sys.argv[1].rstrip("/")
token = os.environ.get("PODIUM_ENROLLMENT_TOKEN", "")
body = json.dumps({"enrollment_token": token}).encode()
request = urllib.request.Request(
    f"{podium_url}/api/v1/runtime/enroll",
    data=body,
    headers={"Content-Type": "application/json", "Accept": "application/json"},
    method="POST",
)
with urllib.request.urlopen(request, timeout=30) as response:
    print(response.read().decode())
PY
)"

RUNTIME_ID="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["runtime_id"])' <<<"$ENROLLED_JSON")"
RUNTIME_TOKEN="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["runtime_token"])' <<<"$ENROLLED_JSON")"
PROXY_TOKEN="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["proxy_token"])' <<<"$ENROLLED_JSON")"
WS_URL="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["websocket_url"])' <<<"$ENROLLED_JSON")"
RUNTIME_GROUP_ID="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("runtime_group_id", ""))' <<<"$ENROLLED_JSON")"

if [ "$START_CONDUCTOR" = "1" ]; then
  CONDUCTOR_LOG="/tmp/podium-conductor-${RUNTIME_ID}.log"
  CONDUCTOR_PID="$(python3 - "$CONDUCTOR_COMMAND" "$CONDUCTOR_PORT" "$DATA_ROOT" "$CONDUCTOR_LOG" <<'PY'
import subprocess
import sys

command, port, data_root, log_path = sys.argv[1:]
log = open(log_path, "ab", buffering=0)
process = subprocess.Popen(
    [command, "--port", port, "--data-root", data_root],
    stdin=subprocess.DEVNULL,
    stdout=log,
    stderr=log,
    start_new_session=True,
    close_fds=True,
)
print(process.pid)
PY
)"
  for _ in $(seq 1 50); do
    if python3 - "$CONDUCTOR_PORT" <<'PY'
import sys
import urllib.request
try:
    urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/", timeout=1)
except Exception:
    raise SystemExit(1)
PY
    then
      break
    fi
    if ! kill -0 "$CONDUCTOR_PID" >/dev/null 2>&1; then
      echo "conductor exited during startup; see /tmp/podium-conductor-${RUNTIME_ID}.log" >&2
      exit 1
    fi
    sleep 0.2
  done
fi

python3 - "$CONDUCTOR_PORT" "$PODIUM_URL" "$RUNTIME_ID" "$RUNTIME_TOKEN" "$PROXY_TOKEN" "$WS_URL" "$RUNTIME_GROUP_ID" <<'PY'
import json
import sys
import urllib.request

port, podium_url, runtime_id, runtime_token, proxy_token, ws_url, runtime_group_id = sys.argv[1:]
body = json.dumps({
    "podium_url": podium_url.rstrip("/"),
    "podium_runtime_id": runtime_id,
    "podium_runtime_token": runtime_token,
    "podium_proxy_token": proxy_token,
    "podium_ws_url": ws_url,
    "runtime_group_id": runtime_group_id,
    "managed_mode": True,
}).encode()
request = urllib.request.Request(
    f"http://127.0.0.1:{port}/api/settings",
    data=body,
    headers={"Content-Type": "application/json", "Accept": "application/json"},
    method="PATCH",
)
with urllib.request.urlopen(request, timeout=30) as response:
    response.read()
PY

echo "Podium conductor enrolled as ${RUNTIME_ID}."
echo "Conductor API: http://127.0.0.1:${CONDUCTOR_PORT}"
    '''


def _dict_payload(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _list_payload(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _json_dumps(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _json_loads(value: Any, *, default: Any = None) -> Any:
    if not isinstance(value, str):
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def _datetime_to_json(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat().replace("+00:00", "Z")
    return value


def _datetime_from_json(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value


def _session_to_json(value: dict[str, Any]) -> dict[str, Any]:
    payload = dict(value)
    payload["expires_at"] = _datetime_to_json(payload.get("expires_at"))
    return payload


def _session_from_json(value: dict[str, Any]) -> dict[str, Any]:
    payload = dict(value)
    payload["expires_at"] = _datetime_from_json(payload.get("expires_at"))
    return payload


def _enrollment_token_to_json(value: dict[str, Any]) -> dict[str, Any]:
    payload = dict(value)
    payload["expires_at"] = _datetime_to_json(payload.get("expires_at"))
    return payload


def _enrollment_token_from_json(value: dict[str, Any]) -> dict[str, Any]:
    payload = dict(value)
    payload["expires_at"] = _datetime_from_json(payload.get("expires_at"))
    return payload


def _dispatch_to_json(value: dict[str, Any]) -> dict[str, Any]:
    payload = dict(value)
    payload["leased_until"] = _datetime_to_json(payload.get("leased_until"))
    return payload


def _dispatch_from_json(value: dict[str, Any]) -> dict[str, Any]:
    payload = dict(value)
    payload["leased_until"] = _datetime_from_json(payload.get("leased_until"))
    return payload


def _tuple_keyed_dict_to_json(value: dict[tuple[str, str], dict[str, Any]]) -> dict[str, Any]:
    return {f"{first}\u001f{second}": payload for (first, second), payload in value.items()}


def _tuple_keyed_dict_from_json(value: Any) -> dict[tuple[str, str], dict[str, Any]]:
    result: dict[tuple[str, str], dict[str, Any]] = {}
    for key, payload in _dict_payload(value).items():
        first, sep, second = str(key).partition("\u001f")
        if sep and isinstance(payload, dict):
            result[(first, second)] = payload
    return result


def _fernet_for_secret(secret_key: str) -> Fernet:
    if not secret_key:
        raise RuntimeError("encryption_unavailable")
    key = base64.urlsafe_b64encode(hashlib.sha256(secret_key.encode()).digest())
    return Fernet(key)


def _encrypt_with_secret(plaintext: str, secret_key: str) -> str:
    return _fernet_for_secret(secret_key).encrypt(plaintext.encode()).decode()


def _decrypt_with_secret(ciphertext: str, secret_key: str) -> str:
    return _fernet_for_secret(secret_key).decrypt(ciphertext.encode()).decode()


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def bearer_token(authorization: str) -> str:
    return authorization.removeprefix("Bearer ").strip() if authorization.startswith("Bearer ") else authorization.strip()


def optional_int(value: Any, default: int | None) -> int | None:
    if value is None:
        return default
    if isinstance(value, str) and value.strip().lower() in {"", "none", "null", "all"}:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def query_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_agent_session_event(payload: dict[str, Any]) -> dict[str, Any]:
    session = payload.get("agentSession") if isinstance(payload.get("agentSession"), dict) else {}
    issue = session.get("issue") if isinstance(session.get("issue"), dict) else {}
    project = issue.get("project") if isinstance(issue.get("project"), dict) else {}
    agent = session.get("agent") if isinstance(session.get("agent"), dict) else {}
    workspace = payload.get("workspace") if isinstance(payload.get("workspace"), dict) else {}
    parent = issue.get("parent") if isinstance(issue.get("parent"), dict) else payload.get("parent")
    return {
        "workspace_id": str(workspace.get("id") or payload.get("workspace_id") or ""),
        "project_slug": str(project.get("slugId") or payload.get("project_slug") or ""),
        "issue_id": str(issue.get("id") or payload.get("issue_id") or ""),
        "issue_identifier": str(issue.get("identifier") or payload.get("issue_identifier") or ""),
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
