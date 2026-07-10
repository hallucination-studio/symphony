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
from .linear_reconciliation import LinearReconciler, run_linear_reconciliation_loop
from .podium_dispatch import PodiumDispatchMixin
from .podium_conductors import PodiumConductorsMixin
from .podium_install import render_install_script
from .podium_linear_installations import PodiumLinearInstallationsMixin
from .podium_linear_cutover import PodiumLinearCutoverMixin
from .podium_linear_projects import PodiumLinearProjectsMixin
from .podium_project_bindings import PodiumProjectBindingsMixin
from .podium_routes_core import register_core_routes
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
    linear_webhook_secret: str = "",
    linear_application_version: int | None = None,
    linear_token_exchange: Callable[..., Any] | None = None,
    linear_installation_fetch: Callable[..., Any] | None = None,
    linear_graphql_transport: Callable[[httpx.Request], Any] | None = None,
    podium_base_url: str = "https://podium.example",
    store: Any | None = None,
    config: PodiumConfig | None = None,
    debug_auth: bool = False,
) -> FastAPI:
    resolved_config = config or PodiumConfig.from_env()
    state = _create_state(
        turnstile_verifier=turnstile_verifier or verify_turnstile_with_cloudflare,
        session_cookie_name=session_cookie_name,
        secure_cookies=secure_cookies,
        secret_key=secret_key,
        linear_client_id=linear_client_id or resolved_config.linear_client_id,
        linear_client_secret=linear_client_secret or resolved_config.linear_client_secret,
        linear_redirect_uri=linear_redirect_uri or resolved_config.linear_redirect_uri,
        linear_webhook_secret=linear_webhook_secret or resolved_config.linear_webhook_secret,
        linear_application_version=(
            resolved_config.linear_application_version
            if linear_application_version is None
            else linear_application_version
        ),
        podium_base_url=podium_base_url,
        data_dir=data_dir,
        store=store or PodiumStore(data_dir=data_dir),
        config=resolved_config,
        debug_auth=debug_auth,
    )
    app = FastAPI(
        title="Symphony Podium",
        lifespan=_make_lifespan(state, linear_graphql_transport=linear_graphql_transport),
    )
    app.state.podium = state
    app.state.dispatch_reaper_task = None
    app.state.linear_reconciliation_task = None
    static_root = Path(static_dir).resolve() if static_dir else None
    index_file = static_root / "index.html" if static_root else None

    async def require_user(request: Request) -> dict[str, Any] | None:
        podium_session = request.cookies.get(state.session_cookie_name)
        return await state.user_for_session(podium_session or "")

    _register_base_routes(app, state=state, static_root=static_root, index_file=index_file)
    register_core_routes(
        app,
        state=state,
        require_user=require_user,
        linear_token_exchange=linear_token_exchange,
        linear_installation_fetch=linear_installation_fetch,
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
    _register_static_fallback(app, static_root=static_root, index_file=index_file)
    return app


def _create_state(
    *,
    turnstile_verifier: TurnstileVerifier,
    session_cookie_name: str,
    secure_cookies: bool,
    secret_key: str,
    linear_client_id: str,
    linear_client_secret: str,
    linear_redirect_uri: str,
    linear_webhook_secret: str,
    linear_application_version: int,
    podium_base_url: str,
    data_dir: str | Path | None,
    store: Any,
    config: PodiumConfig,
    debug_auth: bool,
) -> "ManagedPodiumState":
    return ManagedPodiumState(
        turnstile_verifier=turnstile_verifier,
        session_cookie_name=session_cookie_name,
        secure_cookies=secure_cookies,
        secret_key=secret_key,
        linear_client_id=linear_client_id,
        linear_client_secret=linear_client_secret,
        linear_redirect_uri=linear_redirect_uri,
        linear_webhook_secret=linear_webhook_secret,
        linear_application_version=linear_application_version,
        podium_base_url=podium_base_url,
        data_dir=data_dir,
        store=store,
        config=config,
        debug_auth=debug_auth,
    )


def _make_lifespan(
    state: Any,
    *,
    linear_graphql_transport: Callable[[httpx.Request], Any] | None,
) -> Any:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.dispatch_reaper_task = asyncio.create_task(_dispatch_lease_reaper_loop(app))
        app.state.linear_reconciliation_task = _start_linear_reconciliation(
            state,
            linear_graphql_transport=linear_graphql_transport,
        )
        try:
            yield
        finally:
            await _cancel_background_tasks(app)

    return lifespan


async def _cancel_background_tasks(app: FastAPI) -> None:
    for task_name in ("linear_reconciliation_task", "dispatch_reaper_task"):
        task = getattr(app.state, task_name, None)
        if task is None:
            continue
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        setattr(app.state, task_name, None)
    app.state.dispatch_reaper_task = None


def _register_base_routes(
    app: FastAPI,
    *,
    state: Any,
    static_root: Path | None,
    index_file: Path | None,
) -> None:
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


def _register_static_fallback(
    app: FastAPI,
    *,
    static_root: Path | None,
    index_file: Path | None,
) -> None:
    if not static_root or not index_file or not index_file.exists():
        return

    @app.get("/{full_path:path}")
    async def static_or_spa(full_path: str) -> Response:
        if full_path.startswith("api/"):
            return error_response(404, "not_found", "Route not found")
        candidate = (static_root / full_path).resolve()
        if candidate.is_file() and (candidate == static_root or static_root in candidate.parents):
            return FileResponse(candidate)
        return HTMLResponse(index_file.read_text(encoding="utf-8"))


def _start_linear_reconciliation(
    state: Any,
    *,
    linear_graphql_transport: Callable[[httpx.Request], Any] | None,
) -> asyncio.Task[Any]:
    config = state.config
    reconciler = LinearReconciler(
        state=state,
        transport=linear_graphql_transport,
        page_size=int(getattr(config, "linear_reconciliation_page_size", 50) or 50),
        initial_lookback_seconds=int(
            getattr(config, "linear_reconciliation_initial_lookback_seconds", 0)
        ),
    )
    return asyncio.create_task(
        run_linear_reconciliation_loop(
            reconciler,
            interval_seconds=float(
                getattr(config, "linear_reconciliation_interval_seconds", 15) or 15
            ),
        )
    )


@dataclass
class ManagedPodiumState(
    PodiumStateBaseMixin,
    PodiumLinearInstallationsMixin,
    PodiumLinearCutoverMixin,
    PodiumLinearProjectsMixin,
    PodiumConductorsMixin,
    PodiumProjectBindingsMixin,
    PodiumRuntimeMixin,
    PodiumDispatchMixin,
):
    turnstile_verifier: TurnstileVerifier
    session_cookie_name: str
    secure_cookies: bool
    secret_key: str = ""
    data_dir: str | Path | None = None
    linear_client_id: str = ""
    linear_client_secret: str = ""
    linear_redirect_uri: str = ""
    linear_webhook_secret: str = ""
    linear_application_version: int = 1
    podium_base_url: str = "https://podium.example"
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
