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



from .conductor_pipeline_helpers import _DISPATCHABLE_STATES, _mode_for_state, _node_verify_passed
from .conductor_pipeline_store import ConductorPipelineStore

class PipelineScheduler:
    def __init__(self, store: ConductorPipelineStore):
        self.store = store

    def is_dependency_satisfied(self, node_id: str) -> bool:
        node = self.store.get_node(node_id)
        return self._node_ready_for_downstream(node)

    def _node_ready_for_downstream(self, node: GraphNode) -> bool:
        if node.state is GraphNodeState.SUPERSEDED:
            return True
        return _node_verify_passed(node) and self.store.verified_branch_manifest_for_node(node.node_id) is not None

    def dispatchable_nodes(self, mode: RuntimeMode) -> list[str]:
        nodes = self.store.list_nodes()
        dispatchable: list[str] = []
        for node in nodes:
            if node.state not in _DISPATCHABLE_STATES:
                continue
            if _mode_for_state(node.state) is not mode:
                continue
            if self.store.active_lease(node.node_id, mode) is not None:
                continue
            if mode is RuntimeMode.VERIFY and not self.store.has_verification_input_for_node(node.node_id):
                continue
            if all(self.is_dependency_satisfied(blocker_id) for blocker_id in self.store.blockers_for(node.node_id)):
                dispatchable.append(node.node_id)
        return dispatchable

    def promote_ready_nodes(self) -> list[str]:
        promoted: list[str] = []
        for node in self.store.list_nodes():
            if node.state is not GraphNodeState.PLANNED:
                continue
            if all(self.is_dependency_satisfied(blocker_id) for blocker_id in self.store.blockers_for(node.node_id)):
                self.store.update_node_state(node.node_id, GraphNodeState.READY)
                promoted.append(node.node_id)
        return promoted

    def find_stuck_nodes(self) -> list[str]:
        terminal_states = {
            GraphNodeState.VERIFY_PASSED,
            GraphNodeState.FAILED,
            GraphNodeState.SUPERSEDED,
            GraphNodeState.NEED_HUMAN,
        }
        active_lease_node_ids = {lease.node_id for lease in self.store.list_active_leases()}
        open_human_wait_node_ids = {
            str(wait.get("node_id") or "")
            for wait in self.store.list_human_waits()
            if str(wait.get("status") or "waiting") == "waiting"
        }
        open_runtime_wait_node_ids = {
            str(wait.get("node_id") or "")
            for wait in self.store.list_runtime_waits(status="waiting")
        }
        dispatchable_node_ids = {
            node_id
            for mode in RuntimeMode
            for node_id in self.dispatchable_nodes(mode)
        }
        stuck: list[str] = []
        for node in self.store.list_nodes():
            if node.state in terminal_states:
                continue
            if node.node_id in active_lease_node_ids:
                continue
            if node.node_id in open_human_wait_node_ids or node.node_id in open_runtime_wait_node_ids:
                continue
            if node.node_id in dispatchable_node_ids:
                continue
            blocker_ids = self.store.blockers_for(node.node_id)
            if node.state is GraphNodeState.PLANNED:
                if all(self.is_dependency_satisfied(blocker_id) for blocker_id in blocker_ids):
                    continue
                if any(self.store.get_node(blocker_id).state not in terminal_states for blocker_id in blocker_ids):
                    continue
            stuck.append(node.node_id)
        return stuck
