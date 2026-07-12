from __future__ import annotations

from datetime import datetime, timezone
import logging
import os
from pathlib import Path
import re
from typing import Any

import httpx

from .models import InstanceCreateRequest, InstancePatchRequest
from .conductor_smoke_protocol import SmokeCommandError, normalize_smoke_command, sanitize_reason, smoke_result
from .conductor_service_helpers import _desired_project_labels, _hostname, _linear_agent_app_user_id, _optional_int
from .conductor_service_types import ConductorServiceError, CoordinationResult
from .workflow_driver import WorkflowDriver


LOGGER = logging.getLogger(__name__)


class ConductorPodiumSyncMixin:
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

    async def handle_podium_command(self, command: dict[str, Any]) -> dict[str, Any]:
        kind = str(command.get("type") or "")
        if kind == "smoke.check":
            return await self.handle_smoke_check(command)
        if kind == "project.configure":
            return self._handle_project_configure(command)
        if kind == "project.unconfigure":
            return self._handle_project_unconfigure(command)
        if kind == "project.prepare_installation":
            return self._handle_installation_prepare(command)
        if kind == "project.activate_installation":
            return self._handle_installation_activate(command)
        return {"status": "ignored", "reason": "unsupported_command"}

    async def handle_smoke_check(self, raw_command: dict[str, Any]) -> dict[str, Any]:
        try:
            command = normalize_smoke_command(raw_command)
        except SmokeCommandError as exc:
            _log_invalid_smoke_command(exc, self._smoke_instance(), self.store.get_settings())
            return {"status": "rejected", "reason": exc.code}
        async with self._smoke_check_lock:
            instance = self._smoke_instance()
            settings = self.store.get_settings()
            _log_smoke_started(command, instance, settings)
            result = await self._execute_smoke_check(command, instance)
            _log_smoke_completed(command, result, instance, settings)
            return {"status": "completed" if result["status"] == "passed" else "failed", "result": result}

    async def _execute_smoke_check(self, command: dict[str, Any], instance: Any | None) -> dict[str, Any]:
        binding_ready = _binding_matches(instance, command)
        repository_ready = _repository_ready(instance, command)
        config_ready = bool(instance is not None)
        proxy_ready = False
        label_ready = False
        proxy_reason = "Project binding identity did not match the smoke command"
        if binding_ready and instance is not None:
            try:
                proxy = self.project_label_proxy_factory(instance)
                project_id = await proxy.find_project_id(command["project_slug"])
                proxy_ready = project_id == command["linear_project_id"]
                if proxy_ready:
                    labels = await proxy.fetch_project_labels(str(project_id))
                    expected = command["expected_label"]
                    label_ready = any(
                        str(label.get("id") or "") == expected["id"]
                        or str(label.get("name") or "") == expected["name"]
                        for label in labels
                        if isinstance(label, dict)
                    )
                else:
                    proxy_reason = "Linear proxy returned a different project identity"
            except Exception as exc:
                proxy_reason = sanitize_reason(exc)
        checks = {
            "binding_identity": binding_ready,
            "repository_readiness": repository_ready,
            "linear_proxy_access": proxy_ready,
            "runtime_config_validity": config_ready,
            "project_label_state": label_ready,
        }
        return smoke_result(command, checks, _first_smoke_failure(checks, proxy_reason))

    def _smoke_instance(self) -> Any | None:
        instances = self.store.list_instances()
        return instances[0] if len(instances) == 1 else None

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

    async def dispatch_podium_event(self, event: dict[str, Any]) -> dict[str, Any]:
        issue_id = str(event.get("issue_id") or "").strip()
        issue_identifier = str(event.get("issue_identifier") or "").strip()
        if not issue_id and not issue_identifier:
            raise ConductorServiceError("missing_issue_id", "Podium dispatch event requires issue_id or issue_identifier")
        project_slug = str(event.get("project_slug") or "").strip()
        agent_app_user_id = str(event.get("agent_app_user_id") or event.get("app_user_id") or "").strip()
        if not agent_app_user_id:
            self._record_dispatch_skip_finding(
                reason="missing_linear_agent_app_user",
                issue_id=issue_id,
                issue_identifier=issue_identifier,
                project_slug=project_slug,
            )
            return {
                "status": "skipped",
                "issue_id": issue_id or None,
                "issue_identifier": issue_identifier or None,
                "reason": "missing_linear_agent_app_user",
            }
        instance = self._instance_for_podium_event(
            project_slug=project_slug,
            agent_app_user_id=agent_app_user_id,
            instance_id=str(event.get("instance_id") or "").strip(),
        )
        if instance is None:
            self._record_dispatch_skip_finding(
                reason="no_matching_instance",
                issue_id=issue_id,
                issue_identifier=issue_identifier,
                project_slug=project_slug,
            )
            return {
                "status": "skipped",
                "issue_id": issue_id or None,
                "issue_identifier": issue_identifier or None,
                "reason": "no_matching_instance",
            }
        accepted = self.workflow.accept_parent(
            issue_id or issue_identifier,
            issue_identifier or issue_id,
            instance_id=instance.id,
        )
        self.store.update_run_payload(
            str(accepted["run_id"]),
            {
                "issue_title": str(event.get("issue_title") or ""),
                "issue_description": str(event.get("issue_description") or ""),
                "agent_app_user_id": agent_app_user_id,
            },
        )
        run = self.store.get_run(str(accepted["run_id"])) or {}
        return {
            "status": "accepted",
            "issue_id": issue_id or None,
            "issue_identifier": issue_identifier or None,
            "instance_id": instance.id,
            "agent_app_user_id": agent_app_user_id,
            "run_id": accepted["run_id"],
            "parent_issue_id": accepted["parent_issue_id"],
            "active_work_item_id": run.get("active_task_id") or "",
            "managed_run_state": run.get("state") or "planning",
            "plan_version": run.get("plan_version") or 0,
            "backend_session_id": str((run.get("payload") or {}).get("thread_id") or ""),
        }

    def _record_dispatch_skip_finding(
        self,
        *,
        reason: str,
        issue_id: str,
        issue_identifier: str,
        project_slug: str,
    ) -> None:
        findings = getattr(self, "_managed_run_reconcile_findings", None)
        if findings is None:
            findings = []
            self._managed_run_reconcile_findings = findings
        findings.append(
            {
                "event": "podium_dispatch_skipped",
                "severity": "warning",
                "error_type": "RuntimeError",
                "sanitized_reason": reason,
                "action_required": "fix_dispatch_routing",
                "retryable": True,
                "issue_id": issue_id or None,
                "issue_identifier": issue_identifier or None,
                "project_slug": project_slug or None,
            }
        )

    async def poll_podium_dispatch_once(self) -> dict[str, Any]:
        settings = self.store.get_settings()
        podium_url = settings.podium_url.strip().rstrip("/")
        runtime_token = settings.podium_runtime_token.strip()
        if not podium_url or not runtime_token:
            return {"status": "skipped", "reason": "runtime_not_configured"}
        headers = {"Authorization": f"Bearer {runtime_token}"}
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            lease_response = await client.post(f"{podium_url}/api/v1/runtime/dispatches/lease", headers=headers)
            if lease_response.status_code == 401:
                return {"status": "skipped", "reason": "runtime_unauthorized"}
            lease_response.raise_for_status()
            leased = lease_response.json().get("dispatch")
            if not leased:
                return {"status": "idle"}
            result = await self.dispatch_podium_event(leased)
            await client.post(
                f"{podium_url}/api/v1/runtime/dispatches/ack",
                headers=headers,
                json={
                    "dispatch_id": leased.get("dispatch_id"),
                    "fencing_token": leased.get("fencing_token"),
                    "status": result.get("status", "accepted"),
                    "reason": result.get("reason"),
                    "run_id": result.get("run_id"),
                    "parent_issue_id": result.get("parent_issue_id"),
                    "active_work_item_id": result.get("active_work_item_id"),
                    "managed_run_state": result.get("managed_run_state"),
                    "plan_version": result.get("plan_version"),
                    "backend_session_id": result.get("backend_session_id"),
                },
            )
            return {"status": "leased", "dispatch": leased, "result": result}

    def build_podium_report(self, *, log_tail_lines: int = 200) -> dict[str, Any]:
        settings = self.store.get_settings()
        bindings: list[dict[str, Any]] = []
        metrics: dict[str, dict[str, Any]] = {}
        queue: dict[str, dict[str, Any]] = {}
        log_tail: dict[str, dict[str, Any]] = {}
        managed_runs_view = _sanitize_managed_runs_view(_managed_runs_report_view(self.managed_run_view()))
        managed_run_metrics = _managed_run_report_metrics(managed_runs_view)
        managed_run_queue = _managed_run_report_queue(managed_runs_view)
        unbound: dict[str, Any] = {}
        for instance in self.store.list_instances():
            unbound = _unbound_binding_report(instance)
            if unbound:
                continue
            bindings.append(
                {
                    "instance_id": instance.id,
                    "name": instance.name,
                    "linear_project": instance.linear_project,
                    "project_slug": instance.linear_project,
                    "linear_project_id": str(instance.linear_filters.get("linear_project_id") or ""),
                    "binding_config_version": int(instance.linear_filters.get("binding_config_version") or 0),
                    "prepared_installation_id": str(instance.linear_filters.get("pending_installation_id") or ""),
                    "prepared_binding_config_version": int(
                        instance.linear_filters.get("pending_binding_config_version") or 0
                    ),
                    "agent_app_user_id": _linear_agent_app_user_id(instance.linear_filters),
                    "process_status": instance.process_status,
                    "constraint_labels": _desired_project_labels(instance),
                    "repo_source": {"type": instance.repo_source_type, "value": instance.repo_source_value},
                }
            )
            metrics[instance.id] = {**managed_run_metrics, "running": bool(instance.process_status == "running")}
            queue[instance.id] = {
                "queued": managed_run_queue["queued"],
                "leased": managed_run_queue["leased"],
                "running": 1 if instance.process_status == "running" else 0,
            }
            logs = self.query_instance_logs(instance.id, tail=log_tail_lines, order="desc")
            log_tail[instance.id] = {
                "generation": logs.get("generation"),
                "offset_end": logs.get("offset_end", 0),
                "lines": logs.get("lines") or [],
            }
        report = {
            "conductor_id": settings.conductor_id,
            "hostname": _hostname(),
            "label": "",
            "version": "",
            "bindings": bindings,
            "metrics": metrics,
            "queue": queue,
            "log_tail": log_tail,
            "managed_runs": managed_runs_view,
        }
        report.update(unbound)
        return report

    async def post_podium_report(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        log_tail_lines: int = 200,
    ) -> dict[str, Any]:
        settings = self.store.get_settings()
        podium_url = settings.podium_url.strip().rstrip("/")
        runtime_token = settings.podium_runtime_token.strip()
        if not podium_url or not runtime_token:
            return {"status": "skipped", "reason": "runtime_not_configured"}
        async with httpx.AsyncClient(timeout=10, trust_env=False, transport=transport) as client:
            response = await client.post(
                f"{podium_url}/api/v1/runtime/report",
                headers={"Authorization": f"Bearer {runtime_token}"},
                json=self.build_podium_report(log_tail_lines=log_tail_lines),
            )
        if response.status_code == 401:
            return {"status": "skipped", "reason": "runtime_unauthorized"}
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {"status": "ok"}

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


def _binding_matches(instance: Any | None, command: dict[str, Any]) -> bool:
    if instance is None:
        return False
    filters = instance.linear_filters
    return bool(
        str(filters.get("binding_id") or "") == command["binding_id"]
        and int(filters.get("binding_config_version") or 0) == command["config_version"]
        and str(filters.get("linear_project_id") or "") == command["linear_project_id"]
        and instance.linear_project == command["project_slug"]
    )


def _repository_ready(instance: Any | None, command: dict[str, Any]) -> bool:
    if instance is None:
        return False
    expected_type = "git" if command["repository"]["mode"] == "git_url" else "local_path"
    path = Path(instance.resolved_repo_path)
    return bool(
        instance.repo_source_type == expected_type
        and instance.repo_source_value == command["repository"]["value"]
        and path.is_dir()
        and os.access(path, os.R_OK | os.X_OK)
    )


def _first_smoke_failure(checks: dict[str, bool], proxy_reason: str) -> tuple[str, str, str, bool] | None:
    failures = (
        ("binding_identity", "smoke_binding_mismatch", "Conductor binding does not match Podium", "rebind_project"),
        ("repository_readiness", "repository_not_ready", "Bound repository is not ready", "fix_repository"),
        ("runtime_config_validity", "runtime_runtime_unavailable", "Conductor runtime is unavailable", "restore_conductor"),
        ("linear_proxy_access", "linear_proxy_check_failed", proxy_reason, "restore_linear_proxy"),
        ("project_label_state", "managed_project_label_mismatch", "Managed project label is missing", "restore_project_label"),
    )
    for name, code, reason, action in failures:
        if not checks[name]:
            return code, reason, action, True
    return None


def _log_smoke_started(command: dict[str, Any], instance: Any | None, settings: Any) -> None:
    message = _smoke_event_fields("conductor_smoke_check_started", command, instance, settings)
    LOGGER.info(message)
    _append_instance_log(instance, message)


def _log_smoke_completed(command: dict[str, Any], result: dict[str, Any], instance: Any | None, settings: Any) -> None:
    message = (
        f"{_smoke_event_fields('conductor_smoke_check_completed', command, instance, settings)} status={result['status']} "
        f"error_type={'ConductorSmokeCheckError' if result['status'] == 'failed' else '-'} "
        f"error_code={result['error_code'] or '-'} sanitized_reason={result['sanitized_reason'] or '-'} "
        f"action_required={result['action_required'] or '-'} retryable={str(result['retryable']).lower()} "
        f"next_action={result['next_action'] or '-'}"
    )
    (LOGGER.error if result["status"] == "failed" else LOGGER.info)(message)
    _append_instance_log(instance, message)


def _log_invalid_smoke_command(error: SmokeCommandError, instance: Any | None, settings: Any) -> None:
    message = (
        f"event=conductor_smoke_command_rejected {_smoke_runtime_fields(settings, instance)} "
        f"error_type=SmokeCommandError error_code={error.code} sanitized_reason={error.reason} "
        "action_required=retry_smoke_check retryable=false next_action=inspect_podium_command"
    )
    LOGGER.error(message)
    _append_instance_log(instance, message)


def _smoke_event_fields(event: str, command: dict[str, Any], instance: Any | None, settings: Any) -> str:
    return (
        f"event={event} {_smoke_runtime_fields(settings, instance)} smoke_check_id={command['smoke_check_id']} "
        f"binding_id={command['binding_id']} linear_project_id={command['linear_project_id']}"
    )


def _smoke_runtime_fields(settings: Any, instance: Any | None) -> str:
    runtime_id = settings.podium_runtime_id or settings.conductor_id or "-"
    return (
        f"runtime_group_id={settings.runtime_group_id or '-'} runtime_id={runtime_id} "
        f"conductor_id={settings.conductor_id or runtime_id} "
        f"instance_id={getattr(instance, 'id', '-') if instance else '-'}"
    )


def _append_instance_log(instance: Any | None, message: str) -> None:
    log_path = getattr(instance, "log_path", None)
    if not log_path:
        return
    path = Path(str(log_path))
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"{datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')} {message}\n")
    except OSError:
        LOGGER.warning("event=conductor_instance_log_write_failed instance_id=%s", getattr(instance, "id", "-"))


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


def _unbound_binding_report(instance: Any) -> dict[str, Any]:
    binding_id = str(instance.linear_filters.get("unbound_binding_id") or "")
    if not binding_id:
        return {}
    return {
        "unbound_binding_id": binding_id,
        "unbound_config_version": int(instance.linear_filters.get("unbound_config_version") or 0),
    }


def _managed_run_report_metrics(view: dict[str, Any]) -> dict[str, Any]:
    runs = view.get("runs") if isinstance(view.get("runs"), list) else []
    return {
        "runs_total": len(runs),
        "runs_blocked": sum(1 for run in runs if isinstance(run, dict) and run.get("state") in {"blocked", "failed"}),
        "runs_done": sum(1 for run in runs if isinstance(run, dict) and run.get("state") == "done"),
    }


def _managed_run_report_queue(view: dict[str, Any]) -> dict[str, int]:
    runs = view.get("runs") if isinstance(view.get("runs"), list) else []
    return {
        "queued": sum(
            1
            for run in runs
            if isinstance(run, dict) and run.get("state") in {"planning", "awaiting_approval"}
        ),
        "leased": sum(1 for run in runs if isinstance(run, dict) and run.get("state") == "executing"),
    }


def _managed_runs_report_view(view: Any) -> dict[str, list[dict[str, Any]]]:
    runs = view.get("runs") if isinstance(view, dict) else []
    return {"runs": [_managed_run_report(run) for run in runs if isinstance(run, dict)]}


def _managed_run_report(run: dict[str, Any]) -> dict[str, Any]:
    payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
    tasks = run.get("tasks") if isinstance(run.get("tasks"), list) else []
    return {
        "run_id": str(run.get("run_id") or ""),
        "parent_issue_id": str(run.get("parent_issue_id") or ""),
        "issue_identifier": str(run.get("issue_identifier") or ""),
        "state": str(run.get("state") or "planning"),
        "active_work_item_id": str(run.get("active_task_id") or ""),
        "latest_reason": str(run.get("latest_reason") or ""),
        "plan_version": int(run.get("plan_version") or 0),
        "backend_session_id": str(payload.get("thread_id") or ""),
        "work_items": [_managed_run_work_item(task) for task in tasks if isinstance(task, dict)],
    }


def _managed_run_work_item(task: dict[str, Any]) -> dict[str, Any]:
    payload = task.get("task") if isinstance(task.get("task"), dict) else {}
    files = payload.get("files_likely_touched") if isinstance(payload.get("files_likely_touched"), list) else []
    return {
        "work_item_id": str(task.get("task_id") or ""),
        "state": str(task.get("state") or "todo"),
        "gate_status": str(task.get("gate_status") or ""),
        "payload": {
            "title": str(payload.get("title") or ""),
            "objective": str(payload.get("objective") or ""),
            "files_likely_touched": [str(path) for path in files],
        },
    }


def _sanitize_managed_runs_view(value: Any, *, key: str = "") -> Any:
    if isinstance(value, dict):
        return {str(name): _sanitize_managed_runs_view(item, key=str(name)) for name, item in value.items()}
    if isinstance(value, list):
        return [_sanitize_managed_runs_view(item, key=key) for item in value]
    if not isinstance(value, str):
        return value
    if any(marker in key.lower() for marker in ("token", "secret", "password", "authorization", "cookie")):
        return "[REDACTED]"
    return re.sub(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", value)[:4000]


__all__ = ["ConductorPodiumSyncMixin"]
