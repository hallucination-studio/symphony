from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
from pathlib import Path

import uvicorn

from .app import create_app
from .config import PodiumConfig
from .store import PgStore, RedisStore


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Symphony Podium SaaS boundary.")
    subparsers = parser.add_subparsers(dest="command")
    api_parser = subparsers.add_parser("api", help="Run the managed FastAPI control plane")
    api_parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    api_parser.add_argument("--port", type=int, default=8090, help="Bind port")
    parser.set_defaults(command="api", host="127.0.0.1", port=8090)
    parser.add_argument("--host", default="127.0.0.1", help=argparse.SUPPRESS)
    parser.add_argument("--port", type=int, default=8090, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.command is None:
        args.command = "api"
    return args


def main(argv: list[str] | None = None) -> int:
    return asyncio.run(async_main(argv))


async def async_main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    config = PodiumConfig.from_env()
    pg_store = None
    redis_store = None
    if config.database_url:
        pg_store = await PgStore.connect(config.database_url)
        await pg_store.migrate()
    if config.redis_url:
        redis_store = RedisStore(redis_url=config.redis_url)
    default_static = Path(__file__).resolve().parent / "static"
    app = create_app(
        session_cookie_name=os.environ.get("PODIUM_SESSION_COOKIE_NAME", "podium_session"),
        linear_webhook_secret=os.environ.get("LINEAR_WEBHOOK_SECRET", ""),
        static_dir=str(default_static) if default_static.exists() else None,
        data_dir=os.environ.get("PODIUM_DATA_DIR"),
        secret_key=os.environ.get("PODIUM_SECRET_KEY", ""),
        linear_client_id=os.environ.get("LINEAR_CLIENT_ID", ""),
        linear_client_secret=os.environ.get("LINEAR_CLIENT_SECRET", ""),
        linear_redirect_uri=os.environ.get("LINEAR_REDIRECT_URI", ""),
        podium_base_url=os.environ.get("PODIUM_BASE_URL", "https://podium.example"),
        pg_store=pg_store,
        redis_store=redis_store,
        config=config,
        debug_auth=env_flag("PODIUM_DEBUG_AUTH"),
    )
    try:
        config = uvicorn.Config(app, host=args.host, port=args.port)
        server = uvicorn.Server(config)
        await server.serve()
    finally:
        if redis_store is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await redis_store.close()
        if pg_store is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await pg_store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
