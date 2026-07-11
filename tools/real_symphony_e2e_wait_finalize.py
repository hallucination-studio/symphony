from __future__ import annotations

from typing import Any

from real_symphony_e2e_analysis import write_wait_artifacts


def write_wait_state_artifacts(state: Any) -> dict[str, Any]:
    return write_wait_artifacts(
        evidence=state.evidence,
        samples=state.samples,
        result_path=state.result_path,
        final_issue=state.final_issue or {},
        log_path=state.log_path,
        stages=state.stages,
        stage_timeout_seconds=state.stage_timeout_seconds,
    )


__all__ = ["write_wait_state_artifacts"]
