from __future__ import annotations

import argparse
import asyncio
import logging
from pathlib import Path
import signal

from .conductor_api import ConductorApiServer
from .conductor_service import ConductorService
from .models import LocalRuntimeBootstrap, LocalRuntimeIdentity
from .podium_ipc import LocalRuntimeClient
from .store import ConductorStore


LOGGER = logging.getLogger(__name__)
_PRIVATE_ARGUMENTS = (
    "podium_ipc_fd",
    "conductor_id",
    "instance_id",
    "project_id",
    "binding_id",
    "binding_generation",
    "handshake_correlation_id",
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Symphony Conductor daemon for Performer instances.")
    parser.add_argument("--host", help="Bind host for the legacy HTTP daemon")
    parser.add_argument("--port", type=int, help="Bind port for the legacy HTTP daemon")
    parser.add_argument(
        "--data-root",
        default=".conductor",
        help="Root directory for Conductor metadata and per-instance runtime artifacts",
    )
    parser.add_argument("--podium-ipc-fd", type=int)
    parser.add_argument("--conductor-id")
    parser.add_argument("--instance-id")
    parser.add_argument("--project-id")
    parser.add_argument("--binding-id")
    parser.add_argument("--binding-generation", type=int)
    parser.add_argument("--handshake-correlation-id")
    return parser.parse_args(argv)


def private_bootstrap_from_args(
    args: argparse.Namespace,
) -> LocalRuntimeBootstrap | None:
    values = [getattr(args, name) for name in _PRIVATE_ARGUMENTS]
    if all(value is None for value in values):
        return None
    if any(value is None for value in values) or args.host is not None or args.port is not None:
        raise ValueError("conductor_private_bootstrap_invalid")
    try:
        identity = LocalRuntimeIdentity(
            args.conductor_id,
            args.instance_id,
            args.project_id,
            args.binding_id,
            args.binding_generation,
        )
        return LocalRuntimeBootstrap(
            args.podium_ipc_fd, identity, args.handshake_correlation_id
        )
    except (TypeError, ValueError):
        raise ValueError("conductor_private_bootstrap_invalid") from None


async def run_server(*, host: str, port: int, data_root: Path) -> None:
    service = ConductorService(store=ConductorStore(data_root), data_root=data_root)
    server = ConductorApiServer(service)
    await service.start()
    await server.start(host=host, port=port)
    stop, installed_signals = _install_stop_signals()
    try:
        await stop.wait()
    finally:
        loop = asyncio.get_running_loop()
        for signum in installed_signals:
            loop.remove_signal_handler(signum)
        await server.stop()
        await service.stop()


async def run_private_runtime(
    *, bootstrap: LocalRuntimeBootstrap, data_root: Path
) -> None:
    stop, installed_signals = _install_stop_signals()
    client: LocalRuntimeClient | None = None
    service: ConductorService | None = None
    try:
        client = LocalRuntimeClient.connect(
            bootstrap.podium_ipc_fd,
            bootstrap.identity,
            bootstrap.handshake,
        )
        service = ConductorService(store=ConductorStore(data_root), data_root=data_root)
        await service.start()
        await _run_private_ticks(service, client, stop)
    finally:
        if client is not None:
            client.close()
        if service is not None:
            await service.stop()
        loop = asyncio.get_running_loop()
        for signum in installed_signals:
            loop.remove_signal_handler(signum)


async def _run_private_ticks(
    service: ConductorService,
    client: LocalRuntimeClient,
    stop: asyncio.Event,
) -> None:
    while not stop.is_set():
        tick = asyncio.create_task(service.private_sync_once(client))
        stopping = asyncio.create_task(stop.wait())
        done, _ = await asyncio.wait(
            {tick, stopping}, return_when=asyncio.FIRST_COMPLETED
        )
        if stopping in done:
            tick.cancel()
            client.close()
            try:
                await tick
            except asyncio.CancelledError:
                pass
            return
        stopping.cancel()
        try:
            await stopping
        except asyncio.CancelledError:
            pass
        try:
            result = await tick
        except Exception:
            if client.closed:
                raise
            await asyncio.sleep(0.1)
            continue
        if result.get("status") == "accepted":
            await service.coordinate_background_once()


def _install_stop_signals() -> tuple[asyncio.Event, list[signal.Signals]]:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    installed_signals: list[signal.Signals] = []
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signum, stop.set)
        except NotImplementedError:
            continue
        installed_signals.append(signum)
    return stop, installed_signals


def _log_private_bootstrap_failure(
    bootstrap: LocalRuntimeBootstrap, error: Exception
) -> None:
    code = str(error)
    if not code.startswith("podium_ipc_"):
        code = "conductor_private_bootstrap_failed"
    identity = bootstrap.identity
    LOGGER.error(
        "event=conductor_private_bootstrap_failed conductor_id=%s instance_id=%s "
        "project_id=%s binding_id=%s binding_generation=%s "
        "handshake_correlation_id=%s error_type=local_runtime error_code=%s "
        "sanitized_reason=%s action_required=true retryable=false "
        "next_action=restart_conductor",
        identity.conductor_id,
        identity.instance_id,
        identity.project_id,
        identity.binding_id,
        identity.binding_generation,
        bootstrap.handshake_correlation_id,
        code,
        code,
    )


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        bootstrap = private_bootstrap_from_args(args)
    except ValueError:
        LOGGER.error(
            "event=conductor_private_bootstrap_failed conductor_id=- instance_id=- "
            "project_id=- binding_id=- binding_generation=- "
            "handshake_correlation_id=- error_type=local_runtime "
            "error_code=conductor_private_bootstrap_invalid "
            "sanitized_reason=conductor_private_bootstrap_invalid "
            "action_required=true retryable=false next_action=fix_desktop_launch"
        )
        return 1
    try:
        if bootstrap is not None:
            asyncio.run(
                run_private_runtime(
                    bootstrap=bootstrap, data_root=Path(args.data_root).resolve()
                )
            )
        else:
            asyncio.run(
                run_server(
                    host=args.host if args.host is not None else "127.0.0.1",
                    port=args.port if args.port is not None else 8081,
                    data_root=Path(args.data_root).resolve(),
                )
            )
    except KeyboardInterrupt:
        return 0
    except Exception as error:
        if bootstrap is None:
            raise
        _log_private_bootstrap_failure(bootstrap, error)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
