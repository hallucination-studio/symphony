from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Callable

from performer.events.event_mapper import root_turn_event
from performer.turn_protocol.contract_adapter import validate


class RootTurnFileHost:
    def __init__(self, run_turn: Callable[[dict[str, Any]], dict[str, Any]]) -> None:
        self._run_turn = run_turn

    def run(
        self,
        request_path: Path,
        result_path: Path,
        event_sequence_start: int = 0,
    ) -> dict[str, Any]:
        command = validate(
            "RootTurnCommand",
            json.loads(request_path.read_text(encoding="utf-8")),
        )
        self._emit(
            root_turn_event(command, event_sequence_start, {"kind": "turn_started"})
        )
        result = validate("RootTurnResult", self._run_turn(command))
        temporary = result_path.with_suffix(result_path.suffix + ".tmp")
        temporary.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
        os.replace(temporary, result_path)
        if result["result_kind"] in {
            "root_turn_failed",
            "root_conversation_unavailable",
        }:
            body = {
                "kind": "error",
                "code": result["error_code"],
                "sanitized_summary": result["sanitized_reason"],
            }
        elif result["result_kind"] == "root_turn_canceled":
            body = {
                "kind": "warning",
                "code": "root_turn_canceled",
                "sanitized_summary": result["sanitized_reason"],
            }
        else:
            body = {"kind": "turn_completed"}
        self._emit(root_turn_event(command, event_sequence_start + 1, body))
        return result

    @staticmethod
    def _emit(event: dict[str, Any]) -> None:
        try:
            print(json.dumps(event, separators=(",", ":")), flush=True)
        except (OSError, ValueError):
            pass
