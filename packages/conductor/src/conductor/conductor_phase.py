from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from typing import Any
from uuid import uuid4

from performer_api.phase import PhaseAdvanceResult, RunPhase


class RunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    WAITING = "waiting"
    COMPLETED = "completed"
    FAILED = "failed"


TERMINAL_PHASES = {RunPhase.DONE, RunPhase.FAILED}


@dataclass(frozen=True)
class OrchestrationRun:
    run_id: str
    instance_id: str
    issue_id: str
    issue_identifier: str | None
    phase: RunPhase
    status: str
    attempt: int = 1
    workflow_profile: str | None = None
    dispatch_id: str | None = None
    request_path: str | None = None
    result_path: str | None = None
    workspace_path: str | None = None
    ops_snapshot_path: str | None = None
    human_action: dict[str, Any] = field(default_factory=dict)
    human_response: str | None = None
    last_reason: str | None = None
    last_error: str | None = None
    process_pid: int | None = None
    crash_count: int = 0
    retry_count: int = 0
    init_failure_count: int = 0
    overload_count: int = 0
    next_run_at: str | None = None
    ack_status: str | None = None
    acked_at: str | None = None
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["phase"] = self.phase.value
        payload["human_action"] = dict(self.human_action)
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> OrchestrationRun:
        return cls(
            run_id=str(payload.get("run_id") or ""),
            instance_id=str(payload.get("instance_id") or ""),
            issue_id=str(payload.get("issue_id") or ""),
            issue_identifier=_optional_str(payload.get("issue_identifier")),
            phase=RunPhase(str(payload.get("phase") or RunPhase.QUEUED.value)),
            status=str(payload.get("status") or RunStatus.QUEUED.value),
            attempt=_int(payload.get("attempt"), default=1),
            workflow_profile=_optional_str(payload.get("workflow_profile")),
            dispatch_id=_optional_str(payload.get("dispatch_id")),
            request_path=_optional_str(payload.get("request_path")),
            result_path=_optional_str(payload.get("result_path")),
            workspace_path=_optional_str(payload.get("workspace_path")),
            ops_snapshot_path=_optional_str(payload.get("ops_snapshot_path")),
            human_action=dict(payload.get("human_action") or {}),
            human_response=_optional_str(payload.get("human_response")),
            last_reason=_optional_str(payload.get("last_reason")),
            last_error=_optional_str(payload.get("last_error")),
            process_pid=_optional_int(payload.get("process_pid")),
            crash_count=_int(payload.get("crash_count"), default=0),
            retry_count=_int(payload.get("retry_count"), default=0),
            init_failure_count=_int(payload.get("init_failure_count"), default=0),
            overload_count=_int(payload.get("overload_count"), default=0),
            next_run_at=_optional_str(payload.get("next_run_at")),
            ack_status=_optional_str(payload.get("ack_status")),
            acked_at=_optional_str(payload.get("acked_at")),
            created_at=str(payload.get("created_at") or ""),
            updated_at=str(payload.get("updated_at") or ""),
        )


@dataclass(frozen=True)
class OrchestrationEvent:
    event_id: str
    run_id: str
    instance_id: str
    issue_id: str
    event_type: str
    from_phase: RunPhase | None
    to_phase: RunPhase | None
    reason: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    created_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["from_phase"] = self.from_phase.value if self.from_phase is not None else None
        payload["to_phase"] = self.to_phase.value if self.to_phase is not None else None
        payload["payload"] = dict(self.payload)
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> OrchestrationEvent:
        return cls(
            event_id=str(payload.get("event_id") or ""),
            run_id=str(payload.get("run_id") or ""),
            instance_id=str(payload.get("instance_id") or ""),
            issue_id=str(payload.get("issue_id") or ""),
            event_type=str(payload.get("event_type") or ""),
            from_phase=_optional_phase(payload.get("from_phase")),
            to_phase=_optional_phase(payload.get("to_phase")),
            reason=_optional_str(payload.get("reason")),
            payload=dict(payload.get("payload") or {}),
            created_at=str(payload.get("created_at") or ""),
        )


class PhaseTransitionError(ValueError):
    pass


class PhaseReducer:
    def __init__(self, store: Any, *, crash_limit: int = 3, init_failure_limit: int = 5, overload_limit: int = 5):
        self.store = store
        self.crash_limit = crash_limit
        self.init_failure_limit = init_failure_limit
        self.overload_limit = overload_limit

    def dispatch_received(
        self,
        *,
        instance_id: str,
        issue_id: str,
        issue_identifier: str | None,
        workflow_profile: str | None,
        dispatch_id: str | None,
    ) -> OrchestrationRun:
        return self.store.upsert_orchestration_run(
            instance_id=instance_id,
            issue_id=issue_id,
            issue_identifier=issue_identifier,
            workflow_profile=workflow_profile,
            dispatch_id=dispatch_id,
        )

    def performer_started(
        self,
        run_id: str,
        *,
        request_path: str,
        result_path: str,
        pid: int | None = None,
    ) -> OrchestrationRun:
        run = self._require_run(run_id)
        if run.phase not in {RunPhase.QUEUED, RunPhase.REWORKING, RunPhase.REVIEWING}:
            raise PhaseTransitionError(f"Cannot start Performer from phase {run.phase.value}")
        started_phase = RunPhase.REVIEWING if run.phase is RunPhase.REVIEWING else RunPhase.IMPLEMENTING
        return self.store.apply_event(
            run.run_id,
            {
                "event_type": "performer.started",
                "to_phase": started_phase,
                "payload": {
                    "status": RunStatus.RUNNING,
                    "request_path": request_path,
                    "result_path": result_path,
                    "process_pid": pid,
                    "next_run_at": None,
                    "last_error": None,
                },
            },
        )

    def performer_result(
        self,
        result: PhaseAdvanceResult,
        *,
        now: datetime | None = None,
    ) -> OrchestrationRun:
        run = self._require_run(result.run_id)
        if run.phase not in {RunPhase.IMPLEMENTING, RunPhase.REWORKING, RunPhase.REVIEWING}:
            raise PhaseTransitionError(f"Cannot apply Performer result from phase {run.phase.value}")
        if result.issue_id and result.issue_id != run.issue_id:
            raise PhaseTransitionError("Result issue_id does not match run")
        timestamp = now or _now()
        updates: dict[str, Any] = {
            "phase": result.next_phase,
            "last_reason": result.reason,
            "last_error": result.detail,
            "workspace_path": result.workspace_path or run.workspace_path,
            "ops_snapshot_path": result.ops_snapshot_path or run.ops_snapshot_path,
            "process_pid": None,
        }
        if result.next_phase is RunPhase.DONE:
            updates["status"] = RunStatus.COMPLETED
            updates["ack_status"] = "pending"
        elif result.next_phase is RunPhase.FAILED:
            updates["status"] = RunStatus.FAILED
            updates["ack_status"] = "pending"
            updates["last_error"] = result.detail or result.reason
        elif result.next_phase is RunPhase.AWAITING_HUMAN:
            updates["status"] = RunStatus.WAITING
            updates["human_action"] = result.human_action or {}
        elif result.next_phase in {RunPhase.REVIEWING, RunPhase.REWORKING}:
            updates["status"] = RunStatus.QUEUED
        elif result.next_phase is RunPhase.QUEUED:
            if result.status == "init_failed":
                init_failure_count = run.init_failure_count + 1
                updates["attempt"] = run.attempt + 1
                updates["init_failure_count"] = init_failure_count
                updates["last_error"] = result.detail or result.reason
                if _is_terminal_init_failure(result.reason):
                    updates["phase"] = RunPhase.FAILED
                    updates["status"] = RunStatus.FAILED
                    updates["last_error"] = result.detail or result.reason
                    updates["ack_status"] = "pending"
                    updates["next_run_at"] = None
                    to_phase = RunPhase.FAILED
                elif init_failure_count > self.init_failure_limit:
                    updates["phase"] = RunPhase.FAILED
                    updates["status"] = RunStatus.FAILED
                    updates["last_error"] = "codex init failed repeatedly"
                    updates["ack_status"] = "pending"
                    updates["next_run_at"] = None
                    to_phase = RunPhase.FAILED
                else:
                    delay = max(result.retry_delay_seconds or 0, _init_failure_delay_seconds(init_failure_count))
                    updates["status"] = RunStatus.QUEUED
                    updates["next_run_at"] = _iso(timestamp + timedelta(seconds=delay))
                    to_phase = RunPhase.QUEUED
                return self.store.apply_event(
                    run.run_id,
                    {
                        "event_type": "performer.init_failed",
                        "to_phase": to_phase,
                        "reason": result.reason,
                        "payload": {
                            **result.to_dict(),
                            **updates,
                            "run_status": updates.get("status"),
                            "status": result.status,
                            "init_failure_count": init_failure_count,
                            "init_failure_limit": self.init_failure_limit,
                        },
                    },
                )
            elif result.status == "upstream_overloaded":
                overload_count = run.overload_count + 1
                updates["attempt"] = run.attempt + 1
                updates["overload_count"] = overload_count
                updates["last_error"] = result.detail or result.reason
                if overload_count > self.overload_limit:
                    updates["phase"] = RunPhase.FAILED
                    updates["status"] = RunStatus.FAILED
                    updates["last_error"] = "upstream overload exhausted repeatedly"
                    updates["ack_status"] = "pending"
                    updates["next_run_at"] = None
                    to_phase = RunPhase.FAILED
                else:
                    delay = max(result.retry_delay_seconds or 0, _init_failure_delay_seconds(overload_count))
                    updates["status"] = RunStatus.QUEUED
                    updates["next_run_at"] = _iso(timestamp + timedelta(seconds=delay))
                    to_phase = RunPhase.QUEUED
                return self.store.apply_event(
                    run.run_id,
                    {
                        "event_type": "performer.upstream_overloaded",
                        "to_phase": to_phase,
                        "reason": result.reason,
                        "payload": {
                            **result.to_dict(),
                            **updates,
                            "run_status": updates.get("status"),
                            "status": result.status,
                            "overload_count": overload_count,
                            "overload_limit": self.overload_limit,
                        },
                    },
                )
            else:
                delay = max(result.retry_delay_seconds or 0, 5)
                if result.reason == "already_running_or_claimed":
                    delay = max(delay, 30)
                updates["status"] = RunStatus.QUEUED
                updates["attempt"] = run.attempt + 1
                updates["retry_count"] = run.retry_count + 1
                updates["next_run_at"] = _iso(timestamp + timedelta(seconds=delay))
        else:
            raise PhaseTransitionError(f"Unsupported result phase {result.next_phase.value}")
        return self.store.apply_event(
            run.run_id,
            {
                "event_type": "performer.result",
                "to_phase": result.next_phase,
                "reason": result.reason,
                "payload": {**result.to_dict(), **updates, "run_status": updates.get("status"), "status": result.status},
            },
        )

    def human_completed(self, run_id: str, *, human_response: str) -> OrchestrationRun:
        run = self._require_run(run_id)
        if run.phase is not RunPhase.AWAITING_HUMAN:
            raise PhaseTransitionError(f"Cannot resume human response from phase {run.phase.value}")
        return self.store.apply_event(
            run.run_id,
            {
                "event_type": "human.completed",
                "to_phase": RunPhase.QUEUED,
                "payload": {
                    "phase": RunPhase.QUEUED,
                    "status": RunStatus.QUEUED,
                    "human_response": human_response,
                    "next_run_at": None,
                },
            },
        )

    def performer_crashed(
        self,
        run_id: str,
        *,
        exit_code: int | None,
        now: datetime | None = None,
    ) -> OrchestrationRun:
        run = self._require_run(run_id)
        if run.phase not in {RunPhase.IMPLEMENTING, RunPhase.REWORKING, RunPhase.REVIEWING}:
            raise PhaseTransitionError(f"Cannot crash run from phase {run.phase.value}")
        timestamp = now or _now()
        crash_count = run.crash_count + 1
        if crash_count > self.crash_limit:
            updates = {
                "phase": RunPhase.FAILED,
                "status": RunStatus.FAILED,
                "crash_count": crash_count,
                "process_pid": None,
                "last_error": f"performer crashed more than {self.crash_limit} times",
                "ack_status": "pending",
                "next_run_at": None,
            }
            to_phase = RunPhase.FAILED
        else:
            delay_seconds = min(5 * (2 ** (crash_count - 1)), 60)
            updates = {
                "phase": RunPhase.QUEUED,
                "status": RunStatus.QUEUED,
                "crash_count": crash_count,
                "process_pid": None,
                "last_error": f"performer exited with code {exit_code}",
                "next_run_at": _iso(timestamp + timedelta(seconds=delay_seconds)),
            }
            to_phase = RunPhase.QUEUED
        return self.store.apply_event(
            run.run_id,
            {
                "event_type": "performer.crashed",
                "to_phase": to_phase,
                "reason": f"exit_code={exit_code}",
                "payload": {"exit_code": exit_code, **updates},
            },
        )

    def acked(self, run_id: str) -> OrchestrationRun:
        run = self._require_run(run_id)
        return self.store.apply_event(
            run_id,
            {
                "event_type": "dispatch.acked",
                "to_phase": run.phase,
                "payload": {"ack_status": "acked", "acked_at": _iso(_now())},
            },
        )

    def _require_run(self, run_id: str) -> OrchestrationRun:
        run = self.store.get_orchestration_run(run_id)
        if run is None:
            raise PhaseTransitionError(f"Run not found: {run_id}")
        return run

def new_run(
    *,
    run_id: str | None = None,
    instance_id: str,
    issue_id: str,
    issue_identifier: str | None,
    workflow_profile: str | None,
    dispatch_id: str | None,
    now: str,
) -> OrchestrationRun:
    return OrchestrationRun(
        run_id=run_id or f"run-{uuid4().hex}",
        instance_id=instance_id,
        issue_id=issue_id,
        issue_identifier=issue_identifier,
        phase=RunPhase.QUEUED,
        status=RunStatus.QUEUED.value,
        workflow_profile=workflow_profile,
        dispatch_id=dispatch_id,
        created_at=now,
        updated_at=now,
    )


def with_updates(run: OrchestrationRun, **changes: Any) -> OrchestrationRun:
    normalized = dict(changes)
    if "phase" in normalized and not isinstance(normalized["phase"], RunPhase):
        normalized["phase"] = RunPhase(str(normalized["phase"]))
    if "status" in normalized and isinstance(normalized["status"], RunStatus):
        normalized["status"] = normalized["status"].value
    return replace(run, **normalized)


def _optional_phase(value: Any) -> RunPhase | None:
    if value is None:
        return None
    text = str(value)
    return RunPhase(text) if text else None


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _optional_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _int(value: Any, *, default: int) -> int:
    if isinstance(value, bool):
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _init_failure_delay_seconds(count: int) -> int:
    return min(5 * (2 ** (max(1, count) - 1)), 60)


def _is_terminal_init_failure(reason: str | None) -> bool:
    return reason in {
        "codex_sdk_not_installed",
        "invalid_sdk_codex_bin",
        "invalid_workspace_cwd",
        "sdk_missing_thread_start",
        "sdk_missing_thread_resume",
        "unsupported_sdk_worker_host",
    }
