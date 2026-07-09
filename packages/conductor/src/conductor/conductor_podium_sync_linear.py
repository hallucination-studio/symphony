from __future__ import annotations

from typing import Any

from .conductor_pipeline import PipelineLinearProjector, _sanitize_error
from .conductor_podium_sync_report import _linear_issue_completed
from .conductor_service_helpers import _linear_agent_app_user_id, _safe_linear_value, _safe_multiline_linear_value


class PodiumLinearReconcileMixin:
    async def reconcile_linear_pipeline_projections_once(self) -> int:
        revision = self.pipeline_store.current_graph_revision_record()
        if revision is None:
            return 0
        root_issue_id = revision.root_node_id
        try:
            root_node = self.pipeline_store.get_node(revision.root_node_id)
            root_issue_id = str(root_node.issue_id or root_node.node_id)
        except KeyError:
            root_issue_id = revision.root_node_id
        if not root_issue_id:
            return 0
        projected = 0
        for instance in self.store.list_instances():
            try:
                tracker = self.repository_handoff_tracker_factory(instance)
                projector = PipelineLinearProjector(
                    store=self.pipeline_store,
                    tracker=tracker,
                    root_issue_id=root_issue_id,
                    delegate_id=_linear_agent_app_user_id(instance.linear_filters) or None,
                )
                projected += await projector.reconcile_once()
            except Exception as exc:
                error = _sanitize_error(exc)
                self.pipeline_store.record_linear_projection_failure(
                    error,
                    revision=revision.revision,
                )
                self._record_pipeline_sync_failure(
                    "linear_pipeline_projection_failed",
                    instance,
                    exc,
                    action_required="retry_projection",
                )
                try:
                    tracker = self.repository_handoff_tracker_factory(instance)
                    projector = PipelineLinearProjector(
                        store=self.pipeline_store,
                        tracker=tracker,
                        root_issue_id=root_issue_id,
                        delegate_id=_linear_agent_app_user_id(instance.linear_filters) or None,
                    )
                    projected += await projector._project_root_status_comment(revision)
                except Exception as status_exc:
                    self._record_pipeline_sync_failure(
                        "linear_pipeline_projection_health_failed",
                        instance,
                        status_exc,
                        action_required="retry_projection",
                    )
                continue
        return projected

    async def ingest_linear_pipeline_changes_once(self) -> int:
        root_issue_id = self._pipeline_root_issue_id()
        if not root_issue_id:
            return 0
        ingested = 0
        for instance in self.store.list_instances():
            try:
                tracker = self.repository_handoff_tracker_factory(instance)
                projector = PipelineLinearProjector(
                    store=self.pipeline_store,
                    tracker=tracker,
                    root_issue_id=root_issue_id,
                    delegate_id=_linear_agent_app_user_id(instance.linear_filters) or None,
                )
                ingested += await projector.ingest_human_linear_changes_once()
                break
            except Exception as exc:
                self._record_pipeline_sync_failure(
                    "linear_pipeline_ingestion_failed",
                    instance,
                    exc,
                    action_required="retry_ingestion",
                )
                continue
        return ingested

    async def reconcile_pipeline_human_actions_once(self) -> int:
        return 0

    async def reconcile_pipeline_runtime_wait_actions_once(self) -> int:
        return 0

    async def reconcile_completed_pipeline_human_actions_once(self) -> int:
        waits: list[tuple[str, dict[str, Any]]] = [
            ("human", wait)
            for wait in self.pipeline_store.list_human_waits()
            if wait.get("status") == "waiting" and str(wait.get("child_issue_id") or "").strip()
        ]
        waits.extend(
            ("runtime", wait)
            for wait in self.pipeline_store.list_runtime_waits(status="waiting")
            if str(wait.get("child_issue_id") or "").strip()
        )
        if not waits:
            return 0
        root_issue_id = self._pipeline_root_issue_id()
        if not root_issue_id:
            return 0
        waits_by_child = {str(wait.get("child_issue_id") or ""): (kind, wait) for kind, wait in waits}
        completed = 0
        for instance in self.store.list_instances():
            try:
                tracker = self.repository_handoff_tracker_factory(instance)
                children = await tracker.fetch_child_issues(root_issue_id, label_name="performer:type/human-action")
                returned_child_ids: set[str] = set()
                for child in children:
                    child_id = str(child.get("id") or "").strip()
                    if child_id:
                        returned_child_ids.add(child_id)
                    wait_entry = waits_by_child.get(child_id)
                    if wait_entry is None:
                        continue
                    wait_kind, wait = wait_entry
                    if not _linear_issue_completed(child):
                        self._record_pipeline_sync_failure(
                            "pipeline_human_wait_unresolved",
                            instance,
                            RuntimeError("human action child is not completed"),
                            action_required="complete_human_action_child",
                            extra={
                                "wait_id": wait.get("wait_id"),
                                "node_id": wait.get("node_id"),
                                "child_issue_id": child_id,
                                "reason": wait.get("reason"),
                            },
                        )
                        continue
                    resolution = f"Linear human action {child_id} completed."
                    if wait_kind == "runtime":
                        self.pipeline_store.resolve_runtime_wait(str(wait["wait_id"]), resolution=resolution)
                    else:
                        self.pipeline_store.resume_human_wait(str(wait["wait_id"]), resolution=resolution)
                    completed += 1
                for child_id, (_, wait) in waits_by_child.items():
                    if child_id in returned_child_ids:
                        continue
                    self._record_pipeline_sync_failure(
                        "pipeline_human_wait_unresolved",
                        instance,
                        RuntimeError("human action child was not returned by Linear"),
                        action_required="recreate_or_complete_human_action_child",
                        extra={
                            "wait_id": wait.get("wait_id"),
                            "node_id": wait.get("node_id"),
                            "child_issue_id": child_id,
                            "reason": wait.get("reason"),
                        },
                    )
                break
            except Exception as exc:
                self._record_pipeline_sync_failure(
                    "pipeline_human_wait_completion_reconcile_failed",
                    instance,
                    exc,
                    action_required="retry_human_wait_completion_reconcile",
                )
                continue
        return completed

    def _pipeline_root_issue_id(self) -> str:
        revision = self.pipeline_store.current_graph_revision_record()
        if revision is None:
            return ""
        try:
            root_node = self.pipeline_store.get_node(revision.root_node_id)
        except KeyError:
            return revision.root_node_id
        return str(root_node.issue_id or root_node.node_id)

    def _pipeline_human_action_description(self, wait: dict[str, Any]) -> str:
        details = wait.get("details") if isinstance(wait.get("details"), dict) else {}
        lines = [
            "Pipeline human action required.",
            "",
            "```yaml",
            "symphony_human_wait:",
            f"  wait_id: {wait.get('wait_id') or ''}",
            f"  node_id: {wait.get('node_id') or ''}",
            f"  reason: {wait.get('reason') or ''}",
            f"  integration_id: {details.get('integration_id') or ''}",
            f"  verify_attempt_id: {details.get('verify_attempt_id') or ''}",
            f"  status: {details.get('status') or ''}",
            "```",
        ]
        error = str(details.get("error") or "").strip()
        if error:
            lines.extend(["", "Sanitized error:", error])
        return "\n".join(lines)

    def _pipeline_runtime_wait_action_description(self, wait: dict[str, Any]) -> str:
        lines = [
            "Pipeline runtime wait requires operator attention.",
            "",
            "```yaml",
            "symphony_runtime_wait:",
            f"  wait_id: {wait.get('wait_id') or ''}",
            f"  node_id: {wait.get('node_id') or ''}",
            f"  mode: {wait.get('mode') or ''}",
            f"  attempt_id: {wait.get('attempt_id') or ''}",
            f"  lease_id: {wait.get('lease_id') or ''}",
            f"  wait_kind: {wait.get('wait_kind') or ''}",
            f"  status: {wait.get('status') or ''}",
            "```",
        ]
        message = str(wait.get("message") or "").strip()
        if message:
            lines.extend(["", "Sanitized message:", _safe_multiline_linear_value(message)])
        command = str(wait.get("command") or "").strip()
        if command:
            lines.extend(["", "Sanitized command:", _safe_multiline_linear_value(command)])
        log_path = str(wait.get("log_path") or "").strip()
        if log_path:
            lines.extend(["", f"Log path: `{_safe_linear_value(log_path)}`"])
        lines.extend(
            [
                "",
                "Human response:",
                "(Record the approval, answer, or operator action here.)",
                "",
                "When finished, move this child issue to Done.",
            ]
        )
        return "\n".join(lines)
