from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from performer.backends.codex.codex_backend_impl import CodexBackendImpl, create_sdk
from performer.conversation_protocol.host import ConversationFileHost
from performer.events.event_mapper import root_turn_event
from performer.profile_control.host import ProfileControlHost
from performer.root_turn.host import RootTurnFileHost
from performer.root_turn.runtime import RootTurnRuntime


def main() -> None:
    parser = argparse.ArgumentParser(prog="performer")
    parser.add_argument("--open-conversation-request-path", type=Path)
    parser.add_argument("--open-conversation-result-path", type=Path)
    parser.add_argument("--root-turn-result-path", type=Path)
    parser.add_argument("--turn-id")
    parser.add_argument("--root-issue-id")
    parser.add_argument("--performer-profile-id")
    parser.add_argument("--performer-id")
    parser.add_argument("--context-digest")
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
    backend = CodexBackendImpl(sdk)
    if args.open_conversation_request_path and args.open_conversation_result_path:
        ConversationFileHost(backend.open_conversation).run(
            args.open_conversation_request_path, args.open_conversation_result_path
        )
        return
    correlation = [args.turn_id, args.root_issue_id, args.performer_profile_id,
                   args.performer_id, args.context_digest]
    if args.root_turn_result_path and all(correlation):
        ready = {
            "protocol_version": "1", "turn_id": args.turn_id,
            "root_issue_id": args.root_issue_id,
            "performer_profile_id": args.performer_profile_id,
            "performer_id": args.performer_id, "context_digest": args.context_digest,
        }
        print(json.dumps(root_turn_event(ready, args.event_sequence_start,
                                         {"kind": "protocol_ready"}),
                         separators=(",", ":")), flush=True)
        command = json.loads(sys.stdin.read())
        RootTurnFileHost(RootTurnRuntime(backend).run).run_command(
            command, args.root_turn_result_path, args.event_sequence_start + 1
        )
        return
    parser.error("a V3 conversation or Root Turn command is required")


if __name__ == "__main__":
    main()
