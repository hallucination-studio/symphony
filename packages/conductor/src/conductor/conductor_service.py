from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from performer_api.performer_control import (
    CONTROL_OPERATIONS,
    PerformerControlError,
    PerformerControlEvent,
    PerformerControlResult,
    PerformerReadinessState,
)
from performer_api.runtime_policy import RuntimePolicy, canonical_sha256

from .models import (
    ConductorServiceError,
    ConductorSettings,
    InstanceCreateRequest,
    InstancePatchRequest,
    InstanceRecord,
    utc_now_iso,
)
from .gate import AcceptanceGate
from .performer_control import (
    PerformerCoordinator,
    PerformerCoordinatorError,
    PerformerCoordinatorHooks,
)
from .runtime import PerformerRuntime
from .conductor_podium_sync import ConductorPodiumSyncMixin
from .conductor_service_helpers import _linear_agent_app_user_id
from .linear import ManagedRunLinearProxy
from .store import ConductorStore


WORKSPACE_INIT_EXCLUDES = {
    ".conductor",
    "conductor-data",
    ".venv",
    "workspaces",
    ".codex-runtime",
    ".test-real-flow",
    ".tmp-real-linear-flow",
    ".pytest_cache",
    "__pycache__",
    "node_modules",
    "target",
}

_CONTROL_STDERR_EVENTS = frozenset(
    {"performer_control_operation_failed", "performer_control_protocol_failed"}
)
_CONTROL_STDERR_FIELDS = frozenset(
    {
        "event",
        "error_type",
        "error_code",
        "sanitized_reason",
        "action_required",
        "retryable",
        "next_action",
        "request_id",
        "operation",
    }
)
_CONTROL_STDERR_REQUIRED_FIELDS = _CONTROL_STDERR_FIELDS - {"request_id", "operation"}
_SAFE_CONTROL_REQUEST_ID = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\Z")


class ConductorService(ConductorPodiumSyncMixin):
    def __init__(
        self,
        *,
        store: ConductorStore,
        data_root: Path,
    ):
        self.store = store
        self.data_root = data_root
        self.performer_runtime = PerformerRuntime()
        self.performer_coordinator = PerformerCoordinator(
            command=(*self.performer_runtime.performer_command, "control"),
            process_env=self.performer_runtime.prepare_environment(),
            hooks=PerformerCoordinatorHooks(
                on_event=self._on_performer_control_event,
                on_failure=self._on_performer_control_failure,
                on_readiness_invalidated=self._on_performer_readiness_invalidated,
                on_check_started=self._on_performer_check_started,
                on_login_lost=self._on_performer_login_lost,
                on_stderr=self._on_performer_control_stderr,
            ),
            cwd=None,
        )
        self.acceptance_gate = AcceptanceGate()
        self._smoke_check_lock = asyncio.Lock()
        self.project_label_proxy_factory = self._project_label_proxy
        self.data_root.mkdir(parents=True, exist_ok=True)

    async def start(self) -> None:
        instances = self.store.list_instances()
        if not instances:
            return
        await self.ensure_performer_control_started()

    async def ensure_performer_control_started(self) -> None:
        instances = self.store.list_instances()
        if len(instances) != 1:
            raise ConductorServiceError(
                "performer_binding_required",
                "A Performer binding is required before control",
            )
        instance = instances[0]
        self.performer_coordinator.cwd = instance.workspace_root
        self._ensure_performer_identity(instance)
        if not self.performer_coordinator.is_running:
            await self.performer_coordinator.start()

    async def stop(self) -> None:
        await self.performer_coordinator.stop()

    def _ensure_performer_identity(self, instance: InstanceRecord) -> dict[str, Any]:
        identity = self._performer_identity_for_current_capabilities(instance)
        return self.store.ensure_performer_control_identity(**identity)

    def _performer_identity_for_current_capabilities(
        self, instance: InstanceRecord
    ) -> dict[str, Any]:
        current = self.store.get_performer_control_state()
        capability_version = int(current.get("capability_version") or 0)
        return _performer_identity(
            instance,
            capability_version=max(1, capability_version),
        )

    async def _on_performer_readiness_invalidated(self, _request: Any) -> None:
        instances = self.store.list_instances()
        if not instances:
            return
        identity = self._performer_identity_for_current_capabilities(instances[0])
        self.store.ensure_performer_control_identity(**identity)
        current = self.store.get_performer_control_state()
        self.store.record_performer_readiness(
            PerformerReadinessState(
                performer_kind=identity["performer_kind"],
                binding_generation=identity["binding_generation"],
                capability_version=max(1, int(current.get("capability_version") or 1)),
                execution_policy_sha256=identity["execution_policy_sha256"],
                status="unchecked",
                last_check_status="none",
                error=None,
            )
        )

    async def _on_performer_check_started(self, _request: Any) -> None:
        """Make a manual Check non-ready before its backend request is written."""

        instances = self.store.list_instances()
        if not instances:
            return
        identity = self._performer_identity_for_current_capabilities(instances[0])
        self.store.ensure_performer_control_identity(**identity)
        current = self.store.get_performer_control_state()
        self.store.record_performer_readiness(
            PerformerReadinessState(
                performer_kind=identity["performer_kind"],
                binding_generation=identity["binding_generation"],
                capability_version=identity["capability_version"],
                execution_policy_sha256=identity["execution_policy_sha256"],
                status="checking",
                last_check_status=str(current.get("last_check_status") or "none"),
                error=None,
            ),
            check_started_at=utc_now_iso(),
        )
        self._append_control_log(
            "event=performer_check_started level=info "
            f"performer_kind={identity['performer_kind']} "
            f"binding_generation={identity['binding_generation']} "
            f"capability_version={identity['capability_version']} "
            f"execution_policy_sha256={identity['execution_policy_sha256']}"
        )

    async def _on_performer_control_failure(self, error: PerformerCoordinatorError) -> None:
        instances = self.store.list_instances()
        if not instances:
            return
        identity = self._performer_identity_for_current_capabilities(instances[0])
        self.store.ensure_performer_control_identity(**identity)
        current = self.store.get_performer_control_state()
        readiness = PerformerReadinessState(
            performer_kind=identity["performer_kind"],
            binding_generation=identity["binding_generation"],
            capability_version=max(1, int(current.get("capability_version") or 1)),
            execution_policy_sha256=identity["execution_policy_sha256"],
            status="failed",
            last_check_status="failed",
            error=PerformerControlError(
                error_code=error.error_code,
                sanitized_reason=error.sanitized_reason,
                action_required=error.action_required,
                retryable=error.retryable,
                attempt_number=None,
                next_action=error.next_action,
            ),
        )
        self.store.record_performer_readiness(readiness)
        self._append_control_log(
            "event=performer_control_failed level=error "
            f"error_code={error.error_code} sanitized_reason={error.sanitized_reason.replace(' ', '_')} "
            f"action_required={'true' if error.action_required else 'false'} "
            f"retryable={'true' if error.retryable else 'false'} next_action={error.next_action.replace(' ', '_')}"
        )

    def apply_performer_control_result(self, result: PerformerControlResult) -> dict[str, Any]:
        """Persist the compatible manual Check outcome and expose failures durably."""

        if not isinstance(result, PerformerControlResult):
            raise TypeError("result must be PerformerControlResult")
        instances = self.store.list_instances()
        if not instances:
            raise ConductorServiceError("performer_binding_required", "A Performer binding is required before control")
        identity = self._performer_identity_for_current_capabilities(instances[0])
        self.store.ensure_performer_control_identity(**identity)
        current = self.store.get_performer_control_state()
        if (
            result.operation == "performer.status"
            and result.status == "succeeded"
            and result.capabilities is not None
        ):
            capabilities = result.capabilities
            if capabilities.performer_kind != identity["performer_kind"]:
                readiness = PerformerReadinessState(
                    performer_kind=identity["performer_kind"],
                    binding_generation=identity["binding_generation"],
                    capability_version=identity["capability_version"],
                    execution_policy_sha256=identity["execution_policy_sha256"],
                    status="failed",
                    last_check_status=str(current.get("last_check_status") or "none"),
                    error=PerformerControlError(
                        error_code="performer_control_protocol_invalid",
                        sanitized_reason="Performer status reported a backend that does not match the active binding.",
                        action_required=True,
                        retryable=False,
                        attempt_number=None,
                        next_action="Restart the Performer control host and refresh backend status.",
                    ),
                )
                self.store.record_performer_readiness(readiness)
            else:
                status_identity = _performer_identity(
                    instances[0],
                    capability_version=capabilities.capability_version,
                )
                self.store.ensure_performer_control_identity(**status_identity)
                if (
                    result.login is not None
                    and result.login.status == "failed"
                    and result.readiness is not None
                    and result.readiness.status == "failed"
                    and result.readiness.error is not None
                    and result.readiness.error.error_code == "performer_login_failed"
                ):
                    self._record_performer_login_failure(status_identity)
        elif result.operation == "performer.check" and result.readiness is not None:
            readiness = result.readiness
            compatible = (
                readiness.performer_kind == identity["performer_kind"]
                and readiness.binding_generation == identity["binding_generation"]
                and readiness.capability_version == identity["capability_version"]
                and readiness.execution_policy_sha256 == identity["execution_policy_sha256"]
            )
            if not compatible:
                readiness = PerformerReadinessState(
                    performer_kind=identity["performer_kind"],
                    binding_generation=identity["binding_generation"],
                    capability_version=identity["capability_version"],
                    execution_policy_sha256=identity["execution_policy_sha256"],
                    status="failed",
                    last_check_status="failed",
                    error=PerformerControlError(
                        error_code="stale_fencing_token",
                        sanitized_reason="Performer Check evidence does not match the active binding or policy.",
                        action_required=True,
                        retryable=False,
                        attempt_number=None,
                        next_action="Run Check again for the active Performer binding.",
                    ),
                )
            self.store.record_performer_readiness(
                readiness,
                check_started_at=result.check.started_at if result.check is not None else None,
                check_finished_at=result.check.finished_at if result.check is not None else None,
            )
        elif result.status == "failed" and result.error is not None:
            last_check_status = str(current.get("last_check_status") or "none")
            if result.operation == "performer.check":
                last_check_status = "failed"
            readiness = PerformerReadinessState(
                performer_kind=identity["performer_kind"],
                binding_generation=identity["binding_generation"],
                capability_version=identity["capability_version"],
                execution_policy_sha256=identity["execution_policy_sha256"],
                status="failed",
                last_check_status=last_check_status,
                error=result.error,
            )
            self.store.record_performer_readiness(readiness)
        state = self.store.get_performer_control_state()
        error_code = result.error.error_code if result.error is not None else ""
        self._append_control_log(
            "event=performer_control_result_applied level=info "
            f"request_id={result.request_id} operation={result.operation} status={result.status} "
            f"error_code={error_code or 'none'}"
        )
        return state

    async def _on_performer_control_event(self, event: PerformerControlEvent) -> None:
        event_message = event.message.replace(" ", "_")
        if event.event_kind in {"login.pending", "login.succeeded", "login.failed"}:
            event_message = f"Performer_device_{event.event_kind.replace('.', '_')}."
        if event.event_kind == "login.failed":
            instances = self.store.list_instances()
            if instances:
                identity = self._performer_identity_for_current_capabilities(instances[0])
                self.store.ensure_performer_control_identity(**identity)
                self._record_performer_login_failure(identity)
                self._append_control_log(
                    "event=performer_login_failed level=error "
                    f"request_id={event.request_id} operation={event.operation} "
                    "error_code=performer_login_failed "
                    "sanitized_reason=Performer_device_login_failed. "
                    "action_required=true retryable=true next_action=Retry_device_login."
                )
        self._append_control_log(
            "event=performer_control_event level=info "
            f"request_id={event.request_id} operation={event.operation} "
            f"event_kind={event.event_kind} sequence={event.sequence} "
            f"message={event_message}"
        )

    def _record_performer_login_failure(self, identity: dict[str, Any]) -> None:
        current = self.store.get_performer_control_state()
        self.store.record_performer_readiness(
            PerformerReadinessState(
                performer_kind=identity["performer_kind"],
                binding_generation=identity["binding_generation"],
                capability_version=identity["capability_version"],
                execution_policy_sha256=identity["execution_policy_sha256"],
                status="failed",
                last_check_status=str(current.get("last_check_status") or "none"),
                error=PerformerControlError(
                    error_code="performer_login_failed",
                    sanitized_reason="Performer device login failed.",
                    action_required=True,
                    retryable=True,
                    attempt_number=None,
                    next_action="Retry device login.",
                ),
            )
        )

    async def _on_performer_login_lost(self, _error: Any) -> None:
        self._append_control_log(
            "event=performer_login_lost level=error error_code=performer_login_lost "
            "sanitized_reason=The_pending_device_login_was_lost "
            "action_required=true retryable=false next_action=restart_login"
        )

    async def _on_performer_control_stderr(self, message: str) -> None:
        self._append_control_log(_safe_performer_control_stderr(message))

    def _append_control_log(self, message: str) -> None:
        instances = self.store.list_instances()
        log_path = Path(instances[0].log_path) if instances else self.data_root / "conductor.log"
        self.performer_runtime.append_event(log_path, message)

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

    def _managed_run_tracker(self) -> Any:
        settings = self.store.get_settings()
        endpoint_base = settings.podium_url.strip().rstrip("/")
        if not endpoint_base or not settings.podium_proxy_token.strip():
            raise ConductorServiceError(
                "podium_proxy_not_configured",
                "Conductor requires the configured Podium Linear proxy",
            )
        endpoint = f"{endpoint_base}/api/v1/linear/graphql"
        api_key = settings.podium_proxy_token.strip()
        return ManagedRunLinearProxy(
            endpoint=endpoint,
            api_key=api_key,
        )

    def _project_label_proxy(self, instance: InstanceRecord) -> Any:
        settings = self.store.get_settings()
        endpoint_base = settings.podium_url.strip().rstrip("/") or "https://podium.example"
        return ManagedRunLinearProxy(
            endpoint=f"{endpoint_base}/api/v1/linear/graphql",
            api_key=settings.podium_proxy_token.strip(),
        )

    def get_instance(self, instance_id: str) -> InstanceRecord | None:
        return self.store.get_instance(instance_id)

    def create_instance(self, request: InstanceCreateRequest) -> InstanceRecord:
        if self.store.list_instances():
            raise ConductorServiceError(
                "single_project_conductor",
                "A Conductor may manage exactly one project instance",
            )
        instance = self._build_instance_candidate(request)
        self._materialize_instance(instance)
        self._initialize_workspace(instance)
        self.store.create_instance(instance)
        return instance

    def _build_instance_candidate(self, request: InstanceCreateRequest) -> InstanceRecord:
        resolved_repo_path = self._resolve_repo(request.repo_source_type, request.repo_source_value)
        instance_id = self._allocate_instance_id()
        instance_dir = request.instance_dir or str((self.data_root / "instances" / instance_id).resolve())
        workspace_root = request.workspace_root or str((Path(instance_dir) / "workspace" / "repo").resolve())
        persistence_path = request.persistence_path or str((Path(instance_dir) / "state" / "performer.json").resolve())
        log_path = request.log_path or str((Path(instance_dir) / "logs" / "performer.log").resolve())
        http_port = request.http_port or self.store.allocate_port()

        return InstanceRecord.create(
            id=instance_id,
            name=request.name,
            repo_source_type=request.repo_source_type,
            repo_source_value=request.repo_source_value,
            resolved_repo_path=resolved_repo_path,
            instance_dir=instance_dir,
            workspace_root=workspace_root,
            persistence_path=persistence_path,
            log_path=log_path,
            http_port=http_port,
            linear_project=request.linear_project,
            linear_filters=request.linear_filters,
        )

    def update_instance(self, instance_id: str, patch: InstancePatchRequest) -> InstanceRecord:
        current = self._require_instance(instance_id)
        updated = self._patched_instance(current, patch)
        self.store.update_instance(updated)
        return updated

    def _replace_instance_binding_and_clear_managed_runs(
        self,
        instance_id: str,
        patch: InstancePatchRequest,
    ) -> InstanceRecord:
        current = self._require_instance(instance_id)
        updated = self._patched_instance(current, patch)
        self.store.replace_instance_and_clear_managed_runs(updated)
        return updated

    @staticmethod
    def _patched_instance(current: InstanceRecord, patch: InstancePatchRequest) -> InstanceRecord:
        return current.with_updates(
            name=patch.name if patch.name is not None else current.name,
            linear_project=patch.linear_project if patch.linear_project is not None else current.linear_project,
            linear_filters=patch.linear_filters if patch.linear_filters is not None else current.linear_filters,
        )

    def delete_instance(self, instance_id: str) -> None:
        instance = self._require_instance(instance_id)
        if instance.process_status in {"running", "starting"}:
            raise ConductorServiceError("instance_running", "Stop the instance before deleting it")
        instance_root = Path(instance.instance_dir)
        self.store.delete_instance(instance_id)
        if instance_root.exists():
            shutil.rmtree(instance_root, ignore_errors=True)

    async def start_instance(self, instance_id: str) -> InstanceRecord:
        current = self._require_instance(instance_id)
        started = current.with_updates(process_status="running")
        self.store.update_instance(started)
        return started

    async def stop_instance(self, instance_id: str) -> InstanceRecord:
        current = self._require_instance(instance_id)
        stopped = current.with_updates(process_status="stopped", pid=None)
        self.store.update_instance(stopped)
        return stopped

    async def restart_instance(self, instance_id: str) -> InstanceRecord:
        current = self._require_instance(instance_id)
        restarted = current.with_updates(process_status="running", pid=None)
        self.store.update_instance(restarted)
        return restarted

    def instance_runtime(self, instance_id: str) -> dict[str, object]:
        current = self._require_instance(instance_id)
        runtime: dict[str, object] = {
            "instance_id": current.id,
            "process_status": current.process_status,
            "pid": current.pid,
            "http_port": current.http_port,
            "log_path": current.log_path,
        }
        performer = self._managed_run_runtime_snapshot()
        runtime["workspace"] = {
            "root": current.workspace_root,
            "strategy": "instance_repo_workspace",
            "description": (
                "Conductor initializes an instance-level repository workspace once, then reuses the "
                "prepared repository workspace for Performer and Codex runs."
            ),
        }
        runtime["performer"] = performer
        running = performer.get("running") if isinstance(performer.get("running"), list) else []
        retrying = performer.get("retrying") if isinstance(performer.get("retrying"), list) else []
        continuing = performer.get("continuing") if isinstance(performer.get("continuing"), list) else []
        blocked = performer.get("blocked") if isinstance(performer.get("blocked"), list) else []
        human_interventions = (
            performer.get("human_interventions")
            if isinstance(performer.get("human_interventions"), list)
            else []
        )
        tokens = {"input_tokens": 0, "output_tokens": 0, "cached_tokens": 0, "total_tokens": 0}
        turns = 0
        for row in running:
            if not isinstance(row, dict):
                continue
            row_tokens = row.get("tokens") if isinstance(row.get("tokens"), dict) else {}
            for key in tokens:
                value = row_tokens.get(key)
                if isinstance(value, int) and not isinstance(value, bool):
                    tokens[key] += value
            turn_count = row.get("turn_count")
            if isinstance(turn_count, int) and not isinstance(turn_count, bool):
                turns += turn_count
        runtime["metrics"] = {
            "tokens": tokens,
            "turns": turns,
            "running": len(running),
            "retrying": len(retrying),
            "continuing": len(continuing),
            "blocked": len(blocked),
            "pending_human": len(human_interventions),
        }
        return runtime

    def _managed_run_runtime_snapshot(self) -> dict[str, Any]:
        view = self.store.managed_run_view()
        runs = view.get("runs") if isinstance(view.get("runs"), list) else []
        runtime_waits = view.get("runtime_waits") if isinstance(view.get("runtime_waits"), list) else []
        if not runtime_waits:
            runtime_waits = [
                {"run_id": run.get("run_id"), **wait}
                for run in runs
                if isinstance(run, dict)
                for wait in (run.get("runtime_waits") or [])
                if isinstance(wait, dict)
            ]
        running = [
            {
                "run_id": run.get("run_id"),
                "issue_id": run.get("parent_issue_id"),
                "issue_identifier": run.get("issue_identifier"),
                "state": run.get("state"),
                "active_work_item_id": run.get("active_task_id"),
            }
            for run in runs
            if isinstance(run, dict)
            and str(run.get("state") or "") in {"planning", "awaiting_approval", "executing"}
        ]
        blocked = [
            {
                "run_id": run.get("run_id"),
                "issue_id": run.get("parent_issue_id"),
                "issue_identifier": run.get("issue_identifier"),
                "reason": run.get("latest_reason") or "blocked",
            }
            for run in runs
            if isinstance(run, dict) and str(run.get("state") or "") in {"blocked", "failed"}
        ]
        pending_human = [
            {
                "run_id": run.get("run_id"),
                "issue_id": run.get("parent_issue_id"),
                "issue_identifier": run.get("issue_identifier"),
                "reason": run.get("latest_reason") or "human attention required",
            }
            for run in runs
            if isinstance(run, dict) and str(run.get("state") or "") == "blocked"
        ]
        return {
            "source": "managed_run",
            "runs_total": len(runs),
            "counts": {
                "running": len(running),
                "retrying": 0,
                "continuing": 0,
                "blocked": len(blocked),
                "pending_human": len(pending_human),
                "runtime_waiting": sum(1 for wait in runtime_waits if wait.get("state") == "open"),
            },
            "running": running,
            "retrying": [],
            "continuing": [],
            "blocked": blocked,
            "human_interventions": pending_human,
            "runtime_waits": runtime_waits,
            "issues": running + blocked + pending_human,
        }

    def managed_run_view(self) -> dict[str, Any]:
        return self.store.managed_run_view()

    def query_instance_logs(
        self,
        instance_id: str,
        *,
        tail: int | None = 200,
        limit_bytes: int = 1_048_576,
        previous: bool = False,
        order: str = "desc",
        timestamps: bool = False,
        prefix: bool = False,
    ) -> dict[str, Any]:
        current = self._require_instance(instance_id)
        _ = timestamps, prefix
        result = self.performer_runtime.read_log(
            Path(current.log_path),
            tail=tail,
            limit_bytes=limit_bytes,
            previous=previous,
            order=order,
        )
        return {
            "instance_id": current.id,
            **result,
        }

    def instance_logs(self, instance_id: str) -> str:
        current = self._require_instance(instance_id)
        return str(self.performer_runtime.read_log(Path(current.log_path), order="asc")["logs"])

    def inspect_repo(self, repo_source_type: str, repo_source_value: str) -> dict[str, Any]:
        resolved = self._resolve_repo(repo_source_type, repo_source_value)
        repo_path = Path(resolved)
        files = sorted(path.name for path in repo_path.iterdir())[:20]
        return {
            "repo_source_type": repo_source_type,
            "repo_source_value": repo_source_value,
            "resolved_path": resolved,
            "exists": repo_path.exists(),
            "git": (repo_path / ".git").exists(),
            "files": files,
        }

    def clone_repo(self, repo_url: str, target_path: str) -> dict[str, Any]:
        target = Path(target_path)
        if target.exists() and any(target.iterdir()):
            return {"repo_url": repo_url, "target_path": str(target), "cloned": False}
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            subprocess.run(["git", "clone", "--", repo_url, str(target)], check=True)
        except subprocess.CalledProcessError as exc:
            raise ConductorServiceError("git_clone_failed", f"Git clone failed: {exc}") from exc
        return {"repo_url": repo_url, "target_path": str(target), "cloned": True}

    def _resolve_repo(self, repo_source_type: str, repo_source_value: str) -> str:
        if repo_source_type == "git":
            if not repo_source_value.strip():
                raise ConductorServiceError("missing_git_url", "Git repository URL is required")
            return repo_source_value
        if repo_source_type != "local_path":
            raise ConductorServiceError("unsupported_repo_source", f"Unsupported repo source type: {repo_source_type}")
        candidate = Path(repo_source_value).expanduser().resolve()
        if not candidate.exists() or not candidate.is_dir():
            raise ConductorServiceError("missing_local_path", f"Local path does not exist: {candidate}")
        return str(candidate)

    def _materialize_instance(self, instance: InstanceRecord) -> None:
        instance_dir = Path(instance.instance_dir)
        (instance_dir / "logs").mkdir(parents=True, exist_ok=True)
        (instance_dir / "state").mkdir(parents=True, exist_ok=True)
        Path(instance.workspace_root).mkdir(parents=True, exist_ok=True)
        Path(instance.log_path).touch()

    def _initialize_workspace(self, instance: InstanceRecord) -> None:
        workspace = Path(instance.workspace_root)
        workspace.mkdir(parents=True, exist_ok=True)
        if any(workspace.iterdir()):
            return
        if instance.repo_source_type == "git":
            self.clone_repo(instance.resolved_repo_path, instance.workspace_root)
            return
        if instance.repo_source_type != "local_path":
            return
        source = Path(instance.resolved_repo_path)
        if not source.exists() or not source.is_dir():
            raise ConductorServiceError("missing_local_path", f"Local path does not exist: {source}")
        for item in source.iterdir():
            if item.name in WORKSPACE_INIT_EXCLUDES:
                continue
            try:
                if item.resolve() == self.data_root.resolve():
                    continue
            except OSError:
                pass
            target = workspace / item.name
            if item.is_dir():
                shutil.copytree(item, target, symlinks=True)
            else:
                shutil.copy2(item, target)

    def _require_instance(self, instance_id: str) -> InstanceRecord:
        current = self.store.get_instance(instance_id)
        if current is None:
            raise ConductorServiceError("instance_not_found", f"Instance not found: {instance_id}")
        return current

    def _instance_for_podium_event(
        self,
        *,
        project_slug: str,
        agent_app_user_id: str,
        instance_id: str = "",
    ) -> InstanceRecord | None:
        candidates = self.store.list_instances()
        if instance_id:
            candidates = [instance for instance in candidates if instance.id == instance_id]
        if project_slug:
            candidates = [instance for instance in candidates if instance.linear_project == project_slug]
        filtered = []
        for instance in candidates:
            configured_agent = _linear_agent_app_user_id(instance.linear_filters)
            if configured_agent and configured_agent != agent_app_user_id:
                continue
            filtered.append(instance)
        candidates = filtered
        if not candidates:
            return None
        return candidates[0]

    def _allocate_instance_id(self) -> str:
        existing = {instance.id for instance in self.store.list_instances()}
        index = 1
        while True:
            candidate = f"inst-{index}"
            if candidate not in existing:
                return candidate
            index += 1

def _safe_performer_control_stderr(message: str) -> str:
    """Accept only the closed stderr log envelope emitted by control_host.

    Provider SDKs can write arbitrary diagnostics to stderr.  They are useful
    only after the owning Performer has converted them into the closed control
    result/event contracts; retaining raw text here would make the Conductor
    log a secret and private-path sink.
    """

    try:
        if not isinstance(message, str) or len(message.encode("utf-8")) > 64 * 1024:
            raise ValueError
        payload = json.loads(message)
        if not isinstance(payload, dict):
            raise ValueError
        if not _CONTROL_STDERR_REQUIRED_FIELDS <= set(payload) <= _CONTROL_STDERR_FIELDS:
            raise ValueError
        if payload.get("event") not in _CONTROL_STDERR_EVENTS:
            raise ValueError
        error = PerformerControlError(
            error_code=payload.get("error_code"),
            sanitized_reason=payload.get("sanitized_reason"),
            action_required=payload.get("action_required"),
            retryable=payload.get("retryable"),
            attempt_number=None,
            next_action=payload.get("next_action"),
        )
        request_id = payload.get("request_id")
        operation = payload.get("operation")
        if (request_id is None) != (operation is None):
            raise ValueError
        correlation = ""
        if request_id is not None:
            if (
                not isinstance(request_id, str)
                or not _SAFE_CONTROL_REQUEST_ID.fullmatch(request_id)
                or operation not in CONTROL_OPERATIONS
            ):
                raise ValueError
            correlation = f" request_id={request_id} operation={operation}"
        return (
            "event=performer_control_host_log level=error "
            f"host_event={payload['event']} error_code={error.error_code} "
            f"sanitized_reason={error.sanitized_reason.replace(' ', '_')} "
            f"action_required={'true' if error.action_required else 'false'} "
            f"retryable={'true' if error.retryable else 'false'} "
            f"next_action={error.next_action.replace(' ', '_')}{correlation}"
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        return (
            "event=performer_control_stderr_invalid level=warning "
            "error_code=performer_control_protocol_invalid "
            "sanitized_reason=Performer_control_emitted_an_unstructured_stderr_record "
            "action_required=true retryable=false "
            "next_action=inspect_performer_control_result_and_restart_host"
        )


def _performer_identity(
    instance: InstanceRecord,
    *,
    capability_version: int = 1,
) -> dict[str, Any]:
    filters = instance.linear_filters if isinstance(instance.linear_filters, dict) else {}
    policy = RuntimePolicy.from_dict(filters.get("execution_policy"))
    policy_hash = canonical_sha256(policy.to_dict())
    supplied_hash = str(filters.get("execution_policy_sha256") or "")
    if supplied_hash != policy_hash:
        raise ConductorServiceError(
            "execution_policy_hash_mismatch",
            "The configured Performer execution policy hash does not match its content",
        )
    kind = str(filters.get("performer_kind") or "")
    binding_id = str(filters.get("performer_binding_id") or "")
    generation = filters.get("performer_binding_generation")
    turn_hash = str(filters.get("turn_policy_sha256") or "")
    if not kind or not binding_id or not isinstance(generation, int) or isinstance(generation, bool) or generation <= 0:
        raise ConductorServiceError(
            "performer_binding_required",
            "A complete Performer binding is required before control can start",
        )
    if len(turn_hash) != 64:
        raise ConductorServiceError(
            "turn_policy_hash_invalid",
            "The configured Performer turn policy hash is invalid",
        )
    if isinstance(capability_version, bool) or not isinstance(capability_version, int) or capability_version <= 0:
        raise ConductorServiceError(
            "performer_capability_version_invalid",
            "The Performer capability version is invalid",
        )
    return {
        "performer_kind": kind,
        "binding_generation": generation,
        "capability_version": capability_version,
        "execution_policy_sha256": policy_hash,
    }
