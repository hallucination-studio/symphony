from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from .conductor_api import ConductorApiServer
from .conductor_service import ConductorService
from .conductor_store import ConductorStore


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Symphony Conductor daemon for Performer instances.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    parser.add_argument("--port", type=int, default=8081, help="Bind port")
    parser.add_argument(
        "--data-root",
        default=".conductor",
        help="Root directory for Conductor metadata and per-instance runtime artifacts",
    )
    return parser.parse_args(argv)


async def run_server(*, host: str, port: int, data_root: Path) -> None:
    service = ConductorService(store=ConductorStore(data_root), data_root=data_root)
    server = ConductorApiServer(service)
    await server.start(host=host, port=port)
    try:
        while True:
            await asyncio.sleep(3600)
    finally:
        await server.stop()


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        asyncio.run(run_server(host=args.host, port=args.port, data_root=Path(args.data_root).resolve()))
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
