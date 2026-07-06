from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any
import shutil
import subprocess
import socket
from datetime import datetime, timedelta, timezone
import httpx

from .conductor_models import (
    ConductorSettings,
    InstanceCreateRequest,
    InstancePatchRequest,
    InstanceRecord,
    WorkflowValidationResult,
)
from .conductor_runtime import ConductorRuntimeManager
from .conductor_runtime import LogQuery
from .conductor_scheduler import OrchestrationScheduler, phase_file_paths
from .conductor_store import ConductorStore
from .conductor_crash_recovery import normalize_stale_runtime_state
from .conductor_podium_sync import ConductorPodiumSyncMixin
from .conductor_phase_ops import ConductorPhaseOpsMixin
from .conductor_service_views import ConductorServiceViewsMixin
from .conductor_service_types import ConductorServiceError, CoordinationCadence, CoordinationResult
from .conductor_ingress import DirectIngress
from .conductor_linear_direct import ProjectLabelLinearProxy, RepositoryHandoffLinearProxy
from .conductor_phase import PhaseReducer, PhaseTransitionError
from .conductor_linear_projector import LinearProjector
from .conductor_performer_supervisor import PerformerSupervisor
from .conductor_phase_human_actions import (
    PhaseHumanActionCoordinator,
    comment_missing_phase_human_response,
    find_phase_human_child,
    human_response_from_child,
    linear_issue_is_done,
    phase_human_action_requires_response,
    write_phase_human_response_to_parent,
)
from .conductor_reconcile import reconcile_orchestration_health
from .conductor_remediation import OrchestrationRemediator
from .conductor_repository_handoff import (
    REPOSITORY_HANDOFF_MARKER_NAME,
    REPOSITORY_INTEGRATION_LABEL,
    RepositoryHandoffCoordinator,
    comment_repository_handoff,
    find_repository_integration_child,
    repository_handoff_closeout_event,
    repository_handoff_comment,
    repository_handoff_marker,
    repository_integration_description,
)
from .conductor_workflow import (
    ConductorValidationError,
    generate_workflow_content,
    validate_instance_workflow,
    workflow_profiles,
)
from performer_api.ops_models import OpsSnapshot, TraceEvent
from performer_api.ops_projection import build_issue_detail, build_issue_list, build_run_detail, build_trace_stream
from performer_api.ops_retention import RetentionPolicy
from performer_api.ops_store import OpsStore
from performer_api.phase import PhaseAdvanceResult, RunPhase
from performer_api.persistence import PersistenceStore, PersistedSession, PersistedState
from performer_api.models import normalize_state_key, utc_now
from performer_api.workflow import load_workflow



class ConductorService(ConductorPodiumSyncMixin, ConductorPhaseOpsMixin, ConductorServiceViewsMixin):
    def __init__(
        self,
        *,
        store: ConductorStore,
        data_root: Path,
        runtime_manager: ConductorRuntimeManager | None = None,
    ):
        self.store = store
        self.data_root = data_root
        self.runtime_manager = runtime_manager or ConductorRuntimeManager()
        self._startup_locks: dict[str, asyncio.Lock] = {}
        self.phase_reducer = PhaseReducer(store)
        self.repository_handoff_tracker_factory = self._repository_handoff_tracker
        self.project_label_proxy_factory = self._project_label_proxy
        self.linear_projector = LinearProjector(
            store=self.store,
            get_instance=self.store.get_instance,
            tracker_factory=lambda instance: self.repository_handoff_tracker_factory(instance),
        )
        self.direct_ingress = DirectIngress(
            store=self.store,
            phase_reducer=self.phase_reducer,
            list_instances=self.store.list_instances,
            get_instance=self.get_instance,
            tracker_factory=lambda instance: self.repository_handoff_tracker_factory(instance),
        )
        self.scheduler = OrchestrationScheduler(
            store=self.store,
            phase_reducer=self.phase_reducer,
            runtime_manager=self.runtime_manager,
            runtime_env=self._runtime_env,
            get_instance=self.get_instance,
            codex_profile_for_run=self._codex_profile_for_run,
            start_lock_for_instance=self._startup_lock_for_instance,
        )
        self.performer_supervisor = PerformerSupervisor(
            store=self.store,
            phase_reducer=self.phase_reducer,
            comment_result_diagnostic=self._comment_phase_result_diagnostic,
        )
        self.phase_human_actions = PhaseHumanActionCoordinator(
            store=self.store,
            phase_reducer=self.phase_reducer,
            managed_mode_enabled=self._managed_mode_enabled,
            tracker_factory=lambda instance: self.repository_handoff_tracker_factory(instance),
        )
        self.orchestration_remediator = OrchestrationRemediator(self.store)
        self.coordination_cadence = CoordinationCadence()
        self._podium_connection: dict[str, Any] = {
            "poll": {"status": "idle", "last_error": None, "updated_at": None},
            "ws": {"status": "idle", "last_error": None, "updated_at": None},
        }
        self._podium_dispatch_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        # instance_id -> last-synced desired-label signature, so the background
        # loop only calls Linear when an instance's scope actually changes.
        self._project_label_signatures: dict[str, str] = {}
        self.data_root.mkdir(parents=True, exist_ok=True)
        normalize_stale_runtime_state(
            store=self.store,
            runtime_manager=self.runtime_manager,
            phase_reducer=self.phase_reducer,
        )

    def list_instances(self) -> list[InstanceRecord]:
        return self.store.list_instances()

    def settings(self) -> ConductorSettings:
        return self.store.get_settings()

    def update_settings(self, settings: ConductorSettings) -> ConductorSettings:
        self.store.save_settings(settings)
        return settings

    def update_settings_json(self, payload: dict[str, Any]) -> ConductorSettings:
        merged = self.store.get_settings().to_dict()
        merged.update(payload)
        return self.update_settings(ConductorSettings.from_dict(merged))

