from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

from .conductor_models import InstanceCreateRequest, InstancePatchRequest, InstanceRecord
from .conductor_service_helpers import *  # noqa: F403
from .conductor_service_types import *  # noqa: F403


class ConductorServiceViewsMixin:
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
        updated = current.with_updates(
            name=patch.name if patch.name is not None else current.name,
            linear_project=patch.linear_project if patch.linear_project is not None else current.linear_project,
            linear_filters=patch.linear_filters if patch.linear_filters is not None else current.linear_filters,
        )
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

    async def approve_runtime_error(self, instance_id: str, *, issue_id: str | None = None) -> dict[str, Any]:
        _ = self._require_instance(instance_id), issue_id
        raise ConductorServiceError(
            "runtime_error_approval_removed",
            "Runtime approvals must be completed on the blocked managed-run work item issue and resumed through Managed Runs.",
        )

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
        runtime["metrics"] = _runtime_metrics(performer)
        return runtime

    def _managed_run_runtime_snapshot(self) -> dict[str, Any]:
        view = self.workflow_store.managed_run_view()
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
                "active_work_item_id": run.get("active_work_item_id"),
            }
            for run in runs
            if isinstance(run, dict)
            and str(run.get("state") or "") in {"planning", "projecting_plan", "ready", "executing", "reviewing"}
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
                "runtime_waiting": sum(1 for wait in runtime_waits if wait.get("status") == "waiting"),
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
        return self.workflow_store.managed_run_view()

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
