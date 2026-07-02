from __future__ import annotations

import argparse
import os

import uvicorn

from .app import create_app


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
    args = parse_args(argv)
    app = create_app(
        session_cookie_name=os.environ.get("PODIUM_SESSION_COOKIE_NAME", "podium_session"),
        linear_webhook_secret=os.environ.get("LINEAR_WEBHOOK_SECRET", ""),
    )
    uvicorn.run(app, host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
