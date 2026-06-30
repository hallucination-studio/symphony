from __future__ import annotations

from pathlib import Path
from typing import Any
import shutil
from datetime import datetime, timezone

from .conductor_models import (
    ConductorSettings,
    InstanceCreateRequest,
    InstancePatchRequest,
    InstanceRecord,
    WorkflowValidationResult,
)
from .conductor_runtime import ConductorRuntimeManager
from .conductor_store import ConductorStore
from .conductor_workflow import (
    ConductorValidationError,
    generate_workflow_content,
    validate_instance_workflow,
    workflow_profiles,
)
from .persistence import PersistenceStore, PersistedSession


WORKSPACE_INIT_EXCLUDES = {
    ".symphony",
    "conductor-data",
    ".venv",
    "workspaces",
    ".codex-runtime",
    ".pytest_cache",
    "__pycache__",
    "node_modules",
    "target",
}


class ConductorServiceError(Exception):
    def __init__(self, code: str, message: str, *, diagnostics: list[str] | None = None):
        super().__init__(message)
        self.code = code
        self.diagnostics = diagnostics or []


class ConductorService:
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
        self.data_root.mkdir(parents=True, exist_ok=True)
        self._normalize_stale_runtime_state()

    def list_instances(self) -> list[InstanceRecord]:
        return self.store.list_instances()

    def settings(self) -> ConductorSettings:
        return self.store.get_settings()

    def update_settings(self, settings: ConductorSettings) -> ConductorSettings:
        self.store.save_settings(settings)
        return settings

    def update_settings_json(self, payload: dict[str, Any]) -> ConductorSettings:
        return self.update_settings(ConductorSettings.from_dict(payload))

    def dashboard(self) -> dict[str, Any]:
        instances = self.store.list_instances()
        process_statuses: dict[str, int] = {}
        workflow_statuses: dict[str, int] = {}
        linear_views: dict[str, dict[str, Any]] = {}
        total_tokens = 0
        runtime_seconds = 0
        retry_count = 0
        persisted_failures = 0
        for instance in instances:
            process_statuses[instance.process_status] = process_statuses.get(instance.process_status, 0) + 1
            workflow_statuses[instance.workflow_generation_status] = workflow_statuses.get(instance.workflow_generation_status, 0) + 1
            filters_key = json_stable(instance.linear_filters)
            linear_key = f"{instance.linear_project}\0{filters_key}"
            if linear_key not in linear_views:
                linear_views[linear_key] = {
                    "project": instance.linear_project,
                    "filters": instance.linear_filters,
                    "instances": 0,
                }
            linear_views[linear_key]["instances"] += 1
            persisted = PersistenceStore(Path(instance.persistence_path)).load()
            retry_count += len(persisted.retry_attempts)
            persisted_failures += sum(1 for retry in persisted.retry_attempts if retry.error)
            now = datetime.now(timezone.utc)
            for session in persisted.sessions:
                total_tokens += session.tokens.total_tokens
                runtime_seconds += max(int((now - session.started_at).total_seconds()), 0)
        return {
            "counts": {
                "instances": len(instances),
                "running": process_statuses.get("running", 0),
                "workflow_draft": workflow_statuses.get("draft", 0),
                "workflow_invalid": workflow_statuses.get("invalid", 0),
            },
            "process_statuses": process_statuses,
            "workflow_statuses": workflow_statuses,
            "linear_views": list(linear_views.values()),
            "totals": {
                "tokens": total_tokens,
                "runtime_seconds": runtime_seconds,
                "failures": sum(1 for instance in instances if instance.last_error) + persisted_failures,
                "retries": retry_count,
            },
        }

    def get_instance(self, instance_id: str) -> InstanceRecord | None:
        return self.store.get_instance(instance_id)

    def create_instance(self, request: InstanceCreateRequest) -> InstanceRecord:
        instance, validation = self._build_instance_candidate(request, persist_workflow=True)
        if not validation.ok:
            raise ConductorServiceError(validation.error_code or "invalid_workflow", "Workflow validation failed", diagnostics=validation.diagnostics)

        instance = instance.with_updates(workflow_generation_status="valid")
        self._materialize_instance(instance)
        self._initialize_workspace(instance)
        self.store.create_instance(instance)
        return instance

    def preview_instance(self, request: InstanceCreateRequest) -> tuple[InstanceRecord, WorkflowValidationResult]:
        return self._build_instance_candidate(request, persist_workflow=False)

    def _build_instance_candidate(
        self, request: InstanceCreateRequest, *, persist_workflow: bool
    ) -> tuple[InstanceRecord, WorkflowValidationResult]:
        resolved_repo_path = self._resolve_repo(request.repo_source_type, request.repo_source_value)
        instance_id = self._allocate_instance_id()
        instance_dir = request.instance_dir or str((self.data_root / "instances" / instance_id).resolve())
        workspace_root = request.workspace_root or str((Path(instance_dir) / "workspace" / "repo").resolve())
        persistence_path = request.persistence_path or str((Path(instance_dir) / "state" / "symphony.json").resolve())
        log_path = request.log_path or str((Path(instance_dir) / "logs" / "symphony.log").resolve())
        workflow_path = str((Path(instance_dir) / "WORKFLOW.md").resolve())
        http_port = request.http_port or self.store.allocate_port()

        instance = InstanceRecord.create(
            id=instance_id,
            name=request.name,
            repo_source_type=request.repo_source_type,
            repo_source_value=request.repo_source_value,
            resolved_repo_path=resolved_repo_path,
            instance_dir=instance_dir,
            workflow_path=workflow_path,
            workspace_root=workspace_root,
            persistence_path=persistence_path,
            log_path=log_path,
            http_port=http_port,
            linear_project=request.linear_project,
            linear_filters=request.linear_filters,
            workflow_profile=request.workflow_profile,
            workflow_inputs=request.workflow_inputs,
        )
        instance = instance.with_updates(workflow_content=self._generate_workflow(instance))
        validation = validate_instance_workflow(instance, self.store.list_instances(), persist=persist_workflow)
        if validation.ok:
            instance = instance.with_updates(workflow_generation_status="valid")
        else:
            instance = instance.with_updates(workflow_generation_status="invalid")
        return instance, validation

    def update_instance(self, instance_id: str, patch: InstancePatchRequest) -> InstanceRecord:
        current = self._require_instance(instance_id)
        updated = current.with_updates(
            name=patch.name if patch.name is not None else current.name,
            linear_project=patch.linear_project if patch.linear_project is not None else current.linear_project,
            linear_filters=patch.linear_filters if patch.linear_filters is not None else current.linear_filters,
            workflow_profile=patch.workflow_profile if patch.workflow_profile is not None else current.workflow_profile,
            workflow_inputs=patch.workflow_inputs if patch.workflow_inputs is not None else current.workflow_inputs,
        )
        workflow_content = patch.workflow_content
        if workflow_content is None and (
            patch.linear_project is not None or patch.linear_filters is not None or patch.workflow_profile is not None or patch.workflow_inputs is not None
        ):
            workflow_content = self._generate_workflow(updated)
        if workflow_content is not None:
            updated = updated.with_updates(workflow_content=workflow_content)
            validation = validate_instance_workflow(updated, self._other_instances(instance_id))
            if not validation.ok:
                raise ConductorServiceError(
                    validation.error_code or "invalid_workflow",
                    "Workflow validation failed",
                    diagnostics=validation.diagnostics,
                )
            updated = updated.with_updates(workflow_generation_status="valid")
            Path(updated.workflow_path).write_text(updated.workflow_content, encoding="utf-8")
        self.store.update_instance(updated)
        return updated

    def delete_instance(self, instance_id: str) -> None:
        instance = self._require_instance(instance_id)
        if instance.process_status in {"running", "starting"}:
            raise ConductorServiceError("instance_running", "Stop the instance before deleting it")
        instance_root = Path(instance.instance_dir)
        self.store.delete_instance(instance_id)
        if instance_root.exists():
            shutil.rmtree(instance_root, ignore_errors=True)

    def validate_workflow(self, instance_id: str, workflow_content: str) -> WorkflowValidationResult:
        current = self._require_instance(instance_id)
        candidate = current.with_updates(workflow_content=workflow_content)
        return validate_instance_workflow(candidate, self._other_instances(instance_id))

    def generate_workflow(self, instance_id: str) -> InstanceRecord:
        current = self._require_instance(instance_id)
        workflow_content = self._generate_workflow(current)
        return self.update_instance(instance_id, InstancePatchRequest(workflow_content=workflow_content))

    async def start_instance(self, instance_id: str) -> InstanceRecord:
        current = self._require_instance(instance_id)
        validation = validate_instance_workflow(current, self._other_instances(instance_id))
        if not validation.ok:
            raise ConductorServiceError(validation.error_code or "invalid_workflow", "Workflow validation failed", diagnostics=validation.diagnostics)
        started = await self.runtime_manager.start(
            current.with_updates(process_status="starting"),
            env=self._runtime_env(),
        )
        self.store.update_instance(started)
        return started

    async def stop_instance(self, instance_id: str) -> InstanceRecord:
        current = self._require_instance(instance_id)
        stopped = await self.runtime_manager.stop(current)
        self.store.update_instance(stopped)
        return stopped

    async def restart_instance(self, instance_id: str) -> InstanceRecord:
        current = self._require_instance(instance_id)
        validation = validate_instance_workflow(current, self._other_instances(instance_id))
        if not validation.ok:
            raise ConductorServiceError(validation.error_code or "invalid_workflow", "Workflow validation failed", diagnostics=validation.diagnostics)
        restarted = await self.runtime_manager.restart(current, env=self._runtime_env())
        self.store.update_instance(restarted)
        return restarted

    def instance_runtime(self, instance_id: str) -> dict[str, object]:
        current = self._require_instance(instance_id)
        runtime = dict(self.runtime_manager.runtime_snapshot(current))
        symphony = self._symphony_runtime_from_persistence(current)
        runtime["workspace"] = {
            "root": current.workspace_root,
            "strategy": "instance_repo_workspace",
            "description": (
                "Conductor initializes an instance-level repository workspace once, then reuses the "
                "prepared repository workspace for Symphony and Codex runs."
            ),
        }
        runtime["symphony"] = symphony
        runtime["metrics"] = _runtime_metrics(symphony)
        return runtime

    def instance_logs(self, instance_id: str) -> str:
        current = self._require_instance(instance_id)
        return self.runtime_manager.read_logs(current)

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
        raise ConductorServiceError("clone_not_implemented", "Git clone flow is not implemented in this build")

    def available_workflow_profiles(self) -> list[dict[str, str]]:
        return workflow_profiles()

    def _resolve_repo(self, repo_source_type: str, repo_source_value: str) -> str:
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
        Path(instance.workflow_path).write_text(instance.workflow_content, encoding="utf-8")
        Path(instance.log_path).touch()

    def _initialize_workspace(self, instance: InstanceRecord) -> None:
        workspace = Path(instance.workspace_root)
        workspace.mkdir(parents=True, exist_ok=True)
        if any(workspace.iterdir()):
            return
        if instance.repo_source_type != "local_path":
            return
        source = Path(instance.resolved_repo_path)
        if not source.exists() or not source.is_dir():
            raise ConductorServiceError("missing_local_path", f"Local path does not exist: {source}")
        for item in source.iterdir():
            if item.name in WORKSPACE_INIT_EXCLUDES:
                continue
            target = workspace / item.name
            if item.is_dir():
                shutil.copytree(item, target, symlinks=True)
            else:
                shutil.copy2(item, target)

    def _generate_workflow(self, instance: InstanceRecord) -> str:
        try:
            return generate_workflow_content(instance)
        except ConductorValidationError as exc:
            raise ConductorServiceError(exc.code, str(exc)) from exc

    def _other_instances(self, instance_id: str) -> list[InstanceRecord]:
        return [instance for instance in self.store.list_instances() if instance.id != instance_id]

    def _require_instance(self, instance_id: str) -> InstanceRecord:
        current = self.store.get_instance(instance_id)
        if current is None:
            raise ConductorServiceError("instance_not_found", f"Instance not found: {instance_id}")
        return current

    def _allocate_instance_id(self) -> str:
        existing = {instance.id for instance in self.store.list_instances()}
        index = 1
        while True:
            candidate = f"inst-{index}"
            if candidate not in existing:
                return candidate
            index += 1

    def _runtime_env(self) -> dict[str, str]:
        settings = self.store.get_settings()
        linear_api_key = settings.linear_api_key.strip()
        if not linear_api_key:
            raise ConductorServiceError(
                "missing_conductor_linear_api_key",
                "Configure the Linear API key in Conductor settings before starting an instance",
            )
        return {"LINEAR_API_KEY": linear_api_key}

    def _normalize_stale_runtime_state(self) -> None:
        for instance in self.store.list_instances():
            if instance.process_status in {"starting", "running", "unhealthy", "crash_loop"}:
                self.store.update_instance(instance.with_updates(process_status="stopped", pid=None))

    def _symphony_runtime_from_persistence(self, instance: InstanceRecord) -> dict[str, Any]:
        persisted = PersistenceStore(Path(instance.persistence_path)).load()
        running = [_persisted_session_row(session) for session in persisted.sessions]
        retrying = [_persisted_retry_row(entry) for entry in persisted.retry_attempts]
        return {
            "source": "persistence",
            "persistence_path": instance.persistence_path,
            "counts": {
                "running": len(running),
                "retrying": len(retrying),
            },
            "running": running,
            "retrying": retrying,
            "issues": running + retrying,
        }


def json_stable(payload: dict[str, Any]) -> str:
    import json

    return json.dumps(payload, separators=(",", ":"), sort_keys=True)


def _persisted_session_row(session: PersistedSession) -> dict[str, Any]:
    return {
        "issue_id": session.issue_id,
        "issue_identifier": session.issue_identifier,
        "issue_url": session.issue_url,
        "session_id": session.session_id,
        "thread_id": session.thread_id,
        "turn_id": session.turn_id,
        "worker_host": session.worker_host,
        "phase": session.phase,
        "status_label": session.status_label,
        "workspace_path": session.workspace_path,
        "started_at": session.started_at.isoformat().replace("+00:00", "Z"),
        "last_event": session.last_event,
        "last_message": session.last_message,
        "last_raw_message": session.last_raw_message,
        "recent_events": session.recent_events,
        "turn_count": session.turn_count,
        "tokens": {
            "input_tokens": session.tokens.input_tokens,
            "output_tokens": session.tokens.output_tokens,
            "total_tokens": session.tokens.total_tokens,
        },
    }


def _persisted_retry_row(entry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "issue_identifier": entry.identifier,
        "issue_url": entry.issue_url,
        "attempt": entry.attempt,
        "due_at": entry.due_at.isoformat().replace("+00:00", "Z"),
        "due_at_ms": entry.due_at_ms,
        "error": entry.error,
        "last_message": entry.last_message,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "recent_events": entry.recent_events,
    }


def _runtime_metrics(symphony: dict[str, Any]) -> dict[str, Any]:
    running = symphony.get("running") if isinstance(symphony.get("running"), list) else []
    retrying = symphony.get("retrying") if isinstance(symphony.get("retrying"), list) else []
    tokens = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    turns = 0
    for row in running:
        if not isinstance(row, dict):
            continue
        row_tokens = row.get("tokens") if isinstance(row.get("tokens"), dict) else {}
        tokens["input_tokens"] += _int(row_tokens.get("input_tokens"))
        tokens["output_tokens"] += _int(row_tokens.get("output_tokens"))
        tokens["total_tokens"] += _int(row_tokens.get("total_tokens"))
        turns += _int(row.get("turn_count"))
    return {
        "tokens": tokens,
        "turns": turns,
        "running": len(running),
        "retrying": len(retrying),
    }


def _int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    return 0
