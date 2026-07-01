from __future__ import annotations

import argparse
import asyncio
import os

from .server import PodiumServer


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Symphony Podium SaaS boundary.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    parser.add_argument("--port", type=int, default=8090, help="Bind port")
    parser.add_argument("--token", default=None, help="Bearer token for conductor registration")
    return parser.parse_args(argv)


async def run_server(*, host: str, port: int, token: str | None) -> None:
    server = PodiumServer(token=token or os.environ.get("PODIUM_TOKEN"))
    await server.start(host=host, port=port)
    try:
        while True:
            await asyncio.sleep(3600)
    finally:
        await server.stop()


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        asyncio.run(run_server(host=args.host, port=args.port, token=args.token))
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
