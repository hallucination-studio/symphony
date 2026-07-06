from __future__ import annotations

from typing import Any, Callable

from performer_api.phase import RunPhase


class DirectIngress:
    def __init__(
        self,
        *,
        store: Any,
        phase_reducer: Any,
        list_instances: Callable[[], list[Any]],
        get_instance: Callable[[str], Any],
        tracker_factory: Callable[[Any], Any],
    ):
        self.store = store
        self.phase_reducer = phase_reducer
        self.list_instances = list_instances
        self.get_instance = get_instance
        self.tracker_factory = tracker_factory

    async def poll(self) -> int:
        received = 0
        for instance in self.list_instances():
            refreshed = self.get_instance(instance.id) or instance
            if refreshed.process_status in {"running", "starting"}:
                continue
            tracker = self.tracker_factory(instance)
            fetch_candidates = getattr(tracker, "fetch_candidate_issues", None)
            if not callable(fetch_candidates):
                continue
            try:
                issues = await fetch_candidates()
            except Exception:
                continue
            for issue in issues:
                if _is_system_child_issue(issue):
                    continue
                issue_id = _issue_field(issue, "id")
                issue_identifier = _issue_field(issue, "identifier")
                if not issue_id and not issue_identifier:
                    continue
                existing = self.store.get_orchestration_run_by_issue(instance.id, issue_id or issue_identifier)
                if existing is not None and existing.phase not in {RunPhase.DONE, RunPhase.FAILED}:
                    continue
                self.phase_reducer.dispatch_received(
                    instance_id=instance.id,
                    issue_id=issue_id or issue_identifier,
                    issue_identifier=issue_identifier or None,
                    workflow_profile=instance.workflow_profile,
                    dispatch_id=None,
                    blocked_by=_blocked_by_issue_ids(issue.get("blocked_by")),
                    parent_issue_id=_optional_issue_ref(issue.get("parent_issue_id") or issue.get("parent")),
                )
                received += 1
        return received


def _issue_field(issue: dict[str, Any], key: str) -> str:
    value = issue.get(key)
    return str(value).strip() if value is not None else ""


def _optional_issue_ref(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    text = str(value or "").strip()
    return text or None


def _blocked_by_issue_ids(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    blocked_by: list[str] = []
    seen: set[str] = set()
    for blocker in value:
        candidate = blocker.get("id") if isinstance(blocker, dict) else getattr(blocker, "id", blocker)
        text = str(candidate or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        blocked_by.append(text)
    return blocked_by


def _is_system_child_issue(issue: dict[str, Any]) -> bool:
    labels = issue.get("labels")
    label_names = {str(label).lower() for label in labels} if isinstance(labels, list) else set()
    title = str(issue.get("title") or "").lower()
    return (
        "performer:type/human-action" in label_names
        or "performer:type/gate" in label_names
        or "performer:type/evidence" in label_names
        or title.startswith("[human action]")
    )
