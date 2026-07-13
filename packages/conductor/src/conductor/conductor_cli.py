from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from .conductor_api import ConductorApiServer
from .conductor_service import ConductorService
from .store import ConductorStore
from .performer_credentials import PerformerCredentialError, PerformerCredentialSlots


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Symphony Conductor daemon for Performer instances.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    parser.add_argument("--port", type=int, default=8081, help="Bind port")
    parser.add_argument(
        "--data-root",
        default=".conductor",
        help="Root directory for Conductor metadata and per-instance runtime artifacts",
    )
    subparsers = parser.add_subparsers(dest="command")
    credentials = subparsers.add_parser("performer-credential", help="Manage local opaque Codex credential slots")
    credential_commands = credentials.add_subparsers(dest="credential_command", required=True)
    initialize = credential_commands.add_parser("init")
    initialize.add_argument("--id", required=True)
    initialize.add_argument("--name", required=True)
    check = credential_commands.add_parser("check")
    check.add_argument("--id", required=True)
    check.add_argument("--live", action="store_true", required=True)
    check.add_argument("--config", required=True, help="Validated runtime profile TOML path")
    check.add_argument("--model")
    select = credential_commands.add_parser("select")
    select.add_argument("--id", required=True)
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
    if args.command == "performer-credential":
        slots = PerformerCredentialSlots(Path(args.data_root).resolve())
        try:
            if args.credential_command == "init":
                result = slots.init(args.id, args.name)
            elif args.credential_command == "check":
                result = slots.check(args.id, Path(args.config).read_text(encoding="utf-8"), model=args.model)
            else:
                result = slots.select(args.id)
        except (PerformerCredentialError, OSError) as exc:
            code = exc.code if isinstance(exc, PerformerCredentialError) else "managed_codex_config_required"
            print(json.dumps({"status": "failed", "error_code": code}, sort_keys=True))
            return 1
        print(json.dumps(result, sort_keys=True))
        return 0
    try:
        asyncio.run(run_server(host=args.host, port=args.port, data_root=Path(args.data_root).resolve()))
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
