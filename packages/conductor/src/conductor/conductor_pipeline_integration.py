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



from .conductor_pipeline_helpers import _git, _repository_head_revision, _safe_path_part, _sanitize_error
from .conductor_pipeline_store import ConductorPipelineStore

class _MergeConflictError(RuntimeError):
    pass


def _prepare_execute_worktree(
    *,
    repository_path: Path,
    node_id: str,
    attempt_dir: Path,
    base_revision: str,
    upstream_manifests: list[TaskOutputManifest],
) -> dict[str, Path | str]:
    if not base_revision:
        raise ValueError("repository base revision unavailable")
    branch_name = f"symphony/{_safe_path_part(node_id)}"
    workspace_path = attempt_dir / "workspace"
    if workspace_path.exists():
        subprocess.run(
            ["git", "worktree", "remove", "--force", str(workspace_path)],
            cwd=repository_path,
            check=False,
            capture_output=True,
            text=True,
        )
        shutil.rmtree(workspace_path, ignore_errors=True)
    workspace_path.parent.mkdir(parents=True, exist_ok=True)
    _git(["worktree", "add", "--force", "-B", branch_name, str(workspace_path), base_revision], cwd=repository_path)
    for manifest in upstream_manifests:
        merge_ref = str(manifest.code.get("branch_name") or manifest.code.get("commit_sha") or "").strip()
        if not merge_ref:
            raise ValueError(f"blocker {manifest.node_id} lacks branch output")
        try:
            _git(["merge", "--no-ff", "--no-edit", merge_ref], cwd=workspace_path)
        except subprocess.CalledProcessError as exc:
            raise _MergeConflictError(_sanitize_error(exc.output or exc)) from exc
    return {"workspace_path": workspace_path, "branch_name": branch_name}


def deliver_completed_graph_with_gh(
    store: ConductorPipelineStore,
    *,
    repository_path: Path,
    issue_identifier: str,
    run_command: Any = subprocess.run,
) -> dict[str, Any]:
    revision = store.current_graph_revision_record()
    branch_source = issue_identifier or (revision.root_node_id if revision else "issue")
    branch_name = f"symphony/{_safe_path_part(branch_source)}"
    nodes = store.list_nodes()
    if not nodes or any(node.state not in {GraphNodeState.VERIFY_PASSED, GraphNodeState.SUPERSEDED} for node in nodes):
        result = {"status": "not_ready"}
        store.record_graph_delivery(
            status="not_ready",
            branch_name=branch_name,
            repository_path=str(repository_path),
            details={"reason": "nodes_not_terminal"},
        )
        return result
    exit_node_ids = _exit_node_ids_for_current_graph(store)
    if not exit_node_ids:
        result = {"status": "not_ready", "reason": "no_exit_nodes"}
        store.record_graph_delivery(
            status="not_ready",
            branch_name=branch_name,
            repository_path=str(repository_path),
            details={"reason": "no_exit_nodes"},
        )
        return result
    try:
        base_revision = _repository_head_revision(str(repository_path))
        if not base_revision:
            raise RuntimeError("repository base revision unavailable")
        worktree_path = store.artifact_root / "delivery-worktrees" / _safe_path_part(branch_name)
        if worktree_path.exists():
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(worktree_path)],
                cwd=repository_path,
                check=False,
                capture_output=True,
                text=True,
            )
            shutil.rmtree(worktree_path, ignore_errors=True)
        worktree_path.parent.mkdir(parents=True, exist_ok=True)
        _git(["worktree", "add", "--force", "-B", branch_name, str(worktree_path), base_revision], cwd=repository_path)
        for node_id in exit_node_ids:
            manifest = store.verified_branch_manifest_for_node(node_id)
            if manifest is None:
                raise RuntimeError(f"exit node {node_id} lacks verified branch output")
            merge_ref = str(manifest.code.get("branch_name") or manifest.code.get("commit_sha") or "").strip()
            if not merge_ref:
                raise RuntimeError(f"exit node {node_id} lacks merge ref")
            _git(["merge", "--no-ff", "--no-edit", merge_ref], cwd=worktree_path)
        _git(["push", "origin", branch_name], cwd=worktree_path)
        pr = run_command(
            ["gh", "pr", "create", "--fill", "--head", branch_name],
            cwd=worktree_path,
            check=True,
            capture_output=True,
            text=True,
        )
    except Exception as exc:
        error = _sanitize_error(exc)
        store.record_graph_delivery(
            status="failed",
            branch_name=branch_name,
            repository_path=str(repository_path),
            error=error,
            details={"exit_node_ids": exit_node_ids},
        )
        raise
    result = {
        "status": "delivered",
        "branch_name": branch_name,
        "worktree_path": str(worktree_path),
        "pr_url": str(getattr(pr, "stdout", "") or "").strip(),
    }
    store.record_graph_delivery(
        status="delivered",
        branch_name=branch_name,
        pr_url=result["pr_url"],
        repository_path=str(repository_path),
        details={"exit_node_ids": exit_node_ids, "worktree_path": str(worktree_path)},
    )
    return result


def _exit_node_ids_for_current_graph(store: ConductorPipelineStore) -> list[str]:
    nodes = store.list_nodes()
    source_ids = {source for source, _target in store.current_blocks()}
    return sorted(node.node_id for node in nodes if node.node_id not in source_ids and node.state is not GraphNodeState.SUPERSEDED)
