from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any
import shutil
import subprocess

from .conductor_models import (
    ConductorSettings,
    InstanceCreateRequest,
    InstancePatchRequest,
    InstanceRecord,
)
from .conductor_runtime import ConductorRuntimeManager
from .conductor_runtime import LogQuery
from .conductor_store import ConductorStore
from .gate import AcceptanceGate
from .runtime import PerformerRuntime
from .conductor_smoke_store import ConductorSmokeCheckStore
from .conductor_podium_sync import ConductorPodiumSyncMixin
from .conductor_service_views import ConductorServiceViewsMixin
from .conductor_service_helpers import (
    _desired_project_labels,
    _linear_agent_app_user_id,
    _merge_project_labels,
)
from .conductor_service_types import ConductorServiceError, CoordinationCadence, CoordinationResult
from .conductor_linear_direct import ManagedRunLinearProxy, ProjectLabelLinearProxy
from .store import ConductorStore as WorkflowStore
from .workflow import Workflow

class ConductorService(ConductorPodiumSyncMixin, ConductorServiceViewsMixin):
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
        self.workflow_store = WorkflowStore(data_root / "workflow.db")
        self.workflow = Workflow(self.workflow_store)
        self.performer_runtime = PerformerRuntime()
        self.acceptance_gate = AcceptanceGate()
        self.smoke_check_store = ConductorSmokeCheckStore(store)
        self._smoke_check_lock = asyncio.Lock()
        self._startup_locks: dict[str, asyncio.Lock] = {}
        self.managed_run_tracker_factory = self._managed_run_tracker
        self.project_label_proxy_factory = self._project_label_proxy
        self.coordination_cadence = CoordinationCadence()
        # instance_id -> last-synced desired-label signature, so the background
        # loop only calls Linear when an instance's scope actually changes.
        self._project_label_signatures: dict[str, str] = {}
        self.data_root.mkdir(parents=True, exist_ok=True)

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

    async def get_instance_coordinated(self, instance_id: str) -> InstanceRecord | None:
        return self.get_instance(instance_id)

    def _managed_run_tracker(self, instance: InstanceRecord) -> Any:
        settings = self.store.get_settings()
        endpoint_base = settings.podium_url.strip().rstrip("/")
        endpoint = f"{endpoint_base}/api/v1/linear/graphql" if endpoint_base else "https://api.linear.app/graphql"
        api_key = settings.podium_proxy_token.strip()
        return ManagedRunLinearProxy(
            endpoint=endpoint,
            api_key=api_key,
            project_slug=instance.linear_project,
            required_delegate_id=_linear_agent_app_user_id(instance.linear_filters) or None,
        )

    def _project_label_proxy(self, instance: InstanceRecord) -> Any:
        settings = self.store.get_settings()
        endpoint_base = settings.podium_url.strip().rstrip("/") or "https://podium.example"
        return ProjectLabelLinearProxy(
            endpoint=f"{endpoint_base}/api/v1/linear/graphql",
            api_key=settings.podium_proxy_token.strip(),
        )

    async def sync_instance_project_labels(self, instance: InstanceRecord) -> dict[str, Any]:
        settings = self.store.get_settings()
        if not settings.podium_proxy_token.strip():
            return {"status": "skipped", "reason": "proxy_not_configured"}
        project_slug = str(instance.linear_project or "").strip()
        if not project_slug:
            return {"status": "skipped", "reason": "missing_project_slug"}
        proxy = self.project_label_proxy_factory(instance)
        project_id = await proxy.find_project_id(project_slug)
        if not project_id:
            return {"status": "skipped", "reason": "project_not_found", "project_slug": project_slug}
        existing = await proxy.fetch_project_labels(project_id)
        existing_names = [row["name"] for row in existing]
        desired = _merge_project_labels(existing_names, _desired_project_labels(instance))
        if set(desired) == set(existing_names):
            return {"status": "unchanged", "project_id": project_id, "labels": desired}
        label_ids = [await proxy.ensure_project_label_id(name) for name in desired]
        await proxy.set_project_labels(project_id, label_ids)
        return {"status": "synced", "project_id": project_id, "labels": desired}
