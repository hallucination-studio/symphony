from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class GraphRevision:
    graph_id: str
    revision: int
    plan_attempt_id: str
    root_node_id: str
