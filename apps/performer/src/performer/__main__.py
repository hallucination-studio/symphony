from __future__ import annotations

import argparse
import json
import signal
import sys
from pathlib import Path
from threading import Event

from performer.backends.codex.codex_backend_impl import CodexBackendImpl, create_sdk
from performer.profile_control.host import ProfileControlHost
from performer.stage_execution.runtime import StageExecutionRuntime
from performer.stage_protocol.host import StageFileHost


def main() -> None:
    parser = argparse.ArgumentParser(prog="performer")
    parser.add_argument("--profile-control", action="store_true")
    parser.add_argument("--request", dest="stage_request_path", type=Path)
    parser.add_argument("--result", dest="stage_result_path", type=Path)
    parser.add_argument("--workspace-root", type=Path)
    args = parser.parse_args()
    try:
        sdk = create_sdk()
    except ValueError as error:
        raise SystemExit(str(error)) from None
    if bool(args.stage_request_path) != bool(args.stage_result_path):
        raise SystemExit("stage request and result paths are required together")
    if args.profile_control:
        metadata_line = sys.stdin.buffer.readline(65537)
        if not metadata_line.endswith(b"\n") or len(metadata_line) > 65536:
            raise SystemExit("invalid profile control metadata frame")
        metadata = json.loads(metadata_line)
        for result in ProfileControlHost(sdk).iter_results(metadata, sys.stdin.buffer):
            print(json.dumps(result, separators=(",", ":")), flush=True)
        return
    backend = CodexBackendImpl(sdk)
    if args.stage_request_path and args.stage_result_path:
        if args.workspace_root is None:
            raise SystemExit("stage workspace capability is required")
        cancel_event = Event()
        previous_term = signal.signal(signal.SIGTERM, lambda *_: cancel_event.set())
        previous_int = signal.signal(signal.SIGINT, lambda *_: cancel_event.set())
        try:
            StageFileHost(StageExecutionRuntime(backend)).run(
                args.stage_request_path,
                args.stage_result_path,
                args.workspace_root,
                cancel_event=cancel_event,
                emit_event=_emit_stage_event,
            )
        except ValueError as error:
            raise SystemExit(str(error)) from None
        finally:
            signal.signal(signal.SIGTERM, previous_term)
            signal.signal(signal.SIGINT, previous_int)
        return
    parser.error("a Stage request/result pair or Profile control is required")


def _emit_stage_event(event: dict[str, Any]) -> None:
    try:
        print(json.dumps(event, separators=(",", ":")), flush=True)
    except (OSError, ValueError):
        pass


if __name__ == "__main__":
    main()
