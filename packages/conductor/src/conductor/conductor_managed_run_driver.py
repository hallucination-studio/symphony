from __future__ import annotations

from pathlib import Path
from typing import Any

from performer_api.managed_runs import ManagedRunPlan, ManagedRunState, ManagedRunRuntimeRole, RuntimeConfigEnvelope

from .conductor_managed_run_coordinator import ConductorManagedRunCoordinator
from .conductor_managed_run_driver_helpers import (
    _active_attempt,
    _active_attempts,
    _attempt_paths,
    _attempt_payload,
    _complete_attempt,
    _completed_attempts,
    _events_from_payload,
    _issue_description,
    _read_json,
    _sanitize,
    _write_json,
)
from .conductor_managed_run_driver_work_items import ConductorManagedRunWorkItemMixin
from .conductor_managed_run_execution import prepare_execution_worktree
from .conductor_managed_run_store import ConductorManagedRunStore
from .conductor_models import InstanceRecord
from .runtime_backends import prepare_backend_environment


class ConductorManagedRunDriver(ConductorManagedRunWorkItemMixin):
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
            if not _active_attempt(run):
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
        attempt = _attempt_paths(instance, run, "plan", "plan")
        if attempt["result_path"].exists():
            attempt["result_path"].unlink()
        try:
            workspace = prepare_execution_worktree(
                Path(instance.resolved_repo_path),
                state_root=Path(instance.instance_dir) / "state",
                run_id=str(run["run_id"]),
                work_item_id=f"plan-{attempt['attempt_id']}",
            )
        except Exception as exc:
            self.store.update_run_state(str(run["run_id"]), ManagedRunState.FAILED, reason=f"plan_workspace_prepare_failed:{_sanitize(exc)}")
            return {"failed": 1}
        _write_json(
            attempt["request_path"],
            {
                "turn_kind": "plan",
                "workspace_path": str(workspace.workspace_path),
                "issue_description": _issue_description(run),
                "thread_id": run.get("backend_session_id") or None,
            },
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
            lease_id=attempt["attempt_id"],
        )
        self.instance_update(started)
        self.store.update_run_state(str(run["run_id"]), ManagedRunState.PLANNING, reason="plan turn started")
        self.store.merge_run_payload(
            str(run["run_id"]),
            {
                "active_attempt": {
                    **_attempt_payload(attempt, "plan"),
                    "workspace_path": str(workspace.workspace_path),
                    "base_revision": workspace.base_revision,
                    "branch_name": workspace.branch_name,
                }
            },
        )
        return {"started": 1}

    def _collect_plan_turn(self, run: dict[str, Any]) -> dict[str, int]:
        attempt = _active_attempt(run)
        if not attempt:
            self.store.update_run_state(str(run["run_id"]), ManagedRunState.FAILED, reason="plan_attempt_missing")
            return {"failed": 1}
        result_path = Path(str(attempt.get("result_path") or ""))
        if not result_path.exists():
            exited = self._active_attempt_exit(run)
            if exited is not None:
                self._fail_missing_turn_result(str(run["run_id"]), attempt, exited, "plan")
                return {"failed": 1}
            return {}
        payload: dict[str, Any] = {}
        try:
            payload = _read_json(result_path)
            plan_payload = payload.get("plan")
            if not isinstance(plan_payload, dict):
                raise ValueError("plan_result_missing")
            version = self.coordinator.apply_plan(
                str(run["run_id"]),
                ManagedRunPlan.from_dict(plan_payload),
                backend_session_id=str(payload.get("thread_id") or ""),
                creator_attempt_id=str(attempt.get("attempt_id") or ""),
            )
        except Exception as exc:
            reason = f"plan_result_failed:{_sanitize(exc)}"
            self.store.update_run_state(str(run["run_id"]), ManagedRunState.FAILED, reason=reason)
            self._complete_plan_attempt(run, attempt, state="failed", reason=reason, payload=payload)
            return {"failed": 1}
        latest = self.store.get_run(str(run["run_id"])) or run
        if version == 0:
            retryable = latest.get("state") == ManagedRunState.PLANNING.value
            self._complete_plan_attempt(
                run,
                attempt,
                state="failed",
                reason=str(latest.get("latest_reason") or "plan_validation_failed"),
                payload=payload,
                retryable=retryable,
            )
            return {"applied": 1} if retryable else {"failed": 1}
        completed = _completed_attempts(run)
        self.store.merge_run_payload(
            str(run["run_id"]),
            {
                "active_attempt": {},
                "active_attempts": [],
                "completed_attempts": [
                    *completed,
                    _complete_attempt(attempt, state="succeeded", events=_events_from_payload(payload), thread_id=str(payload.get("thread_id") or "")),
                ],
                "last_plan_attempt": attempt,
                "last_plan_version": version,
            },
        )
        return {"applied": 1}

    def _complete_plan_attempt(
        self,
        run: dict[str, Any],
        attempt: dict[str, Any],
        *,
        state: str,
        reason: str,
        payload: dict[str, Any],
        retryable: bool = False,
    ) -> None:
        current = self.store.get_run(str(run["run_id"])) or run
        completed = _completed_attempts(current)
        attempt_id = str(attempt.get("attempt_id") or "")
        if not any(str(candidate.get("attempt_id") or "") == attempt_id for candidate in completed):
            completed.append(
                _complete_attempt(
                    {**attempt, "sanitized_error": reason, "retryable": retryable},
                    state=state,
                    events=_events_from_payload(payload),
                    thread_id=str(payload.get("thread_id") or ""),
                )
            )
        self.store.merge_run_payload(
            str(run["run_id"]),
            {"active_attempt": {}, "active_attempts": [], "completed_attempts": completed, "last_plan_attempt": attempt},
        )

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

__all__ = ["ConductorManagedRunDriver"]
