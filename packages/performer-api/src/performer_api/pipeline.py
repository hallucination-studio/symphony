from __future__ import annotations

from dataclasses import replace

from .pipeline_config import RuntimeConfigEnvelope, RuntimeProfile, SchedulerCapacity, SchedulerPolicy
from .pipeline_enums import (
    AttemptState,
    GateStep,
    GateStepSource,
    GraphNodeState,
    HumanEscalationReason,
    PASS_THRESHOLD,
    PlanValidatorError,
    RUNTIME_BACKENDS_BY_MODE,
    RUBRIC_SCORES,
    SECRET_SETTING_KEYS,
    RuntimeMode,
)
from .pipeline_graph import (
    AttemptRecord,
    AttemptSummary,
    ExecuteAttemptRequest,
    ExecuteAttemptResult,
    FencedAttemptResult,
    GateSpecContent,
    GateSpecSnapshot,
    GraphNode,
    TaskOutputManifest,
    VerificationInputSnapshot,
    VerifyAttemptRequest,
    VerifyAttemptResult,
    WorkerLease,
    canonical_gate_hash,
)
from .pipeline_plan import (
    IntentSpec,
    PlanAttemptRequest,
    PlanAttemptResult,
    PlanProposal,
    PlanRepair,
    PlanValidator,
)
from .pipeline_utils import sanitize_profile_settings
from .pipeline_views import PipelineModeView, PipelineView, PredictedCall

__all__ = [
    "AttemptRecord",
    "AttemptState",
    "AttemptSummary",
    "ExecuteAttemptRequest",
    "ExecuteAttemptResult",
    "FencedAttemptResult",
    "GateSpecContent",
    "GateSpecSnapshot",
    "GateStep",
    "GateStepSource",
    "GraphNode",
    "GraphNodeState",
    "HumanEscalationReason",
    "IntentSpec",
    "PASS_THRESHOLD",
    "PlanAttemptRequest",
    "PlanAttemptResult",
    "PlanProposal",
    "PlanRepair",
    "PlanValidator",
    "PlanValidatorError",
    "PipelineModeView",
    "PipelineView",
    "PredictedCall",
    "RUNTIME_BACKENDS_BY_MODE",
    "RUBRIC_SCORES",
    "RuntimeConfigEnvelope",
    "RuntimeMode",
    "RuntimeProfile",
    "SECRET_SETTING_KEYS",
    "SchedulerCapacity",
    "SchedulerPolicy",
    "TaskOutputManifest",
    "VerificationInputSnapshot",
    "VerifyAttemptRequest",
    "VerifyAttemptResult",
    "WorkerLease",
    "canonical_gate_hash",
    "replace",
    "sanitize_profile_settings",
]

for _name in __all__:
    if _name == "replace":
        continue
    _symbol = globals()[_name]
    if hasattr(_symbol, "__module__"):
        try:
            _symbol.__module__ = __name__
        except (AttributeError, TypeError):
            pass

del _name, _symbol
