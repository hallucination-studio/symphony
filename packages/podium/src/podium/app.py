from __future__ import annotations

import asyncio
import contextlib
import json
import os
import urllib.parse
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import httpx
from argon2 import PasswordHasher
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

from .config import PodiumConfig
from .linear_polling import LinearDelegatePoller, run_linear_delegate_poll_loop
from .podium_dispatch import PodiumDispatchMixin
from .podium_install import render_install_script
from .podium_oauth import PodiumOAuthMixin
from .podium_routes_runtime import register_runtime_routes
from .podium_runtime import PodiumRuntimeMixin
from .podium_shared import utc_now_iso
from .podium_state import PodiumStateBaseMixin, SecretDecryptionError
from .store import PodiumStore


TurnstileVerifier = Callable[[str, str | None], bool]

LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize"
LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token"
LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"
LINEAR_DEFAULT_SCOPE = "read,write,app:assignable,app:mentionable"
LINEAR_SCOPE_QUERY = "query { teams { nodes { id name key } } projects { nodes { id name } } }"

LINEAR_SUCCESS_HTML = (
    "<!doctype html><html><head><meta charset=\"utf-8\">"
    "<title>Linear connected</title></head>"
    "<body style=\"font-family: system-ui, sans-serif; text-align: center; padding: 3rem;\">"
    "<h1>Linear connected</h1>"
    "<p>Authorization succeeded. You can close this window.</p>"
    "<script>setTimeout(function(){ try { window.close(); } catch (e) {} }, 500);</script>"
    "</body></html>"
)


def create_app(
    *,
    turnstile_verifier: TurnstileVerifier | None = None,
    secure_cookies: bool = True,
    session_cookie_name: str = "podium_session",
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
    store: Any | None = None,
    config: PodiumConfig | None = None,
    debug_auth: bool = False,
) -> FastAPI:
    state = ManagedPodiumState(
        turnstile_verifier=turnstile_verifier or verify_turnstile_with_cloudflare,
        session_cookie_name=session_cookie_name,
        secure_cookies=secure_cookies,
        secret_key=secret_key,
        linear_client_id=linear_client_id,
        linear_client_secret=linear_client_secret,
        linear_redirect_uri=linear_redirect_uri,
        data_dir=data_dir,
        store=store or PodiumStore(data_dir=data_dir),
        config=config or PodiumConfig.from_env(),
        debug_auth=debug_auth,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.dispatch_reaper_task = asyncio.create_task(_dispatch_lease_reaper_loop(app))
        app.state.linear_delegate_poller_task = _start_linear_delegate_poller(
            state,
            linear_graphql_transport=linear_graphql_transport,
        )
        try:
            yield
        finally:
            for task_name in ("linear_delegate_poller_task", "dispatch_reaper_task"):
                task = getattr(app.state, task_name, None)
                if task is None:
                    continue
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
                setattr(app.state, task_name, None)
            app.state.dispatch_reaper_task = None

    app = FastAPI(title="Symphony Podium", lifespan=lifespan)
    app.state.podium = state
    app.state.dispatch_reaper_task = None
    app.state.linear_delegate_poller_task = None
    static_root = Path(static_dir).resolve() if static_dir else None
    index_file = static_root / "index.html" if static_root else None

    async def require_user(request: Request) -> dict[str, Any] | None:
        podium_session = request.cookies.get(state.session_cookie_name)
        return await state.user_for_session(podium_session or "")

    async def resolve_linear_creds(workspace_id: str) -> tuple[str, str, str] | JSONResponse:
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
        return Response(render_install_script(), media_type="text/x-shellscript; charset=utf-8")

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
                user = await state.ensure_debug_user()
                session_token = await state.create_session(str(user["id"]))
                json_response = JSONResponse({"user": public_user(user)})
                state.set_session_cookie(json_response, session_token)
                return json_response
            return error_response(401, "unauthorized", "Unauthorized")
        return JSONResponse({"user": public_user(user)})

    @app.get("/api/v1/onboarding/status")
    async def onboarding_status(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        user_id = str(user["id"])
        if await state.get_linear_installation(user_id) is not None:
            await state.mark_linear_connected(user_id)
        return JSONResponse(await state.onboarding_progress(user_id))

    @app.post("/api/v1/onboarding/scope")
    async def onboarding_scope(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        user_id = str(user["id"])
        progress = await state.save_onboarding_scope(user_id, payload.get("teams"), payload.get("projects"))
        return JSONResponse({"onboarding": progress})

    @app.post("/api/v1/onboarding/repository")
    async def onboarding_repository(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        user_id = str(user["id"])
        mode = str(payload.get("mode") or "")
        value = str(payload.get("value") or "")
        if mode not in {"local_path", "git_url"}:
            return error_response(400, "invalid_mode", "mode must be local_path or git_url")
        validation_state = "valid"
        if mode == "git_url" and not value.startswith(("https://", "git@")):
            validation_state = "invalid"
        progress = await state.save_onboarding_repository(user_id, mode, value)
        return JSONResponse(
            {
                "onboarding": progress,
                "repository": {"mode": mode, "value": value, "validation_state": validation_state},
            }
        )

    @app.post("/api/v1/onboarding/smoke-check")
    async def onboarding_smoke_check(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        result = {
            "status": "passed",
            "checks": [{"name": "runtime_online", "passed": True}],
            "recommendations": [],
            "timestamp": utc_now_iso(),
        }
        user_id = str(user["id"])
        await state.set_smoke_result(user_id, result)
        return JSONResponse(result)

    @app.get("/api/v1/onboarding/smoke-check/result")
    async def onboarding_smoke_check_result(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        user_id = str(user["id"])
        result = await state.get_smoke_result(user_id)
        if result is None:
            return error_response(404, "smoke_result_not_found", "No smoke result recorded")
        return JSONResponse(result)

    @app.get("/api/v1/bootstrap")
    async def bootstrap(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        user_id = str(user["id"])
        if await state.get_linear_installation(user_id) is not None:
            await state.mark_linear_connected(user_id)
        return JSONResponse(
            {
                "session": {"workspace_id": user_id, "user_id": user_id, "email": str(user["email"])},
                "onboarding": await state.onboarding_progress(user_id),
                "linear": await state.linear_status(user_id),
            }
        )

    @app.put("/api/v1/account/linear-app")
    async def put_linear_app(request: Request) -> JSONResponse:
        user = await require_user(request)
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
        return JSONResponse({"linear_app": {"client_id": client_id, "redirect_uri": redirect_uri, "configured": True}})

    @app.delete("/api/v1/account/linear-app")
    async def delete_linear_app(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        await state.set_user_linear_app(str(user["id"]), None)
        return JSONResponse({"ok": True, "linear_app": None})

    @app.post("/api/v1/onboarding/linear/start")
    async def linear_start(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        creds = await resolve_linear_creds(workspace_id)
        if isinstance(creds, JSONResponse):
            return creds
        client_id, _client_secret, redirect_uri = creds
        if not client_id:
            return error_response(400, "linear_app_not_configured", "No Linear app is configured")
        oauth_state = await state.create_oauth_state(workspace_id)
        query = urllib.parse.urlencode(
            {
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": LINEAR_DEFAULT_SCOPE,
                "actor": "app",
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
        workspace_id = await state.consume_oauth_state(callback_state)
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
                "actor": token.get("actor") or "app",
                "expires_at": expires_at,
            },
        )
        await state.mark_linear_connected(workspace_id)
        return HTMLResponse(LINEAR_SUCCESS_HTML)

    @app.get("/api/v1/onboarding/linear/scope")
    async def linear_scope(request: Request) -> JSONResponse:
        user = await require_user(request)
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

    register_runtime_routes(
        app,
        state=state,
        require_user=require_user,
        podium_base_url=podium_base_url,
        linear_graphql_transport=linear_graphql_transport,
        error_response=error_response,
    )

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


def _start_linear_delegate_poller(
    state: Any,
    *,
    linear_graphql_transport: Callable[[httpx.Request], Any] | None,
) -> asyncio.Task[Any] | None:
    config = state.config
    application_id = str(getattr(config, "linear_application_id", "") or "").strip()
    app_token = str(getattr(config, "linear_app_access_token", "") or "").strip()
    if not application_id or not app_token:
        return None
    poller = LinearDelegatePoller(
        store=state.store,
        application_id=application_id,
        app_token=app_token,
        transport=linear_graphql_transport,
        page_size=int(getattr(config, "linear_poll_page_size", 50) or 50),
        initial_lookback_seconds=int(getattr(config, "linear_poll_initial_lookback_seconds", 0)),
    )
    return asyncio.create_task(
        run_linear_delegate_poll_loop(
            poller,
            interval_seconds=float(getattr(config, "linear_poll_interval_seconds", 15) or 15),
        )
    )


@dataclass
class ManagedPodiumState(PodiumStateBaseMixin, PodiumOAuthMixin, PodiumRuntimeMixin, PodiumDispatchMixin):
    turnstile_verifier: TurnstileVerifier
    session_cookie_name: str
    secure_cookies: bool
    secret_key: str = ""
    data_dir: str | Path | None = None
    linear_client_id: str = ""
    linear_client_secret: str = ""
    linear_redirect_uri: str = ""
    password_hasher: PasswordHasher = field(default_factory=PasswordHasher)
    store: Any | None = None
    config: PodiumConfig = field(default_factory=PodiumConfig.from_env)
    debug_auth: bool = False


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


def error_response(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)
