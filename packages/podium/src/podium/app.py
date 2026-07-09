from __future__ import annotations

import asyncio
import contextlib
import json
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
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
from .podium_routes_core import LINEAR_AUTHORIZE_URL, LINEAR_DEFAULT_SCOPE, public_user, register_core_routes
from .podium_routes_runtime import register_runtime_routes
from .podium_runtime import PodiumRuntimeMixin
from .podium_shared import utc_now_iso
from .podium_state import PodiumStateBaseMixin
from .store import PodiumStore


TurnstileVerifier = Callable[[str, str | None], bool]

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

    register_core_routes(
        app,
        state=state,
        require_user=require_user,
        linear_token_exchange=linear_token_exchange,
        linear_scope_fetch=linear_scope_fetch,
        linear_graphql_transport=linear_graphql_transport,
        error_response=error_response,
    )

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
