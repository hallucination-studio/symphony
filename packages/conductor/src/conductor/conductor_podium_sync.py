from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import re
from typing import Any

from .conductor_models import InstanceCreateRequest, InstancePatchRequest
from .conductor_podium_sync_dispatch import PodiumDispatchMixin
from .conductor_podium_sync_reporter import PodiumReportMixin
from .conductor_podium_sync_smoke import PodiumSmokeCheckMixin
from .conductor_service_helpers import _desired_project_labels, _optional_int
from .conductor_service_types import ConductorServiceError, CoordinationResult
from .workflow_driver import WorkflowDriver


class ConductorPodiumSyncMixin(
    PodiumDispatchMixin,
    PodiumReportMixin,
    PodiumSmokeCheckMixin,
):
    async def coordinate_background_once(self) -> CoordinationResult:
        self._managed_run_reconcile_findings: list[dict[str, Any]] = []
        managed_run_driver = await WorkflowDriver(self).drive_once()
        project_labels_synced = await self._sync_project_labels_if_due(datetime.now(timezone.utc))
        return CoordinationResult(
            dispatch_acks={"acked": 0, "failed": 0, "skipped": 0},
            project_labels_synced=project_labels_synced,
            managed_run_turns_started=managed_run_driver.get("started", 0),
            managed_run_results_applied=managed_run_driver.get("applied", 0),
            managed_run_integrations_processed=0,
            managed_run_timeouts=0,
            managed_run_crash_retries=0,
            managed_run_crash_failures=0,
            managed_run_human_actions_created=0,
            managed_run_human_actions_completed=0,
            managed_run_human_actions_missing_response=0,
            managed_run_human_actions_failed=0,
            managed_run_runtime_waits_observed=0,
            linear_managed_run_ingestions=0,
            linear_managed_run_projections=0,
            dispatchable=0,
            blocked_waiting=0,
            reconcile_findings=getattr(self, "_managed_run_reconcile_findings", []),
            remediations={},
            crash_restarts=0,
            crash_loops=0,
        )

    async def _sync_project_labels_if_due(self, now: datetime) -> int:
        if not self.coordination_cadence.project_labels_due(now):
            return 0
        self.coordination_cadence.mark_project_labels(now)
        return await self.sync_project_labels_once()

    async def sync_project_labels_once(self) -> int:
        synced = 0
        for instance in self.store.list_instances():
            signature = "\0".join([instance.linear_project, *_desired_project_labels(instance)])
            if self._project_label_signatures.get(instance.id) == signature:
                continue
            try:
                result = await self.sync_instance_project_labels(instance)
            except Exception:
                continue
            if result.get("status") in {"synced", "unchanged"}:
                self._project_label_signatures[instance.id] = signature
            if result.get("status") == "synced":
                synced += 1
        return synced

    async def handle_podium_command(
        self,
        command: dict[str, Any],
        *,
        post_smoke_result: Any | None = None,
    ) -> dict[str, Any]:
        kind = str(command.get("type") or "")
        if kind == "smoke.check":
            return await self.handle_smoke_check(command, post_smoke_result=post_smoke_result)
        if kind == "project.configure":
            return self._handle_project_configure(command)
        if kind == "project.unconfigure":
            return self._handle_project_unconfigure(command)
        if kind == "project.prepare_installation":
            return self._handle_installation_prepare(command)
        if kind == "project.activate_installation":
            return self._handle_installation_activate(command)
        return {"status": "ignored", "reason": "unsupported_command"}

    def _handle_project_configure(self, command: dict[str, Any]) -> dict[str, Any]:
        project_id = str(command.get("linear_project_id") or "")
        version = _optional_int(command.get("config_version"), 0) or 0
        repository = command.get("repository") if isinstance(command.get("repository"), dict) else {}
        mode = str(repository.get("mode") or "")
        value = str(repository.get("value") or "")
        if not project_id or version <= 0 or mode not in {"local_path", "git_url"} or not value:
            return {"status": "rejected", "reason": "invalid_project_config"}
        instances = self.store.list_instances()
        if instances:
            return self._update_project_instance(instances[0], command, project_id, version, mode, value)
        try:
            instance = self.create_instance(
                InstanceCreateRequest(
                    name=str(command.get("project_name") or command.get("project_slug") or project_id),
                    repo_source_type="git" if mode == "git_url" else "local_path",
                    repo_source_value=value,
                    linear_project=str(command.get("project_slug") or ""),
                    linear_filters=_project_filters(command, project_id, version),
                )
            )
        except ConductorServiceError as exc:
            self._record_managed_run_sync_failure(
                "project_config_apply_failed",
                None,
                exc,
                action_required="fix_project_binding",
                extra={"linear_project_id": project_id, "config_version": version},
            )
            return {"status": "rejected", "reason": exc.code}
        return {"status": "applied", "instance_id": instance.id, "config_version": version}

    def _update_project_instance(
        self,
        instance: Any,
        command: dict[str, Any],
        project_id: str,
        version: int,
        mode: str,
        value: str,
    ) -> dict[str, Any]:
        current_project_id = str(instance.linear_filters.get("linear_project_id") or "")
        current_version = _optional_int(instance.linear_filters.get("binding_config_version"), 0) or 0
        if current_project_id != project_id:
            if not current_project_id and instance.linear_filters.get("unbound_binding_id"):
                return self._rebind_project_instance(instance, command, project_id, version, mode, value)
            return {
                "status": "rejected",
                "reason": "conductor_already_bound_to_project",
                "linear_project_id": current_project_id,
            }
        if version < current_version:
            return {"status": "rejected", "reason": "stale_project_config", "current_version": current_version}
        expected_type = "git" if mode == "git_url" else "local_path"
        if instance.repo_source_type != expected_type or instance.repo_source_value != value:
            return {"status": "rejected", "reason": "repository_change_requires_rebind"}
        filters = _project_filters(command, project_id, version)
        if version == current_version and filters == instance.linear_filters:
            return {"status": "already_applied", "instance_id": instance.id, "config_version": version}
        updated = self.update_instance(
            instance.id,
            InstancePatchRequest(
                name=str(command.get("project_name") or instance.name),
                linear_project=str(command.get("project_slug") or instance.linear_project),
                linear_filters=filters,
            ),
        )
        return {"status": "applied", "instance_id": updated.id, "config_version": version}

    def _rebind_project_instance(
        self,
        instance: Any,
        command: dict[str, Any],
        project_id: str,
        version: int,
        mode: str,
        value: str,
    ) -> dict[str, Any]:
        unbound_version = _optional_int(instance.linear_filters.get("unbound_config_version"), 0) or 0
        if version <= unbound_version:
            return {"status": "rejected", "reason": "stale_project_config", "current_version": unbound_version}
        expected_type = "git" if mode == "git_url" else "local_path"
        if instance.repo_source_type != expected_type or instance.repo_source_value != value:
            return {"status": "rejected", "reason": "repository_change_requires_rebind"}
        updated = self.update_instance(
            instance.id,
            InstancePatchRequest(
                name=str(command.get("project_name") or command.get("project_slug") or project_id),
                linear_project=str(command.get("project_slug") or ""),
                linear_filters=_project_filters(command, project_id, version),
            ),
        )
        return {"status": "applied", "instance_id": updated.id, "config_version": version}

    def _handle_project_unconfigure(self, command: dict[str, Any]) -> dict[str, Any]:
        instances = self.store.list_instances()
        if len(instances) != 1:
            return {"status": "rejected", "reason": "project_binding_required"}
        instance = instances[0]
        binding_id = str(command.get("binding_id") or "")
        version = _optional_int(command.get("config_version"), 0) or 0
        filters = dict(instance.linear_filters)
        if (
            binding_id == str(filters.get("unbound_binding_id") or "")
            and version == (_optional_int(filters.get("unbound_config_version"), 0) or 0)
        ):
            return {"status": "already_unbound", "binding_id": binding_id, "config_version": version}
        if binding_id != str(filters.get("binding_id") or ""):
            return {"status": "rejected", "reason": "project_binding_mismatch"}
        current_version = _optional_int(filters.get("binding_config_version"), 0) or 0
        if version <= current_version:
            return {"status": "rejected", "reason": "stale_project_config", "current_version": current_version}
        if instance.process_status in {"running", "starting"}:
            return {"status": "rejected", "reason": "instance_running"}
        self.update_instance(
            instance.id,
            InstancePatchRequest(
                linear_project="",
                linear_filters={"unbound_binding_id": binding_id, "unbound_config_version": version},
            ),
        )
        return {"status": "unbound", "binding_id": binding_id, "config_version": version}

    def _handle_installation_prepare(self, command: dict[str, Any]) -> dict[str, Any]:
        instances = self.store.list_instances()
        if len(instances) != 1:
            return {"status": "rejected", "reason": "project_binding_required"}
        instance = instances[0]
        project_id = str(command.get("linear_project_id") or "")
        installation_id = str(command.get("installation_id") or "")
        app_user_id = str(command.get("agent_app_user_id") or "")
        version = _optional_int(command.get("config_version"), 0) or 0
        current_version = _optional_int(instance.linear_filters.get("binding_config_version"), 0) or 0
        if project_id != str(instance.linear_filters.get("linear_project_id") or ""):
            return {"status": "rejected", "reason": "project_binding_mismatch"}
        if not installation_id or not app_user_id or version <= current_version:
            return {"status": "rejected", "reason": "invalid_installation_candidate"}
        self.update_instance(
            instance.id,
            InstancePatchRequest(
                linear_filters={
                    **instance.linear_filters,
                    "pending_installation_id": installation_id,
                    "pending_agent_app_user_id": app_user_id,
                    "pending_binding_config_version": version,
                }
            ),
        )
        return {"status": "prepared", "installation_id": installation_id, "config_version": version}

    def _handle_installation_activate(self, command: dict[str, Any]) -> dict[str, Any]:
        instances = self.store.list_instances()
        if len(instances) != 1:
            return {"status": "rejected", "reason": "project_binding_required"}
        instance = instances[0]
        installation_id = str(command.get("installation_id") or "")
        version = _optional_int(command.get("config_version"), 0) or 0
        filters = dict(instance.linear_filters)
        if (
            installation_id != str(filters.get("pending_installation_id") or "")
            or version != (_optional_int(filters.get("pending_binding_config_version"), 0) or 0)
        ):
            return {"status": "rejected", "reason": "installation_candidate_not_prepared"}
        filters["agent_app_user_id"] = str(filters.pop("pending_agent_app_user_id", ""))
        filters["binding_config_version"] = int(filters.pop("pending_binding_config_version", 0) or 0)
        filters.pop("pending_installation_id", None)
        self.update_instance(instance.id, InstancePatchRequest(linear_filters=filters))
        return {"status": "activated", "installation_id": installation_id, "config_version": version}

    def _record_managed_run_sync_failure(
        self,
        event: str,
        instance: Any | None,
        exc: Exception,
        *,
        action_required: str,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        reason = _sanitize_error(exc)
        finding: dict[str, Any] = {
            "event": event,
            "severity": "warning",
            "error_type": exc.__class__.__name__,
            "sanitized_reason": reason,
            "action_required": action_required,
            "retryable": True,
        }
        if instance is not None:
            finding["instance_id"] = getattr(instance, "id", "")
            finding["issue_project"] = getattr(instance, "linear_project", "")
        if extra:
            finding.update({key: value for key, value in extra.items() if value is not None})
        findings = getattr(self, "_managed_run_reconcile_findings", None)
        if findings is None:
            findings = []
            self._managed_run_reconcile_findings = findings
        findings.append(finding)
        if instance is not None:
            _append_instance_log(
                instance,
                "event="
                f"{event} severity=warning instance_id={getattr(instance, 'id', '')} "
                f"error_type={exc.__class__.__name__} sanitized_reason={reason} "
                f"action_required={action_required} retryable=true",
            )
        return finding


def _append_instance_log(instance: Any, message: str) -> None:
    log_path = getattr(instance, "log_path", None)
    if not log_path:
        return
    path = Path(str(log_path))
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"{datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')} {message}\n")
    except OSError:
        return


def _sanitize_error(exc: Exception | str) -> str:
    text = str(exc).replace("\x00", "").strip()
    if not text:
        return exc.__class__.__name__ if isinstance(exc, Exception) else "runtime_error"
    text = re.sub(r"(?i)(authorization:\s*)(bearer|basic)\s+[^\s,;]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", text)
    text = re.sub(r"(?i)\b(access_token|refresh_token|api_key|token|password|client_secret|cookie)=([^ \t,;]+)", r"\1=[REDACTED]", text)
    return text[:500]


def _project_filters(command: dict[str, Any], project_id: str, version: int) -> dict[str, Any]:
    return {
        "binding_id": str(command.get("binding_id") or ""),
        "binding_config_version": version,
        "linear_project_id": project_id,
        "agent_app_user_id": str(command.get("agent_app_user_id") or ""),
    }


__all__ = ["ConductorPodiumSyncMixin"]
