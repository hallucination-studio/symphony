from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PipelineDispatchAccepted:
    node_id: str
    graph_id: str
    plan_attempt_id: str
