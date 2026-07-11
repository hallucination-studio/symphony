from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .conductor_managed_run_projection import ManagedRunLinearProjector
from .conductor_service_helpers import _linear_agent_app_user_id


class PodiumLinearReconcileMixin:
    async def reconcile_linear_managed_run_projections_once(self) -> int:
        projected = 0
        for run in self.managed_run_store.list_runs():
            root_issue_id = str(run.get("parent_issue_id") or "")
            if not root_issue_id:
                continue
            for instance in self.store.list_instances():
                try:
                    tracker = self.managed_run_tracker_factory(instance)
                    projector = ManagedRunLinearProjector(
                        store=self.managed_run_store,
                        tracker=tracker,
                        root_issue_id=root_issue_id,
                        delegate_id=_linear_agent_app_user_id(instance.linear_filters) or None,
                    )
                    run_id = str(run["run_id"])
                    projected += await projector.reconcile_once(run_id)
                    self.managed_run_store.merge_run_payload(
                        run_id,
                        {
                            "projection_healthy": True,
                            "last_projection_error": None,
                            "last_successful_projection_at": _now(),
                        },
                    )
                    await projector.project_parent_summary_once(run_id)
                    break
                except Exception as exc:
                    finding = self._record_managed_run_sync_failure(
                        "linear_managed_run_projection_failed",
                        instance,
                        exc,
                        action_required="retry_projection",
                    )
                    self.managed_run_store.merge_run_payload(
                        str(run["run_id"]),
                        {
                            "projection_healthy": False,
                            "last_projection_error": finding,
                            "last_projection_failed_at": _now(),
                        },
                    )
                    continue
        return projected


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
