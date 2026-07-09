from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from performer_api.pipeline import (
    AttemptRecord,
    AttemptState,
    ExecuteAttemptResult,
    ExecuteAttemptRequest,
    PASS_THRESHOLD,
    GateSpecContent,
    GateSpecSnapshot,
    GateStep,
    GateStepSource,
    GraphNode,
    GraphNodeState,
    HumanEscalationReason,
    PlanAttemptRequest,
    PlanAttemptResult,
    PipelineModeView,
    PipelineView,
    IntentSpec,
    PlanProposal,
    PlanRepair,
    PlanValidator,
    PlanValidatorError,
    PredictedCall,
    RUNTIME_BACKENDS_BY_MODE,
    RuntimeConfigEnvelope,
    RuntimeMode,
    RuntimeProfile,
    SchedulerCapacity,
    SchedulerPolicy,
    TaskOutputManifest,
    VerificationInputSnapshot,
    VerifyAttemptResult,
    VerifyAttemptRequest,
    WorkerLease,
)

from .runtime_backends import prepare_backend_environment
from .conductor_pipeline_helpers import (
    _DISPATCHABLE_STATES,
    _PREDICTABLE_DISPATCH_STATES,
    _format_time,
    _git,
    _json_dumps,
    _json_loads,
    _jsonable,
    _mode_for_state,
    _node_from_topology_and_runtime,
    _node_next_action,
    _node_runtime_payload,
    _node_topology_payload,
    _node_verify_passed,
    _now,
    _plan_failure_human_reason,
    _plan_validation_error_summary,
    _plan_validation_human_reason,
    _queued_mode_for_state,
    _repository_integration_path,
    _resume_state_for_human_wait,
    _retry_state_for_attempt_mode,
    _rollback_repository,
    _safe_path_part,
    _sanitize_error,
    _utc,
)
from .conductor_pipeline_logs import (
    _append_pipeline_log_event,
    _normalize_runtime_wait_kind,
    _visible_attempt_error,
)
from .conductor_pipeline_store_types import GraphRevision

_UNCHANGED = object()
_PROCESS_EXIT_RESULT_GRACE_SECONDS = 15.0

__all__ = [name for name in globals() if not name.startswith("__")]
