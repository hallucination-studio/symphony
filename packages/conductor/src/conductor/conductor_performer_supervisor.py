from __future__ import annotations

import inspect
import json
from pathlib import Path
from typing import Any, Callable

from performer_api.phase import PhaseAdvanceResult, RunPhase

from .conductor_phase import PhaseTransitionError


class PerformerSupervisor:
    def __init__(
        self,
        *,
        store: Any,
        phase_reducer: Any,
        comment_result_diagnostic: Callable[[str, PhaseAdvanceResult], Any],
    ):
        self.store = store
        self.phase_reducer = phase_reducer
        self.comment_result_diagnostic = comment_result_diagnostic

    async def apply_result_files(self) -> int:
        applied = 0
        runs = self.store.list_orchestration_runs(phases={RunPhase.IMPLEMENTING, RunPhase.REVIEWING, RunPhase.REWORKING})
        for run in runs:
            if not run.result_path:
                continue
            path = Path(run.result_path)
            if not path.exists():
                continue
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(payload, dict):
                continue
            try:
                result = PhaseAdvanceResult.from_dict(payload)
                self.phase_reducer.performer_result(result)
            except PhaseTransitionError:
                continue
            diagnostic = self.comment_result_diagnostic(run.run_id, result)
            if inspect.isawaitable(diagnostic):
                await diagnostic
            path.unlink(missing_ok=True)
            applied += 1
        return applied
