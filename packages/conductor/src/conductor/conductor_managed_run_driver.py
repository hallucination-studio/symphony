from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from performer_api.managed_runs import ManagedRunRuntimeRole, RuntimeConfigEnvelope

from .conductor_managed_run_coordinator import ConductorManagedRunCoordinator
from .conductor_managed_run_driver_helpers import (
    _active_attempt,
    _active_attempts,
    _attempt_paths,
    _attempt_payload,
    _complete_attempt,
    _completed_attempts,
    _issue_description,
    _sanitize,
    _write_json,
)
from .conductor_managed_run_fencing import attempt_fencing_fields, build_turn_context, plan_turn_request
from .conductor_managed_run_driver_plan_collection import ConductorManagedRunPlanCollectionMixin
from .conductor_managed_run_driver_work_items import ConductorManagedRunWorkItemMixin
from .conductor_managed_run_execution import prepare_execution_worktree
from .conductor_managed_run_state import ManagedRunState
from .conductor_managed_run_store import ConductorManagedRunStore
from .conductor_managed_run_workspace_events import log_workspace_failure
from .conductor_models import InstanceRecord
from .runtime_backends import prepare_backend_environment


class ConductorManagedRunDriver(ConductorManagedRunPlanCollectionMixin, ConductorManagedRunWorkItemMixin):
    def __init__(
        self,
        *,
        store: ConductorManagedRunStore,
        coordinator: ConductorManagedRunCoordinator,
        runtime_manager: Any,
        instance_lookup: Any,
        instance_update: Any,
        runtime_config: dict[str, Any],
    ) -> None:
        self.store = store
        self.coordinator = coordinator
        self.runtime_manager = runtime_manager
        self.instance_lookup = instance_lookup
        self.instance_update = instance_update
        self.runtime_config = runtime_config

    async def drive_once(self) -> dict[str, int]:
        counts = {"started": 0, "applied": 0, "failed": 0}
        self._drained_instance_ids: set[str] = set()
        self._exited_attempts_by_instance: dict[str, list[dict[str, object]]] = {}
        for run in self.store.list_runs():
            result = await self._drive_run(run)
            for key, value in result.items():
                counts[key] = counts.get(key, 0) + value
        return counts

    async def _drive_run(self, run: dict[str, Any]) -> dict[str, int]:
        state = str(run.get("state") or "")
        if state in {ManagedRunState.DONE.value, ManagedRunState.BLOCKED.value, ManagedRunState.FAILED.value}:
            return {}
        instance = self._instance_for_run(run)
        if instance is None:
            self.store.update_run_state(str(run["run_id"]), ManagedRunState.FAILED, reason="managed_run_instance_missing")
            return {"failed": 1}
        instance = self.runtime_manager.refresh(instance)
        self.instance_update(instance)
        self._cache_exited_attempts(instance)
        if state in {ManagedRunState.READY.value, ManagedRunState.REVIEWING.value} and _active_attempts(run, kind="work_item"):
            return await self._collect_work_item_turn(run, instance)
        if state == ManagedRunState.QUEUED.value:
            return await self._start_plan_turn(run, instance)
        if state == ManagedRunState.PLANNING.value:
            if not _active_attempts(run):
                return await self._start_plan_turn(run, instance)
            return self._collect_plan_turn(run)
        if state == ManagedRunState.READY.value:
            return await self._start_or_checkpoint_next_work_item(run, instance)
        if state == ManagedRunState.EXECUTING.value:
            return await self._collect_work_item_turn(run, instance)
        if state == ManagedRunState.REVIEWING.value:
            return self._verify_active_work_item(run, instance)
        return {}

    def _instance_for_run(self, run: dict[str, Any]) -> InstanceRecord | None:
        instance_id = str(run.get("instance_id") or (run.get("payload") or {}).get("instance_id") or "")
        return self.instance_lookup(instance_id) if instance_id else None

    async def _start_plan_turn(self, run: dict[str, Any], instance: InstanceRecord) -> dict[str, int]:
        envelope = self._runtime_config_or_fail(str(run["run_id"]))
        if envelope is None:
            return {"failed": 1}
        revision = self._approved_plan_revision(run)
        work_item_id = str(revision.get("work_item_id") or "")
        attempt_item = f"revision-{work_item_id}" if revision else "plan"
        attempt = _attempt_paths(instance, run, "plan", attempt_item)
        context = build_turn_context(run, attempt, work_item_id=work_item_id, policy_revision=envelope.managed_run_policy.version)
        if attempt["result_path"].exists():
            attempt["result_path"].unlink()
        workspace = self._prepare_plan_workspace(run, instance, attempt, context, work_item_id)
        if workspace is None:
            return {"failed": 1}
        _write_json(
            attempt["request_path"],
            plan_turn_request(
                workspace_path=str(workspace.workspace_path),
                issue_description=_plan_turn_description(self.store, run, revision),
                thread_id=run.get("backend_session_id") or None,
                context=context,
                revision=revision,
            ),
        )
        env = prepare_backend_environment(
            Path(instance.instance_dir) / "state",
            envelope.profiles.get(ManagedRunRuntimeRole.PLAN),
            workspace_path=str(workspace.workspace_path),
            home_scope=attempt["attempt_id"],
        )
        started = await self.runtime_manager.start(
            instance,
            env=env,
            mode="plan",
            attempt_id=attempt["attempt_id"],
            attempt_request_path=str(attempt["request_path"]),
            attempt_result_path=str(attempt["result_path"]),
            lease_id=context.lease_id,
        )
        self.instance_update(started)
        self.store.update_run_state(
            str(run["run_id"]),
            ManagedRunState.PLANNING,
            active_work_item_id=str(run.get("active_work_item_id") or ""),
            reason="plan turn started",
        )
        attempt_payload = {
            **_attempt_payload(attempt, "plan"),
            "workspace_path": str(workspace.workspace_path),
            "base_revision": workspace.base_revision,
            "branch_name": workspace.branch_name,
        }
        if revision:
            attempt_payload.update(
                {
                    "mode": "plan_revision",
                    "work_item_id": str(revision["work_item_id"]),
                    "node_id": str(revision["work_item_id"]),
                    "plan_revision_approval_id": str(revision.get("approval_id") or ""),
                }
            )
        attempt_payload.update(attempt_fencing_fields(context))
        self.store.merge_run_payload(
            str(run["run_id"]),
            {
                "active_attempt": attempt_payload,
                "active_attempts": [attempt_payload],
                "last_managed_run_policy_id": envelope.managed_run_policy.policy_id,
                "last_managed_run_policy_version": envelope.managed_run_policy.version,
            },
        )
        return {"started": 1}

    def _prepare_plan_workspace(
        self,
        run: dict[str, Any],
        instance: InstanceRecord,
        attempt: dict[str, Any],
        context: Any,
        work_item_id: str,
    ) -> Any | None:
        try:
            return prepare_execution_worktree(
                Path(instance.resolved_repo_path),
                state_root=Path(instance.instance_dir) / "state",
                run_id=str(run["run_id"]),
                work_item_id=f"plan-{attempt['attempt_id']}",
            )
        except Exception as exc:
            reason = f"plan_workspace_prepare_failed:{_sanitize(exc)}"
            self.store.update_run_state(str(run["run_id"]), ManagedRunState.FAILED, reason=reason)
            log_workspace_failure(
                run,
                instance,
                work_item_id=work_item_id or "plan",
                reason=reason,
                attempt={**attempt, "turn_context": context.to_dict()},
            )
            return None

    def _runtime_config_or_fail(self, run_id: str) -> RuntimeConfigEnvelope | None:
        try:
            envelope = RuntimeConfigEnvelope.from_dict(self.runtime_config)
            envelope.validate()
        except Exception as exc:
            self.store.update_run_state(run_id, ManagedRunState.FAILED, reason=f"runtime_config_invalid:{_sanitize(exc)}")
            return None
        return envelope

    def _cache_exited_attempts(self, instance: InstanceRecord) -> None:
        if instance.id in self._drained_instance_ids:
            return
        self._drained_instance_ids.add(instance.id)
        drain = getattr(self.runtime_manager, "drain_exited_attempts", None)
        if not callable(drain):
            return
        self._exited_attempts_by_instance[instance.id] = [dict(snapshot) for snapshot in drain(instance)]

    def _active_attempt_exit(self, run: dict[str, Any], attempt: dict[str, Any] | None = None) -> dict[str, object] | None:
        attempt = attempt or _active_attempt(run)
        attempt_id = str(attempt.get("attempt_id") or "")
        if not attempt_id:
            return None
        instance_id = str(run.get("instance_id") or (run.get("payload") or {}).get("instance_id") or "")
        for snapshot in self._exited_attempts_by_instance.get(instance_id, []):
            if str(snapshot.get("attempt_id") or "") == attempt_id:
                return snapshot
        return None

    def _fail_missing_turn_result(self, run_id: str, attempt: dict[str, Any], exited: dict[str, object], kind: str) -> None:
        exit_code = exited.get("exit_code")
        reason = f"{kind}_result_missing_after_process_exit:attempt_id={attempt.get('attempt_id')} exit_code={exit_code}"
        self.store.update_run_state(run_id, ManagedRunState.FAILED, reason=reason)
        current = self.store.get_run(run_id) or {}
        attempt_id = str(attempt.get("attempt_id") or "")
        completed = _completed_attempts(current)
        if not any(str(candidate.get("attempt_id") or "") == attempt_id for candidate in completed):
            completed.append(_complete_attempt({**attempt, "exit": exited, "sanitized_error": reason}, state="failed"))
        active = [candidate for candidate in _active_attempts(current) if str(candidate.get("attempt_id") or "") != attempt_id]
        self.store.merge_run_payload(
            run_id,
            {
                "active_attempt": active[-1] if active else {},
                "active_attempts": active,
                "completed_attempts": completed,
                "last_failed_attempt": {**attempt, "exit": exited, "reason": reason},
            },
        )


def _plan_turn_description(store: ConductorManagedRunStore, run: dict[str, Any], revision: dict[str, Any]) -> str:
    issue_description = _issue_description(run)
    if not revision:
        return issue_description
    plan = store.get_plan(str(run["run_id"]), int(run.get("plan_version") or 0))
    context = {
        "approval_id": revision.get("approval_id"),
        "request": revision.get("request"),
        "work_item_id": revision.get("work_item_id"),
        "accepted_plan": plan.to_dict() if plan is not None else {},
    }
    return f"{issue_description}\n\nManaged Run Revision Request:\n{json.dumps(context, sort_keys=True)}"


__all__ = ["ConductorManagedRunDriver"]
