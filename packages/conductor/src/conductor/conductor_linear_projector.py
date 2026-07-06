from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from performer_api.labels import PHASE_LABELS
from performer_api.phase import RunPhase


LINEAR_PROJECTION_MAX_FAILURES = 3
LINEAR_PROJECTION_BACKOFF_BASE_SECONDS = 30
LINEAR_PROJECTION_BACKOFF_MAX_SECONDS = 600


class LinearProjector:
    def __init__(
        self,
        *,
        store: Any,
        get_instance: Callable[[str], Any],
        tracker_factory: Callable[[Any], Any],
    ):
        self.store = store
        self.get_instance = get_instance
        self.tracker_factory = tracker_factory

    async def reconcile_once(self, *, now: str | None = None) -> int:
        now_dt = _parse_iso(now) or datetime.now(timezone.utc)
        now_iso = _iso(now_dt)
        projected = 0
        for run in self.store.list_orchestration_runs():
            if run.phase in {RunPhase.DONE, RunPhase.FAILED} and run.ack_status == "acked":
                continue
            desired = desired_linear_phase_projection(run.phase)
            if desired is None:
                continue
            event_type = linear_projection_event_type(run.phase)
            retry_state = self._retry_state(run.run_id, desired, now=now_iso)
            if retry_state["blocked"]:
                continue
            instance = self.get_instance(run.instance_id)
            if instance is None:
                continue
            tracker = self.tracker_factory(instance)
            if self._projection_recorded(run.run_id, event_type, desired):
                projection_matches = getattr(tracker, "issue_phase_projection_matches", None)
                if not callable(projection_matches):
                    continue
                try:
                    matches = await projection_matches(
                        run.issue_id,
                        phase_label=desired["phase_label"],
                        state_name=desired.get("state_name"),
                    )
                except Exception as exc:
                    self._record_failure(
                        run,
                        desired,
                        error=_safe_linear_value(exc),
                        event_type="linear.phase_projection_check_failed",
                        failure_count=int(retry_state["failure_count"]) + 1,
                        now=now_dt,
                    )
                    continue
                if matches:
                    continue
            project_issue_phase = getattr(tracker, "project_issue_phase", None)
            if not callable(project_issue_phase):
                continue
            try:
                result = await project_issue_phase(
                    run.issue_id,
                    phase_label=desired["phase_label"],
                    state_name=desired.get("state_name"),
                )
            except Exception as exc:
                self._record_failure(
                    run,
                    desired,
                    error=_safe_linear_value(exc),
                    event_type="linear.phase_projection_failed",
                    failure_count=int(retry_state["failure_count"]) + 1,
                    now=now_dt,
                )
                continue
            self.store.apply_event(
                run.run_id,
                {
                    "event_type": event_type,
                    "to_phase": run.phase,
                    "payload": {
                        **desired,
                        "result": result if isinstance(result, dict) else {},
                    },
                },
                expected_current_phases={run.phase},
            )
            projected += 1
        return projected

    def _retry_state(self, run_id: str, desired: dict[str, str | None], *, now: str) -> dict[str, Any]:
        for event in reversed(self.store.list_orchestration_events(run_id)):
            if event.event_type not in {
                "linear.phase_projection_failed",
                "linear.phase_projection_check_failed",
                "linear.phase_projection_escalated",
            }:
                continue
            if event.payload.get("phase_label") != desired.get("phase_label"):
                continue
            if event.payload.get("state_name") != desired.get("state_name"):
                continue
            if event.event_type == "linear.phase_projection_escalated":
                return {"blocked": True, "failure_count": event.payload.get("failure_count", 0)}
            next_run_at = str(event.payload.get("next_run_at") or "")
            if next_run_at and next_run_at > now:
                return {"blocked": True, "failure_count": event.payload.get("failure_count", 0)}
            return {"blocked": False, "failure_count": event.payload.get("failure_count", 0)}
        return {"blocked": False, "failure_count": 0}

    def _record_failure(
        self,
        run: Any,
        desired: dict[str, str | None],
        *,
        error: str,
        event_type: str,
        failure_count: int,
        now: datetime,
    ) -> None:
        if failure_count > LINEAR_PROJECTION_MAX_FAILURES:
            self.store.apply_event(
                run.run_id,
                {
                    "event_type": "linear.phase_projection_escalated",
                    "to_phase": RunPhase.FAILED,
                    "reason": "linear_phase_projection_failed",
                    "payload": {
                        **desired,
                        "phase": RunPhase.FAILED,
                        "status": "failed",
                        "last_reason": "linear_phase_projection_failed",
                        "last_error": error,
                        "process_pid": None,
                        "next_run_at": None,
                        "ack_status": "pending",
                        "failure_count": failure_count,
                        "max_failures": LINEAR_PROJECTION_MAX_FAILURES,
                    },
                },
                expected_current_phases={run.phase},
            )
            return
        delay = min(
            LINEAR_PROJECTION_BACKOFF_BASE_SECONDS * (2 ** (failure_count - 1)),
            LINEAR_PROJECTION_BACKOFF_MAX_SECONDS,
        )
        self.store.apply_event(
            run.run_id,
            {
                "event_type": event_type,
                "to_phase": run.phase,
                "payload": {
                    **desired,
                    "error": error,
                    "failure_count": failure_count,
                    "max_failures": LINEAR_PROJECTION_MAX_FAILURES,
                    "next_run_at": _iso(now + timedelta(seconds=delay)),
                },
            },
            expected_current_phases={run.phase},
        )

    def _projection_recorded(self, run_id: str, event_type: str, desired: dict[str, str | None]) -> bool:
        for event in reversed(self.store.list_orchestration_events(run_id)):
            if event.event_type != event_type:
                continue
            if event.payload.get("phase_label") == desired.get("phase_label") and event.payload.get("state_name") == desired.get("state_name"):
                return True
        return False


def desired_linear_phase_projection(phase: RunPhase) -> dict[str, str | None] | None:
    if phase is RunPhase.QUEUED:
        return {"phase_label": PHASE_LABELS["queued"], "state_name": "Todo"}
    if phase in {RunPhase.IMPLEMENTING, RunPhase.REWORKING}:
        return {"phase_label": PHASE_LABELS["implementation_running"], "state_name": "In Progress"}
    if phase is RunPhase.AWAITING_HUMAN:
        return {"phase_label": PHASE_LABELS["blocked"], "state_name": "In Progress"}
    if phase is RunPhase.REVIEWING:
        return {"phase_label": PHASE_LABELS["review_running"], "state_name": "In Review"}
    if phase is RunPhase.DONE:
        return {"phase_label": PHASE_LABELS["completed"], "state_name": "Done"}
    if phase is RunPhase.FAILED:
        return {"phase_label": PHASE_LABELS["failed"], "state_name": "In Progress"}
    return None


def linear_projection_event_type(phase: RunPhase) -> str:
    if phase is RunPhase.REVIEWING:
        return "linear.projected_review_state"
    return "linear.projected_phase"


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_linear_value(value: Any) -> str:
    text = str(value).replace("\r", " ").replace("\n", " ").strip()
    for marker in ("Bearer ", "token=", "access_token=", "refresh_token=", "api_key="):
        if marker in text:
            text = text.split(marker, 1)[0] + marker + "[redacted]"
    return text[:500]
