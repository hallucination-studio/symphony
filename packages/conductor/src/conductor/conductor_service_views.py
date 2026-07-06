from __future__ import annotations

import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .conductor_models import InstanceCreateRequest, InstancePatchRequest, InstanceRecord, WorkflowValidationResult
from .conductor_runtime import LogQuery
from .conductor_service_helpers import *  # noqa: F403
from .conductor_service_types import *  # noqa: F403
from .conductor_workflow import (
    ConductorValidationError,
    generate_workflow_content,
    validate_instance_workflow,
    workflow_profiles,
)
from performer_api.models import utc_now
from performer_api.ops_projection import build_issue_detail, build_issue_list, build_run_detail, build_trace_stream
from performer_api.ops_retention import RetentionPolicy
from performer_api.ops_store import OpsStore
from performer_api.persistence import PersistenceStore
from performer_api.phase import RunPhase


class ConductorServiceViewsMixin:
    def dashboard(self) -> dict[str, Any]:
        instances = self.store.list_instances()
        phase_runs = self.store.list_orchestration_runs()
        process_statuses: dict[str, int] = {}
        workflow_statuses: dict[str, int] = {}
        linear_views: dict[str, dict[str, Any]] = {}
        total_tokens = 0
        runtime_seconds = 0
        retry_count = 0
        continuation_count = 0
        blocked_count = 0
        pending_human_count = 0
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
            instance_phase_runs = [run for run in phase_runs if run.instance_id == instance.id]
            if instance_phase_runs:
                retry_count += sum(run.retry_count for run in instance_phase_runs)
                blocked_count += sum(1 for run in instance_phase_runs if run.phase is RunPhase.AWAITING_HUMAN)
                pending_human_count += sum(1 for run in instance_phase_runs if run.phase is RunPhase.AWAITING_HUMAN)
                persisted_failures += sum(1 for run in instance_phase_runs if run.phase is RunPhase.FAILED)
            else:
                retry_count += len(persisted.retry_attempts)
                continuation_count += len(persisted.continuations)
                blocked_count += len(persisted.blocked)
                pending_human_count += len(persisted.human_interventions)
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
                "continuations": continuation_count,
                "blocked": blocked_count,
                "pending_human": pending_human_count,
            },
            "podium_connection": self._podium_connection,
        }

    def update_podium_connection(self, channel: str, *, status: str, error: str | None = None) -> None:
        sanitized = _sanitize_connection_error(error)
        self._podium_connection[channel] = {
            "status": status,
            "last_error": sanitized,
            "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
        }

    def list_issues(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for instance, snapshot in self._ops_snapshots():
            for issue in build_issue_list(snapshot):
                row = issue.to_dict()
                row["instance_id"] = instance.id
                rows.append(row)
        return sorted(rows, key=lambda row: str(row.get("last_activity_at") or ""), reverse=True)

    def get_issue(self, issue_id: str) -> dict[str, Any]:
        for instance, snapshot in self._ops_snapshots():
            if issue_id in snapshot.issues:
                detail = build_issue_detail(snapshot, issue_id)
                detail["instance_id"] = instance.id
                return detail
        raise ConductorServiceError("issue_not_found", f"Issue not found: {issue_id}")

    def list_runs(self) -> list[dict[str, Any]]:
        phase_runs = self.store.list_orchestration_runs()
        if phase_runs:
            rows = [self._phase_run_row(run) for run in phase_runs]
        else:
            rows = []
            for instance, snapshot in self._ops_snapshots():
                for run in snapshot.runs.values():
                    row = run.to_dict()
                    row["instance_id"] = instance.id
                    rows.append(row)
        return sorted(rows, key=lambda row: str(row.get("last_activity_at") or ""), reverse=True)

    def get_run(self, run_id: str) -> dict[str, Any]:
        run = self.store.get_orchestration_run(run_id)
        if run is not None:
            return self._phase_run_detail(run)
        for instance, snapshot in self._ops_snapshots():
            if run_id in snapshot.runs:
                detail = build_run_detail(snapshot, run_id)
                detail["instance_id"] = instance.id
                return detail
        raise ConductorServiceError("run_not_found", f"Run not found: {run_id}")

    def list_trace_events(
        self, *, issue_id: str | None, run_id: str | None, limit: int = 200
    ) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        for instance, snapshot in self._ops_snapshots():
            for event in build_trace_stream(snapshot, issue_id=issue_id, run_id=run_id, limit=limit):
                row = event.to_dict()
                row["instance_id"] = instance.id
                events.append(row)
        return sorted(events, key=lambda row: str(row.get("timestamp") or ""))[-limit:]

    def retention_status(self) -> dict[str, Any]:
        pinned_issue_ids: set[str] = set()
        pinned_run_ids: set[str] = set()
        event_counts = {"summary": 0, "trace": 0, "raw": 0}
        for _instance, snapshot in self._ops_snapshots():
            pinned_issue_ids.update(snapshot.retention.pinned_issue_ids)
            pinned_run_ids.update(snapshot.retention.pinned_run_ids)
            for event in snapshot.events:
                if event.retention_tier in event_counts:
                    event_counts[event.retention_tier] += 1
        return {
            "pinned_issue_count": len(pinned_issue_ids),
            "pinned_run_count": len(pinned_run_ids),
            "pinned_issue_ids": sorted(pinned_issue_ids),
            "pinned_run_ids": sorted(pinned_run_ids),
            "event_counts": event_counts,
        }

    def pin_issue(self, issue_id: str) -> dict[str, Any]:
        self._update_issue_pin(issue_id, pinned=True)
        return self.retention_status()

    def unpin_issue(self, issue_id: str) -> dict[str, Any]:
        self._update_issue_pin(issue_id, pinned=False)
        return self.retention_status()

    def collect_retention(self, policy: RetentionPolicy | None = None) -> dict[str, Any]:
        policy = policy or RetentionPolicy()
        for _instance, store, snapshot in self._ops_stores():
            store.save(policy.apply(snapshot))
        return self.retention_status()

    def get_instance(self, instance_id: str) -> InstanceRecord | None:
        instance = self.store.get_instance(instance_id)
        if instance is None:
            return None
        refresh = getattr(self.runtime_manager, "refresh", None)
        if not callable(refresh):
            return instance
        refreshed = refresh(instance)
        if refreshed != instance:
            self.store.update_instance(refreshed)
        return refreshed

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
        persistence_path = request.persistence_path or str((Path(instance_dir) / "state" / "performer.json").resolve())
        log_path = request.log_path or str((Path(instance_dir) / "logs" / "performer.log").resolve())
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
            updated = updated.with_updates(
                workflow_content=workflow_content,
                workflow_generation_status="valid",
            )
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

    async def approve_runtime_error(self, instance_id: str, *, issue_id: str | None = None) -> dict[str, Any]:
        _ = self._require_instance(instance_id), issue_id
        raise ConductorServiceError(
            "runtime_error_approval_removed",
            "Runtime approvals must be completed through the Linear [Human Action] child issue.",
        )

    def instance_runtime(self, instance_id: str) -> dict[str, object]:
        current = self._require_instance(instance_id)
        runtime = dict(self.runtime_manager.runtime_snapshot(current))
        performer = self._performer_runtime_from_phase_runs(current)
        runtime["workspace"] = {
            "root": current.workspace_root,
            "strategy": "instance_repo_workspace",
            "description": (
                "Conductor initializes an instance-level repository workspace once, then reuses the "
                "prepared repository workspace for Performer and Codex runs."
            ),
        }
        runtime["performer"] = performer
        runtime["metrics"] = _runtime_metrics(performer)
        return runtime

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
        result = self.runtime_manager.query_logs(
            current,
            LogQuery(
                tail=tail,
                limit_bytes=limit_bytes,
                previous=previous,
                order=order,
                timestamps=timestamps,
                prefix=prefix,
            ),
        )
        return {
            "instance_id": result.instance_id,
            "generation": result.generation,
            "path": result.path,
            "order": result.order,
            "lines": result.lines,
            "logs": result.text(),
            "offset_start": result.offset_start,
            "offset_end": result.offset_end,
            "warnings": result.warnings,
        }

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
        target = Path(target_path)
        if target.exists() and any(target.iterdir()):
            return {"repo_url": repo_url, "target_path": str(target), "cloned": False}
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            subprocess.run(["git", "clone", "--", repo_url, str(target)], check=True)
        except subprocess.CalledProcessError as exc:
            raise ConductorServiceError("git_clone_failed", f"Git clone failed: {exc}") from exc
        return {"repo_url": repo_url, "target_path": str(target), "cloned": True}

    def available_workflow_profiles(self) -> list[dict[str, str]]:
        return workflow_profiles()

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
        Path(instance.workflow_path).write_text(instance.workflow_content, encoding="utf-8")
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

    def _generate_workflow(self, instance: InstanceRecord) -> str:
        try:
            settings = self.store.get_settings()
            podium_url = settings.podium_url.strip() or "https://podium.example"
            return generate_workflow_content(instance, podium_url=podium_url)
        except ConductorValidationError as exc:
            raise ConductorServiceError(exc.code, str(exc)) from exc

    def _other_instances(self, instance_id: str) -> list[InstanceRecord]:
        return [instance for instance in self.store.list_instances() if instance.id != instance_id]

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

    def _runtime_env(self) -> dict[str, str]:
        settings = self.store.get_settings()
        env: dict[str, str] = {}
        proxy_token = settings.podium_proxy_token.strip()
        if proxy_token:
            env["PODIUM_PROXY_TOKEN"] = proxy_token
        runtime_token = settings.podium_runtime_token.strip()
        if runtime_token:
            env["PODIUM_RUNTIME_TOKEN"] = runtime_token
        runtime_id = settings.podium_runtime_id.strip()
        if runtime_id:
            env["PODIUM_RUNTIME_ID"] = runtime_id
        runtime_group_id = settings.runtime_group_id.strip()
        if runtime_group_id:
            env["PODIUM_RUNTIME_GROUP_ID"] = runtime_group_id
        if not self._managed_mode_enabled():
            linear_api_key = os.environ.get("LINEAR_API_KEY", "").strip()
            if linear_api_key:
                env["LINEAR_API_KEY"] = linear_api_key
        return env

    def _managed_mode_enabled(self) -> bool:
        return self.store.get_settings().managed_mode

    def _phase_run_row(self, run) -> dict[str, Any]:
        telemetry = self._telemetry_for_phase_run(run)
        telemetry_run = telemetry.get("run") if isinstance(telemetry.get("run"), dict) else {}
        return {
            "run_id": run.run_id,
            "issue_id": run.issue_id,
            "issue_identifier": run.issue_identifier,
            "instance_id": run.instance_id,
            "phase": run.phase.value,
            "status": run.status,
            "attempt": run.attempt,
            "workflow_profile": run.workflow_profile,
            "dispatch_id": run.dispatch_id,
            "workspace_path": run.workspace_path,
            "ops_snapshot_path": run.ops_snapshot_path,
            "human_action": dict(run.human_action),
            "human_response": run.human_response,
            "last_reason": run.last_reason,
            "last_error": run.last_error,
            "process_pid": run.process_pid,
            "ack_status": run.ack_status,
            "retry_count": run.retry_count,
            "crash_count": run.crash_count,
            "init_failure_count": run.init_failure_count,
            "overload_count": run.overload_count,
            "next_run_at": run.next_run_at,
            "turn_count": _int(telemetry_run.get("turn_count")),
            "total_tokens": _int(telemetry_run.get("total_tokens")),
            "estimated_cost_usd": float(telemetry_run.get("estimated_cost_usd") or 0.0),
            "last_activity_at": telemetry_run.get("last_activity_at"),
        }

    def _phase_run_detail(self, run) -> dict[str, Any]:
        telemetry = self._telemetry_for_phase_run(run)
        events = [event.to_dict() for event in self.store.list_orchestration_events(run.run_id)]
        return {
            "run": self._phase_run_row(run),
            "issue": telemetry.get("issue"),
            "attempts": telemetry.get("attempts", []),
            "turns": telemetry.get("turns", []),
            "events": events,
            "metrics": telemetry.get("metrics", {}),
            "telemetry": telemetry,
            "instance_id": run.instance_id,
        }

    def _telemetry_for_phase_run(self, run) -> dict[str, Any]:
        instance = self.store.get_instance(run.instance_id)
        if instance is None:
            return {"source": "missing_instance"}
        snapshot = OpsStore(Path(instance.persistence_path).parent / "ops.json").load()
        telemetry_run_id = _latest_ops_run_id_for_issue(snapshot, run.issue_id)
        if telemetry_run_id is None:
            return {"source": "none"}
        detail = build_run_detail(snapshot, telemetry_run_id)
        detail["source"] = "ops"
        return detail

    def _performer_runtime_from_phase_runs(self, instance: InstanceRecord) -> dict[str, Any]:
        phase_runs = self.store.list_orchestration_runs(instance_id=instance.id)
        telemetry = self._performer_runtime_from_persistence(instance)
        if not phase_runs:
            return telemetry
        running: list[dict[str, Any]] = []
        retrying: list[dict[str, Any]] = []
        continuing: list[dict[str, Any]] = []
        blocked: list[dict[str, Any]] = []
        human_interventions: list[dict[str, Any]] = []
        completed: list[dict[str, Any]] = []
        failed: list[dict[str, Any]] = []
        for run in phase_runs:
            row = _phase_runtime_row(run)
            if run.phase in {RunPhase.IMPLEMENTING, RunPhase.REVIEWING, RunPhase.REWORKING}:
                running.append(row)
            elif run.phase is RunPhase.QUEUED:
                retrying.append(row) if run.retry_count or run.next_run_at else continuing.append(row)
            elif run.phase is RunPhase.AWAITING_HUMAN:
                blocked.append(row)
                human_interventions.append(row)
            elif run.phase is RunPhase.DONE:
                completed.append(row)
            elif run.phase is RunPhase.FAILED:
                failed.append(row)
        return {
            "source": "conductor_phase",
            "persistence_path": instance.persistence_path,
            "counts": {
                "running": len(running),
                "retrying": len(retrying),
                "continuing": len(continuing),
                "blocked": len(blocked),
                "pending_human": len(human_interventions),
                "completed": len(completed),
                "failed": len(failed),
            },
            "running": running,
            "retrying": retrying,
            "continuing": continuing,
            "blocked": blocked,
            "human_interventions": human_interventions,
            "completed": completed,
            "failed": failed,
            "issues": running + retrying + continuing + blocked + human_interventions + completed + failed,
            "telemetry": telemetry,
        }

    def _performer_runtime_from_persistence(self, instance: InstanceRecord) -> dict[str, Any]:
        persisted = PersistenceStore(Path(instance.persistence_path)).load()
        running = [_persisted_session_row(session) for session in persisted.sessions]
        retrying = [_persisted_retry_row(entry) for entry in persisted.retry_attempts]
        continuing = [_persisted_continuation_row(entry) for entry in persisted.continuations]
        blocked = [_persisted_blocked_row(entry) for entry in persisted.blocked]
        human_interventions = [_persisted_human_intervention_row(entry) for entry in persisted.human_interventions]
        return {
            "source": "persistence",
            "persistence_path": instance.persistence_path,
            "counts": {
                "running": len(running),
                "retrying": len(retrying),
                "continuing": len(continuing),
                "blocked": len(blocked),
                "pending_human": len(human_interventions),
            },
            "running": running,
            "retrying": retrying,
            "continuing": continuing,
            "blocked": blocked,
            "human_interventions": human_interventions,
            "issues": running + retrying + continuing + blocked + human_interventions,
        }

    def _ops_snapshots(self) -> list[tuple[InstanceRecord, OpsSnapshot]]:
        return [(instance, snapshot) for instance, _store, snapshot in self._ops_stores()]

    def _ops_stores(self) -> list[tuple[InstanceRecord, OpsStore, OpsSnapshot]]:
        rows: list[tuple[InstanceRecord, OpsStore, OpsSnapshot]] = []
        for instance in self.store.list_instances():
            store = OpsStore(Path(instance.persistence_path).parent / "ops.json")
            snapshot = store.load()
            rows.append((instance, store, snapshot))
        return rows

    def _update_issue_pin(self, issue_id: str, *, pinned: bool) -> None:
        found = False
        for _instance, store, snapshot in self._ops_stores():
            if issue_id not in snapshot.issues and issue_id not in snapshot.retention.pinned_issue_ids:
                continue
            found = True
            pinned_ids = list(snapshot.retention.pinned_issue_ids)
            if pinned and issue_id not in pinned_ids:
                pinned_ids.append(issue_id)
            if not pinned:
                pinned_ids = [item for item in pinned_ids if item != issue_id]
            snapshot.retention = snapshot.retention.__class__(
                pinned_issue_ids=sorted(pinned_ids),
                pinned_run_ids=list(snapshot.retention.pinned_run_ids),
                last_collected_at=snapshot.retention.last_collected_at,
            )
            store.save(snapshot)
        if not found:
            raise ConductorServiceError("issue_not_found", f"Issue not found: {issue_id}")
