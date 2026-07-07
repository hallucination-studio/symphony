from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .conductor_models import InstanceCreateRequest, InstancePatchRequest, InstanceRecord
from .conductor_runtime import LogQuery
from .conductor_service_helpers import *  # noqa: F403
from .conductor_service_types import *  # noqa: F403
from performer_api.models import utc_now
from performer_api.ops_store import OpsStore


class ConductorServiceViewsMixin:
    def update_podium_connection(self, channel: str, *, status: str, error: str | None = None) -> None:
        sanitized = _sanitize_connection_error(error)
        self._podium_connection[channel] = {
            "status": status,
            "last_error": sanitized,
            "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
        }

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
        request_path = Path(current.instance_dir) / "state" / "pipeline" / "manual-start-request.json"
        result_path = Path(current.instance_dir) / "state" / "pipeline" / "manual-start-result.json"
        self._write_manual_plan_request(current, request_path)
        started = await self.runtime_manager.start(
            current.with_updates(process_status="starting"),
            env=self._runtime_env(),
            mode="plan",
            attempt_request_path=str(request_path),
            attempt_result_path=str(result_path),
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
        request_path = Path(current.instance_dir) / "state" / "pipeline" / "manual-restart-request.json"
        result_path = Path(current.instance_dir) / "state" / "pipeline" / "manual-restart-result.json"
        self._write_manual_plan_request(current, request_path)
        await self.runtime_manager.stop(current)
        restarted = await self.runtime_manager.start(
            current.with_updates(process_status="starting"),
            env=self._runtime_env(),
            mode="plan",
            attempt_request_path=str(request_path),
            attempt_result_path=str(result_path),
        )
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
        performer = self._pipeline_runtime_snapshot()
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

    def _pipeline_runtime_snapshot(self) -> dict[str, Any]:
        view = self.pipeline_store.pipeline_view().to_dict()
        nodes = view.get("nodes") if isinstance(view.get("nodes"), list) else []
        attempts = view.get("attempts") if isinstance(view.get("attempts"), list) else []
        predicted = view.get("predicted_call_order") if isinstance(view.get("predicted_call_order"), list) else []
        human_waits = view.get("human_waits") if isinstance(view.get("human_waits"), list) else []
        runtime_waits = view.get("runtime_waits") if isinstance(view.get("runtime_waits"), list) else []

        running = [
            {
                "attempt_id": attempt.get("attempt_id"),
                "issue_id": attempt.get("node_id"),
                "mode": attempt.get("mode"),
                "state": attempt.get("state"),
                "started_at": attempt.get("started_at"),
            }
            for attempt in attempts
            if isinstance(attempt, dict) and str(attempt.get("state") or "") == "running"
        ]
        retrying = [
            {
                "issue_id": node.get("node_id"),
                "state": node.get("state"),
                "rework_count": node.get("rework_count"),
            }
            for node in nodes
            if isinstance(node, dict) and int(node.get("rework_count") or 0) > 0
        ]
        blocked = [
            {
                "issue_id": call.get("node"),
                "blocked_by": call.get("blocked_by"),
                "earliest_mode": call.get("earliest_mode"),
            }
            for call in predicted
            if isinstance(call, dict) and isinstance(call.get("blocked_by"), list) and call["blocked_by"]
        ]
        human_interventions = [
            {
                "issue_id": wait.get("node_id"),
                "wait_id": wait.get("wait_id"),
                "reason": wait.get("reason") or wait.get("wait_kind"),
                "status": wait.get("status"),
            }
            for wait in [*human_waits, *runtime_waits]
            if isinstance(wait, dict) and str(wait.get("status") or "waiting") == "waiting"
        ]
        return {
            "source": "pipeline",
            "graph_revision": view.get("graph_revision"),
            "policy_revision": view.get("policy_revision"),
            "counts": {
                "running": len(running),
                "retrying": len(retrying),
                "continuing": 0,
                "blocked": len(blocked),
                "pending_human": len(human_interventions),
            },
            "running": running,
            "retrying": retrying,
            "continuing": [],
            "blocked": blocked,
            "human_interventions": human_interventions,
            "issues": running + retrying + blocked + human_interventions,
        }

    def _write_manual_plan_request(self, instance: InstanceRecord, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "attempt_id": path.stem,
            "graph_id": f"graph-{instance.id}",
            "root_node_id": instance.id,
            "node_id": instance.id,
            "issue_id": instance.id,
            "issue_identifier": instance.name,
            "title": instance.name,
            "graph_revision": self.pipeline_store.current_graph_revision(),
            "policy_revision": self.pipeline_store.active_runtime_config().scheduler_policy.version,
            "lease_id": "",
            "fencing_token": "",
        }
        path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")

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
        return env

    def _managed_mode_enabled(self) -> bool:
        return self.store.get_settings().managed_mode

    def _ops_stores(self) -> list[tuple[InstanceRecord, OpsStore, OpsSnapshot]]:
        rows: list[tuple[InstanceRecord, OpsStore, OpsSnapshot]] = []
        for instance in self.store.list_instances():
            store = OpsStore(Path(instance.persistence_path).parent / "ops.json")
            snapshot = store.load()
            rows.append((instance, store, snapshot))
        return rows
