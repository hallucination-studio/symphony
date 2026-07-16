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
        self, request_path: Path, result_path: Path, event_path: Path | None = None
    ) -> dict[str, Any]:
        command = json.loads(request_path.read_text(encoding="utf-8"))
        self._append_event(event_path, turn_event(command, 0, {"kind": "turn_started"}))
        result = self._run_turn(command)
        if result.get("usage") is not None:
            self._append_event(
                event_path,
                turn_event(
                    command,
                    1,
                    {"kind": "usage_updated", "usage": result["usage"]},
                ),
            )
        temporary = result_path.with_suffix(result_path.suffix + ".tmp")
        temporary.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
        os.replace(temporary, result_path)
        return result

    @staticmethod
    def _append_event(path: Path | None, event: dict[str, Any]) -> None:
        if path is None:
            return
        try:
            with path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(event, separators=(",", ":")) + "\n")
        except OSError:
            pass
