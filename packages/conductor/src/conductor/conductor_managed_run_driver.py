from __future__ import annotations

from pathlib import Path
from typing import Any

from performer_api.managed_runs import ManagedRunPlan, ManagedRunState, ManagedRunRuntimeRole, RuntimeConfigEnvelope, WorkItem, WorkItemResult

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
    _role_capacity,
    _run_verification_command,
    _sanitize,
    _write_json,
)
from .conductor_managed_run_store import ConductorManagedRunStore
from .conductor_models import InstanceRecord
from .runtime_backends import prepare_backend_environment



async def drive_managed_run_runs_once(service: Any) -> dict[str, int]:
    driver = ConductorManagedRunDriver(
        store=service.managed_run_store,
        coordinator=service.managed_run_coordinator,
        runtime_manager=service.runtime_manager,
        instance_lookup=service.store.get_instance,
        instance_update=service.store.update_instance,
        runtime_config=service._managed_run_runtime_config,
    )
    return await driver.drive_once()


class ConductorManagedRunDriver:
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
            return self._collect_work_item_turn(run)
        if state == ManagedRunState.QUEUED.value:
            return await self._start_plan_turn(run, instance)
        if state == ManagedRunState.PLANNING.value:
            if not _active_attempt(run):
                return await self._start_plan_turn(run, instance)
            return self._collect_plan_turn(run)
        if state == ManagedRunState.READY.value:
            return await self._start_or_checkpoint_next_work_item(run, instance)
        if state == ManagedRunState.EXECUTING.value:
            return self._collect_work_item_turn(run)
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
        attempt = _attempt_paths(instance, str(run["run_id"]), "plan", "plan")
        if attempt["result_path"].exists():
            attempt["result_path"].unlink()
        _write_json(
            attempt["request_path"],
            {
                "turn_kind": "plan",
                "workspace_path": instance.resolved_repo_path,
                "issue_description": _issue_description(run),
                "thread_id": run.get("backend_session_id") or None,
            },
        )
        env = prepare_backend_environment(
            Path(instance.instance_dir) / "state",
            envelope.profiles.get(ManagedRunRuntimeRole.PLAN),
            workspace_path=instance.resolved_repo_path,
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
        self.store.merge_run_payload(str(run["run_id"]), {"active_attempt": _attempt_payload(attempt, "plan")})
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
        try:
            payload = _read_json(result_path)
            plan_payload = payload.get("plan")
            if not isinstance(plan_payload, dict):
                raise ValueError("plan_result_missing")
            version = self.coordinator.apply_plan(
                str(run["run_id"]),
                ManagedRunPlan.from_dict(plan_payload),
                backend_session_id=str(payload.get("thread_id") or ""),
            )
        except Exception as exc:
            self.store.update_run_state(str(run["run_id"]), ManagedRunState.FAILED, reason=f"plan_result_failed:{_sanitize(exc)}")
            return {"failed": 1}
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

    async def _start_or_checkpoint_next_work_item(self, run: dict[str, Any], instance: InstanceRecord) -> dict[str, int]:
        checkpoint = self.coordinator.run_pending_checkpoint(str(run["run_id"]), workspace_path=Path(instance.resolved_repo_path))
        if checkpoint is not None and not checkpoint.get("passed"):
            return {"failed": 1}
        envelope = self._runtime_config_or_fail(str(run["run_id"]))
        if envelope is None:
            return {"failed": 1}
        limit = _role_capacity(envelope, ManagedRunRuntimeRole.WORK_ITEM)
        started = 0
        while started < limit:
            item = self.coordinator.next_ready_work_item(str(run["run_id"]))
            if item is None:
                break
            await self._start_work_item_turn(run, instance, item, envelope=envelope)
            started += 1
            refreshed = self.store.get_run(str(run["run_id"]))
            if refreshed is not None:
                run = refreshed
        return {"started": started} if started else {}

    async def _start_work_item_turn(self, run: dict[str, Any], instance: InstanceRecord, item: dict[str, Any], *, envelope: RuntimeConfigEnvelope) -> dict[str, int]:
        started_item = self.coordinator.start_work_item(str(run["run_id"]), str(item["work_item_id"]))
        attempt = _attempt_paths(instance, str(run["run_id"]), "work-item", str(item["work_item_id"]))
        if attempt["result_path"].exists():
            attempt["result_path"].unlink()
        _write_json(
            attempt["request_path"],
            {
                "turn_kind": "work_item",
                "workspace_path": instance.resolved_repo_path,
                "thread_id": run.get("backend_session_id") or "",
                "work_item": started_item.get("payload") or item.get("payload") or {},
            },
        )
        env = prepare_backend_environment(
            Path(instance.instance_dir) / "state",
            envelope.profiles.get(ManagedRunRuntimeRole.WORK_ITEM),
            workspace_path=instance.resolved_repo_path,
            home_scope=attempt["attempt_id"],
        )
        started = await self.runtime_manager.start(
            instance,
            env=env,
            mode="execute",
            attempt_id=attempt["attempt_id"],
            attempt_request_path=str(attempt["request_path"]),
            attempt_result_path=str(attempt["result_path"]),
            lease_id=attempt["attempt_id"],
        )
        self.instance_update(started)
        attempt_payload = _attempt_payload(attempt, "work_item", work_item_id=str(item["work_item_id"]))
        active_attempts = _active_attempts(self.store.get_run(str(run["run_id"])) or run)
        self.store.merge_run_payload(str(run["run_id"]), {"active_attempt": attempt_payload, "active_attempts": [*active_attempts, attempt_payload]})
        return {"started": 1}

    def _collect_work_item_turn(self, run: dict[str, Any]) -> dict[str, int]:
        attempts = _active_attempts(run, kind="work_item")
        if not attempts:
            self.store.update_run_state(str(run["run_id"]), ManagedRunState.FAILED, reason="work_item_attempt_missing")
            return {"failed": 1}
        applied = 0
        remaining: list[dict[str, Any]] = []
        completed = _completed_attempts(run)
        for attempt in attempts:
            result_path = Path(str(attempt.get("result_path") or ""))
            if not result_path.exists():
                exited = self._active_attempt_exit(run, attempt)
                if exited is not None:
                    self._fail_missing_turn_result(str(run["run_id"]), attempt, exited, "work_item")
                    return {"failed": 1}
                remaining.append(attempt)
                continue
            try:
                payload = _read_json(result_path)
                result_payload = payload.get("result")
                if not isinstance(result_payload, dict):
                    raise ValueError("work_item_result_missing")
                submitted = self.coordinator.submit_work_item_result(str(run["run_id"]), WorkItemResult.from_dict(result_payload))
            except Exception as exc:
                self.store.update_run_state(str(run["run_id"]), ManagedRunState.FAILED, reason=f"work_item_result_failed:{_sanitize(exc)}")
                return {"failed": 1}
            applied += 1
            completed.append(_complete_attempt(attempt, state="succeeded", events=_events_from_payload(payload), thread_id=str(payload.get("thread_id") or "")))
            if submitted.get("state") == "blocked":
                self.store.merge_run_payload(str(run["run_id"]), {"completed_attempts": completed, "last_work_item_attempt": attempt})
                return {"applied": applied, "failed": 1}
        self.store.merge_run_payload(
            str(run["run_id"]),
            {
                "active_attempt": remaining[-1] if remaining else {},
                "active_attempts": remaining,
                "completed_attempts": completed,
                "last_work_item_attempt": attempts[-1],
            },
        )
        return {"applied": applied} if applied else {}

    def _verify_active_work_item(self, run: dict[str, Any], instance: InstanceRecord) -> dict[str, int]:
        items = [row for row in self.store.list_work_items(str(run["run_id"])) if row["state"] == "in_review" and isinstance(row.get("result"), dict)]
        if not items:
            return {}
        applied = 0
        for item in items:
            result = WorkItemResult.from_dict(item["result"])
            for command in WorkItem.from_dict(item["payload"]).verification.green_commands:
                if command not in result.tests.get("green_commands_run", []):
                    self.coordinator.verify_work_item(str(run["run_id"]), str(item["work_item_id"]), gate_status=f"verification missing:{command}", passed=False)
                    return {"failed": 1}
                failure = _run_verification_command(command, workspace_path=Path(instance.resolved_repo_path))
                if failure:
                    self.coordinator.verify_work_item(str(run["run_id"]), str(item["work_item_id"]), gate_status=failure, passed=False)
                    return {"failed": 1}
            self.coordinator.verify_work_item(str(run["run_id"]), str(item["work_item_id"]), gate_status="verification passed")
            applied += 1
        self.coordinator.run_pending_checkpoint(str(run["run_id"]), workspace_path=Path(instance.resolved_repo_path))
        return {"applied": applied}

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
        self.store.merge_run_payload(run_id, {"last_failed_attempt": {**attempt, "exit": exited, "reason": reason}})



__all__ = ["ConductorManagedRunDriver", "drive_managed_run_runs_once"]
