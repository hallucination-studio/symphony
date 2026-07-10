from __future__ import annotations

from typing import Any

from .conductor_models import InstanceCreateRequest, InstancePatchRequest
from .conductor_service_helpers import _optional_int
from .conductor_service_types import ConductorServiceError


class PodiumWebSocketMixin:
    async def handle_podium_ws_command(
        self,
        command: dict[str, Any],
        *,
        post_log_chunk: Any | None = None,
    ) -> dict[str, Any]:
        kind = str(command.get("type") or "")
        if kind == "dispatch.available":
            dispatch = command.get("dispatch") if isinstance(command.get("dispatch"), dict) else command
            queued_dispatch = dict(dispatch)
            if not (queued_dispatch.get("issue_id") or queued_dispatch.get("issue_identifier")):
                queued_dispatch["_lease_dispatch"] = True
            self._podium_dispatch_queue.put_nowait(queued_dispatch)
            return {
                "status": "queued",
                "issue_id": dispatch.get("issue_id") or None,
                "issue_identifier": dispatch.get("issue_identifier") or None,
                "agent_session_id": dispatch.get("agent_session_id") or None,
            }
        if kind == "human.answered":
            return self._handle_podium_human_answered(command)
        if kind == "project.configure":
            return self._handle_project_configure(command)
        if kind == "project.unconfigure":
            return self._handle_project_unconfigure(command)
        if kind == "project.prepare_installation":
            return self._handle_installation_prepare(command)
        if kind == "project.activate_installation":
            return self._handle_installation_activate(command)
        if kind == "log.fetch":
            instance_id = str(command.get("instance_id") or "")
            logs = self.query_instance_logs(
                instance_id,
                tail=_optional_int(command.get("tail"), 200),
                previous=bool(command.get("previous")),
                order=str(command.get("order") or "desc"),
            )
            payload = {
                "request_id": str(command.get("request_id") or ""),
                "instance_id": instance_id,
                "generation": logs.get("generation"),
                "offset_start": logs.get("offset_start", 0),
                "offset_end": logs.get("offset_end", 0),
                "order": logs.get("order") or "desc",
                "lines": logs.get("lines") or [],
            }
            if post_log_chunk is not None:
                await post_log_chunk(payload)
                return {"status": "posted", "request_id": payload["request_id"]}
            return {"status": "log_chunk_ready", "chunk": payload}
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
        filters = _project_filters(command, project_id, version)
        try:
            instance = self.create_instance(
                InstanceCreateRequest(
                    name=str(command.get("project_name") or command.get("project_slug") or project_id),
                    repo_source_type="git" if mode == "git_url" else "local_path",
                    repo_source_value=value,
                    linear_project=str(command.get("project_slug") or ""),
                    linear_filters=filters,
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
        filters = _project_filters(command, project_id, version)
        updated = self.update_instance(
            instance.id,
            InstancePatchRequest(
                name=str(command.get("project_name") or command.get("project_slug") or project_id),
                linear_project=str(command.get("project_slug") or ""),
                linear_filters=filters,
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
        tombstone = {
            "unbound_binding_id": binding_id,
            "unbound_config_version": version,
        }
        self.update_instance(
            instance.id,
            InstancePatchRequest(linear_project="", linear_filters=tombstone),
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
        filters = {
            **instance.linear_filters,
            "pending_installation_id": installation_id,
            "pending_agent_app_user_id": app_user_id,
            "pending_binding_config_version": version,
        }
        self.update_instance(instance.id, InstancePatchRequest(linear_filters=filters))
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

    def _handle_podium_human_answered(self, command: dict[str, Any]) -> dict[str, Any]:
        _ = command
        return {"status": "ignored", "reason": "managed_runs_use_runtime_wait_state"}


def _project_filters(command: dict[str, Any], project_id: str, version: int) -> dict[str, Any]:
    return {
        "binding_id": str(command.get("binding_id") or ""),
        "binding_config_version": version,
        "linear_project_id": project_id,
        "agent_app_user_id": str(command.get("agent_app_user_id") or ""),
    }
