from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
from typing import Any, Callable

import uvicorn

from .app import create_app
from .auth_service import AuthService
from .config import PodiumConfig
from .runtime_service import RuntimeService
from .store import PodiumStore


class PodiumServer:
    """Test/local server wrapper around the Podium FastAPI app."""

    def __init__(
        self,
        *,
        secret_key: str = "",
        data_dir: str | Path | None = None,
        linear_client_id: str = "",
        linear_client_secret: str = "",
        linear_redirect_uri: str = "",
        linear_webhook_secret: str = "",
        linear_application_version: int = 1,
        linear_graphql_transport: Callable[..., Any] | None = None,
        podium_base_url: str = "https://podium.example",
        store: Any | None = None,
        config: PodiumConfig | None = None,
        debug_auth: bool = False,
    ) -> None:
        self.secret_key = secret_key
        self.data_dir = data_dir
        self.linear_client_id = linear_client_id
        self.linear_client_secret = linear_client_secret
        self.linear_redirect_uri = linear_redirect_uri
        self.linear_webhook_secret = linear_webhook_secret
        self.linear_application_version = linear_application_version
        self.linear_graphql_transport = linear_graphql_transport
        self.podium_base_url = podium_base_url
        self.state_store = store or PodiumStore(data_dir=data_dir)
        self.config = config or PodiumConfig.from_env()
        self.debug_auth = debug_auth
        self.port: int | None = None
        self.store = self.state_store
        self.auth_service = AuthService(self.store, secret_key) if secret_key.strip() else None
        self.runtime_service = RuntimeService(self.store)
        self.app = None
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task[Any] | None = None

    async def start(self, *, port: int = 0, host: str = "127.0.0.1") -> None:
        self.app = create_app(
            turnstile_verifier=lambda _token, _ip: True,
            secure_cookies=False,
            static_dir=None,
            data_dir=self.data_dir,
            secret_key=self.secret_key if self.auth_service is not None else "",
            linear_client_id=self.linear_client_id,
            linear_client_secret=self.linear_client_secret,
            linear_redirect_uri=self.linear_redirect_uri,
            linear_webhook_secret=self.linear_webhook_secret,
            linear_application_version=self.linear_application_version,
            linear_graphql_transport=self.linear_graphql_transport,
            podium_base_url=self.podium_base_url,
            store=self.state_store,
            config=self.config,
            debug_auth=self.debug_auth,
        )
        self.app.state.podium.server_wrapper = self
        if self.auth_service is not None:
            self.app.state.podium.session_ttl = self.auth_service.session_ttl
        config = uvicorn.Config(self.app, host=host, port=port, log_level="warning")
        self._server = uvicorn.Server(config)
        started = asyncio.Event()
        original_startup = self._server.startup

        async def startup_with_signal(*args: Any, **kwargs: Any) -> None:
            await original_startup(*args, **kwargs)
            sockets = self._server.servers[0].sockets if self._server and self._server.servers else []
            if sockets:
                self.port = int(sockets[0].getsockname()[1])
            started.set()

        self._server.startup = startup_with_signal  # type: ignore[method-assign]
        self._task = asyncio.create_task(self._server.serve())
        await asyncio.wait_for(started.wait(), timeout=5)

    async def stop(self) -> None:
        if self._server is not None:
            self._server.should_exit = True
        if self._task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.wait_for(self._task, timeout=5)
        self._task = None
        self._server = None
