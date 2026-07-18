from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from performer.backends.codex.codex_backend_impl import CodexBackendImpl, create_sdk
from performer.profile_control.host import ProfileControlHost
from performer.turn_protocol.host import TurnFileHost
from performer.turn_runtime.runtime import TurnRuntime


def main() -> None:
    parser = argparse.ArgumentParser(prog="performer")
    parser.add_argument("--turn-request-path", type=Path)
    parser.add_argument("--turn-result-path", type=Path)
    parser.add_argument("--event-sequence-start", type=int, default=0)
    parser.add_argument("--profile-control", action="store_true")
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
    if args.turn_request_path is None or args.turn_result_path is None:
        parser.error("--turn-request-path and --turn-result-path are required")
    runtime = TurnRuntime(CodexBackendImpl(sdk))
    TurnFileHost(runtime.run).run(
        args.turn_request_path,
        args.turn_result_path,
        args.event_sequence_start,
    )


if __name__ == "__main__":
    main()
