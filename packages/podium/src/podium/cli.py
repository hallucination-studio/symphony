from __future__ import annotations

import argparse
import asyncio
import os
from pathlib import Path

from .server import PodiumServer

_PACKAGED_STATIC_DIR = Path(__file__).resolve().parent / "static"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Symphony Podium SaaS boundary.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    parser.add_argument("--port", type=int, default=8090, help="Bind port")
    parser.add_argument("--token", default=None, help="Bearer token for conductor registration")
    parser.add_argument("--linear-client-id", default=None, help="Linear OAuth application client id")
    parser.add_argument("--linear-client-secret", default=None, help="Linear OAuth application client secret")
    parser.add_argument("--linear-redirect-uri", default=None, help="Linear OAuth redirect URI")
    parser.add_argument("--linear-webhook-secret", default=None, help="Linear OAuth application webhook secret")
    parser.add_argument("--linear-installations-path", default=None, help="Path to persist Linear OAuth installations")
    parser.add_argument("--podium-base-url", default=None, help="Public base URL Podium serves the runtime installer from (used to compose the install command)")
    return parser.parse_args(argv)


async def run_server(
    *,
    host: str,
    port: int,
    token: str | None,
    linear_client_id: str | None = None,
    linear_client_secret: str | None = None,
    linear_redirect_uri: str | None = None,
    linear_webhook_secret: str | None = None,
    linear_installations_path: str | None = None,
    podium_base_url: str | None = None,
) -> None:
    server = PodiumServer(
        token=token or os.environ.get("PODIUM_TOKEN"),
        linear_client_id=linear_client_id or os.environ.get("LINEAR_CLIENT_ID"),
        linear_client_secret=linear_client_secret or os.environ.get("LINEAR_CLIENT_SECRET"),
        linear_redirect_uri=linear_redirect_uri or os.environ.get("LINEAR_REDIRECT_URI"),
        linear_webhook_secret=linear_webhook_secret or os.environ.get("LINEAR_WEBHOOK_SECRET"),
        linear_installations_path=linear_installations_path or os.environ.get("PODIUM_LINEAR_INSTALLATIONS_PATH"),
        podium_base_url=podium_base_url or os.environ.get("PODIUM_BASE_URL"),
        static_dir=_PACKAGED_STATIC_DIR if _PACKAGED_STATIC_DIR.is_dir() else None,
    )
    await server.start(host=host, port=port)
    try:
        while True:
            await asyncio.sleep(3600)
    finally:
        await server.stop()


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        asyncio.run(
            run_server(
                host=args.host,
                port=args.port,
                token=args.token,
                linear_client_id=args.linear_client_id,
                linear_client_secret=args.linear_client_secret,
                linear_redirect_uri=args.linear_redirect_uri,
                linear_webhook_secret=args.linear_webhook_secret,
                linear_installations_path=args.linear_installations_path,
                podium_base_url=args.podium_base_url,
            )
        )
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
