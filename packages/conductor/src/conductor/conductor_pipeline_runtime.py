from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
from dataclasses import dataclass
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



from .runtime_backends import prepare_backend_environment

def prepare_mode_environment(
    instance_state_root: Path,
    profile: RuntimeProfile | None,
    *,
    workspace_path: Path | str | None = None,
    home_scope: str | None = None,
) -> dict[str, str]:
    return prepare_backend_environment(instance_state_root, profile, workspace_path=workspace_path, home_scope=home_scope)


def _runtime_profile_preflight_error(mode: RuntimeMode, profile: RuntimeProfile | None) -> str | None:
    if profile is None:
        return None
    if profile.mode is not mode:
        return f"runtime profile mode mismatch for {mode.value}: {profile.mode.value}"
    if profile.backend not in RUNTIME_BACKENDS_BY_MODE.get(mode, set()):
        return f"unsupported runtime backend for {mode.value}: {profile.backend}"
    return None


def _runtime_kind_for_mode(envelope: RuntimeConfigEnvelope, mode: RuntimeMode) -> str | None:
    profile = envelope.profiles.get(mode)
    if profile is None:
        return None
    return str(profile.backend or "").strip() or None


def materialize_planner_workspace(attempt_dir: Path, resolved_repo_path: str | Path | None) -> Path:
    workspace = attempt_dir / "planner-workspace"
    if workspace.exists():
        if workspace.is_dir():
            shutil.rmtree(workspace)
        else:
            workspace.unlink()
    attempt_dir.mkdir(parents=True, exist_ok=True)
    source = Path(resolved_repo_path).expanduser() if resolved_repo_path else None
    if source is not None and source.is_dir() and source.resolve(strict=False) not in workspace.resolve(strict=False).parents:
        shutil.copytree(source, workspace)
    else:
        workspace.mkdir(parents=True, exist_ok=True)
    return workspace


def _attempt_workspace_for_mode(mode: RuntimeMode, request: dict[str, Any]) -> Path | None:
    if mode is RuntimeMode.PLAN:
        workspace_path = request.get("workspace_path")
        return Path(str(workspace_path)) if workspace_path else None
    artifact_paths = request.get("artifact_paths")
    if isinstance(artifact_paths, dict):
        attempt_dir = artifact_paths.get("attempt_dir")
        if attempt_dir:
            return Path(str(attempt_dir)) / ("workspace" if mode is RuntimeMode.EXECUTE else "")
    return None
