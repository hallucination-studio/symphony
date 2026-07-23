from __future__ import annotations

import argparse
import json
import signal
import sys
from pathlib import Path
from threading import Event

from performer.agent_protocol.host import AgentProtocolHost
from performer.backends.codex.codex_backend_impl import CodexBackendImpl, create_sdk
from performer.profile_control.host import ProfileControlHost


def main() -> None:
    parser = argparse.ArgumentParser(prog="performer")
    parser.add_argument("--profile-control", action="store_true")
    parser.add_argument("--agent", action="store_true")
    parser.add_argument("--workspace-root", type=Path)
    args = parser.parse_args()
    try:
        sdk = create_sdk()
    except ValueError as error:
        raise SystemExit(str(error)) from None
    if args.profile_control:
        metadata_line = sys.stdin.buffer.readline(65537)
        if not metadata_line.endswith(b"\n") or len(metadata_line) > 65536:
            raise SystemExit("invalid profile control metadata frame")
        metadata = json.loads(metadata_line)
        for result in ProfileControlHost(sdk).iter_results(metadata, sys.stdin.buffer):
            print(json.dumps(result, separators=(",", ":")), flush=True)
        return
    backend = CodexBackendImpl(sdk)
    if args.agent:
        cancel_event = Event()
        previous_term = signal.signal(signal.SIGTERM, lambda *_: cancel_event.set())
        previous_int = signal.signal(signal.SIGINT, lambda *_: cancel_event.set())
        try:
            host = AgentProtocolHost(backend, workspace_root=args.workspace_root)
            for result in host.iter_lines(sys.stdin.buffer):
                print(json.dumps(result, separators=(",", ":")), flush=True)
        except ValueError as error:
            raise SystemExit(str(error)) from None
        finally:
            signal.signal(signal.SIGTERM, previous_term)
            signal.signal(signal.SIGINT, previous_int)
        return
    parser.error("--agent or --profile-control is required")


if __name__ == "__main__":
    main()
