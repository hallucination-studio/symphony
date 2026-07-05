from __future__ import annotations

from typing import Any, Callable

from performer_api.models import normalize_state_key
from performer_api.phase import RunPhase

from .conductor_phase import PhaseTransitionError


HUMAN_ACTION_LABEL = "performer:type/human-action"
HUMAN_RESPONSE_MARKER_NAME = "SYMPHONY HUMAN RESPONSE"


class PhaseHumanActionCoordinator:
    def __init__(
        self,
        *,
        store: Any,
        phase_reducer: Any,
        managed_mode_enabled: Callable[[], bool],
        tracker_factory: Callable[[Any], Any],
    ):
        self.store = store
        self.phase_reducer = phase_reducer
        self.managed_mode_enabled = managed_mode_enabled
        self.tracker_factory = tracker_factory

    async def coordinate(self) -> dict[str, int]:
        if self.managed_mode_enabled():
            return {"completed": 0, "missing_response": 0, "failed": 0}
        completed = 0
        missing_response = 0
        failed = 0
        for run in self.store.list_orchestration_runs(phases={RunPhase.AWAITING_HUMAN}):
            instance = self.store.get_instance(run.instance_id)
            if instance is None:
                continue
            tracker = self.tracker_factory(instance)
            fetch_children = getattr(tracker, "fetch_child_issues", None)
            if not callable(fetch_children):
                continue
            try:
                children = await fetch_children(run.issue_id, label_name=HUMAN_ACTION_LABEL)
            except Exception:
                failed += 1
                continue
            child = find_phase_human_child(run.human_action, children)
            if child is None or not linear_issue_is_done(child):
                continue
            response = human_response_from_child(child)
            child_issue_id = str(child.get("id") or run.human_action.get("child_issue_id") or "")
            if phase_human_action_requires_response(run.human_action) and not response:
                missing_response += 1
                if not self.event_recorded(
                    run.run_id,
                    "human.response_missing",
                    child_issue_id=child_issue_id,
                ):
                    await comment_missing_phase_human_response(tracker, child_issue_id)
                    self.store.apply_event(
                        run.run_id,
                        {
                            "event_type": "human.response_missing",
                            "to_phase": run.phase,
                            "reason": "missing_human_response",
                            "payload": {
                                "child_issue_id": child_issue_id,
                                "child_identifier": child.get("identifier") or run.human_action.get("child_identifier"),
                            },
                        },
                    )
                continue
            human_response = response or "Human action completed."
            await write_phase_human_response_to_parent(
                tracker,
                run,
                child=child,
                human_response=human_response,
            )
            try:
                self.phase_reducer.human_completed(run.run_id, human_response=human_response)
            except PhaseTransitionError:
                failed += 1
                continue
            completed += 1
        return {"completed": completed, "missing_response": missing_response, "failed": failed}

    def event_recorded(self, run_id: str, event_type: str, *, child_issue_id: str) -> bool:
        for event in self.store.list_orchestration_events(run_id):
            if event.event_type != event_type:
                continue
            if not child_issue_id or str(event.payload.get("child_issue_id") or "") == child_issue_id:
                return True
        return False


async def comment_missing_phase_human_response(tracker: Any, child_issue_id: str) -> None:
    if not child_issue_id:
        return
    comment_issue = getattr(tracker, "comment_issue", None)
    if not callable(comment_issue):
        return
    await comment_issue(
        child_issue_id,
        "This human action is marked Done, but the `Human response` section is empty. Add the response there, then keep this child issue in Done.",
    )


async def write_phase_human_response_to_parent(
    tracker: Any,
    run: Any,
    *,
    child: dict[str, Any],
    human_response: str,
) -> None:
    update_description = getattr(tracker, "update_issue_description_marker_block", None)
    if not callable(update_description):
        return
    block = "\n".join(
        [
            f"Human action: {child.get('identifier') or child.get('id') or run.human_action.get('child_identifier') or run.human_action.get('child_issue_id')}",
            f"Type: {run.human_action.get('kind') or 'human_action'}",
            "",
            human_response.strip(),
        ]
    )
    await update_description(run.issue_id, HUMAN_RESPONSE_MARKER_NAME, block)


def find_phase_human_child(human_action: dict[str, Any], children: list[dict[str, Any]]) -> dict[str, Any] | None:
    child_issue_id = str(human_action.get("child_issue_id") or "")
    child_identifier = str(human_action.get("child_identifier") or "")
    for child in children:
        if not isinstance(child, dict):
            continue
        if child_issue_id and str(child.get("id") or "") == child_issue_id:
            return child
        if child_identifier and str(child.get("identifier") or "") == child_identifier:
            return child
    return None


def linear_issue_is_done(issue: dict[str, Any]) -> bool:
    return normalize_state_key(str(issue.get("state") or "")) == "done" or str(issue.get("state_type") or "") == "completed"


def human_response_from_child(child: dict[str, Any]) -> str | None:
    description = str(child.get("description") or "")
    marker = "Human response:"
    if marker.lower() not in description.lower():
        return None
    lower = description.lower()
    start = lower.find(marker.lower())
    response = description[start + len(marker):]
    stop_markers = ["When finished,", "完成后", "Move this child issue"]
    for stop in stop_markers:
        index = response.lower().find(stop.lower())
        if index >= 0:
            response = response[:index]
    cleaned = response.strip()
    if not cleaned or cleaned == "(Add the answer or decision here when information is required.)":
        return None
    return cleaned


def phase_human_action_requires_response(human_action: dict[str, Any]) -> bool:
    return str(human_action.get("kind") or "") in {"preflight_needs_input", "codex_needs_input"}
