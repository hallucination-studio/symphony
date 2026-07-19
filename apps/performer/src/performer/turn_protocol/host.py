from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Callable

from performer.events.event_mapper import turn_event


class TurnFileHost:
    def __init__(self, run_turn: Callable[[dict[str, Any]], dict[str, Any]]) -> None:
        self._run_turn = run_turn

    def run(
        self,
        request_path: Path,
        result_path: Path,
        event_sequence_start: int = 0,
    ) -> dict[str, Any]:
        command = json.loads(request_path.read_text(encoding="utf-8"))
        self._emit_event(
            turn_event(command, event_sequence_start, {"kind": "turn_started"}),
        )
        next_sequence = event_sequence_start + 1
        result = self._run_turn(command)
        if result.get("usage") is not None:
            self._emit_event(
                turn_event(
                    command,
                    next_sequence,
                    {"kind": "usage_updated", "usage": result["usage"]},
                ),
            )
            next_sequence += 1
        temporary = result_path.with_suffix(result_path.suffix + ".tmp")
        temporary.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
        os.replace(temporary, result_path)

        body = result.get("body", {})
        if result.get("result_kind") == "turn_failed":
            self._emit_event(
                turn_event(
                    command,
                    next_sequence,
                    {
                        "kind": "error_raised",
                        "error_code": body.get("error_code", "performer_turn_failed"),
                        "sanitized_summary": body.get(
                            "sanitized_reason", "The Performer Turn failed."
                        ),
                        "retryable": body.get("retryable", False),
                    },
                ),
            )
        elif result.get("result_kind") != "turn_canceled":
            self._emit_event(
                turn_event(
                    command,
                    next_sequence,
                    {
                        "kind": "turn_completed",
                        "result_kind": result["result_kind"],
                        "sanitized_summary": body.get("summary")
                        or body.get("sanitized_prompt")
                        or "The Performer Turn completed.",
                    },
                ),
            )
        return result

    @staticmethod
    def _emit_event(event: dict[str, Any]) -> None:
        payload = json.dumps(event, separators=(",", ":"))
        try:
            print(payload, flush=True)
        except (OSError, ValueError):
            pass
