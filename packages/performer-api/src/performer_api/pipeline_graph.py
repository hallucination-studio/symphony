from __future__ import annotations

from .pipeline_graph_artifacts import TaskOutputManifest, VerificationInputSnapshot, WorkerLease
from .pipeline_graph_attempts import (
    AttemptRecord,
    AttemptSummary,
    ExecuteAttemptRequest,
    ExecuteAttemptResult,
    FencedAttemptResult,
    VerifyAttemptRequest,
    VerifyAttemptResult,
)
from .pipeline_graph_gates import GateSpecContent, GateSpecSnapshot, canonical_gate_hash
from .pipeline_graph_nodes import GraphNode

__all__ = [
    "AttemptRecord",
    "AttemptSummary",
    "ExecuteAttemptRequest",
    "ExecuteAttemptResult",
    "FencedAttemptResult",
    "GateSpecContent",
    "GateSpecSnapshot",
    "GraphNode",
    "TaskOutputManifest",
    "VerificationInputSnapshot",
    "VerifyAttemptRequest",
    "VerifyAttemptResult",
    "WorkerLease",
    "canonical_gate_hash",
]

for _name in __all__:
    _symbol = globals()[_name]
    if hasattr(_symbol, "__module__"):
        try:
            _symbol.__module__ = __name__
        except (AttributeError, TypeError):
            pass

del _name, _symbol
