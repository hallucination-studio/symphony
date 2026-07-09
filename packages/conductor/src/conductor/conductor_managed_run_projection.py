from __future__ import annotations

from typing import Any

from performer_api.managed_runs import (
    ManagedRunState,
    ThreadCompletionReport,
    WorkItemState,
    render_run_summary_block,
)

from .conductor_managed_run_store import ConductorManagedRunStore


WORK_ITEM_LABEL = "symphony:type/work-item"


class ManagedRunLinearProjector:
    def __init__(
        self,
        *,
        store: ConductorManagedRunStore,
        tracker: Any,
        root_issue_id: str,
        delegate_id: str | None = None,
    ) -> None:
        self.store = store
        self.tracker = tracker
        self.root_issue_id = root_issue_id
        self.delegate_id = delegate_id

    async def reconcile_once(self, run_id: str) -> int:
        run = self.store.get_run(run_id)
        if run is None:
            return 0
        projected = 0
        projected += await self._project_parent_summary(run_id, run)
        existing = await self._existing_child_issues()
        existing_by_work_item = self._existing_by_work_item(run_id, existing)
        for item in self.store.list_work_items(run_id):
            work_item_id = str(item["work_item_id"])
            issue = existing_by_work_item.get(work_item_id)
            if issue is None:
                issue = await self.tracker.create_child_issue_for(
                    parent_issue_id=self.root_issue_id,
                    title=str(item["payload"].get("title") or work_item_id),
                    description=self._work_item_description(item),
                    label_names=[WORK_ITEM_LABEL],
                    delegate_id=self.delegate_id,
                )
                projected += 1
            issue_id = str(issue.get("id") or "")
            if not issue_id:
                raise RuntimeError(f"managed_run_projection_issue_missing_id run_id={run_id} work_item_id={work_item_id}")
            update_description = getattr(self.tracker, "update_issue_description_marker_block", None)
            if update_description is not None:
                await update_description(issue_id, "SYMPHONY WORK ITEM", self._work_item_description(item))
            transition = getattr(self.tracker, "transition_issue_by_state_target", None)
            if transition is not None:
                names, state_type = _linear_state_target(str(item["state"]))
                await transition(issue_id, names=names, state_type=state_type)
                projected += 1
            self.store.record_linear_projection(
                run_id,
                work_item_id,
                linear_issue_id=issue_id,
                metadata={
                    "run_id": run_id,
                    "work_item_id": work_item_id,
                    "state": item["state"],
                    "gate_status": item.get("gate_status") or "",
                },
            )
            projected += await self._project_attempt_comments(run_id, run, work_item_id, issue_id)
        if run.get("state") == ManagedRunState.VERIFIED.value:
            report = self._current_report(run_id, run)
            self.store.merge_run_payload(run_id, {"final_completion_report": report.to_dict()})
            self.store.update_run_state(run_id, ManagedRunState.DONE, reason="final summary projected")
        return projected

    async def project_parent_summary_once(self, run_id: str) -> None:
        run = self.store.get_run(run_id)
        if run is not None:
            await self._project_parent_summary(run_id, run)

    @staticmethod
    def render_parent_summary(report: ThreadCompletionReport) -> str:
        return render_run_summary_block(report)

    async def _project_parent_summary(self, run_id: str, run: dict[str, Any]) -> int:
        update_description = getattr(self.tracker, "update_issue_description_marker_block", None)
        if update_description is None:
            return 0
        report = self._current_report(run_id, run)
        await update_description(self.root_issue_id, "SYMPHONY RUN SUMMARY", render_run_summary_block(report))
        return 1

    def _current_report(self, run_id: str, run: dict[str, Any]) -> ThreadCompletionReport:
        items = self.store.list_work_items(run_id)
        files_changed: list[dict[str, Any]] = []
        what = [f"projected {len(items)} bounded work item{'s' if len(items) != 1 else ''}"]
        latest_reason = _summary_text(run.get("latest_reason"))
        if latest_reason:
            what.append(f"latest reason: {latest_reason}")
        what.extend(_projection_health_lines(run.get("payload") if isinstance(run.get("payload"), dict) else {}))
        for item in items:
            result = item.get("result") if isinstance(item.get("result"), dict) else {}
            for changed in result.get("changed_files") or []:
                if isinstance(changed, dict):
                    files_changed.append({**changed, "work_item_id": item["work_item_id"]})
        checkpoint_evidence = _checkpoint_evidence(self.store.list_checkpoint_results(run_id))
        plan = self.store.get_plan(run_id, int(run.get("plan_version") or 0)) if int(run.get("plan_version") or 0) else None
        complete = run.get("state") in {ManagedRunState.VERIFIED.value, ManagedRunState.DONE.value}
        return ThreadCompletionReport(
            status=str(run.get("state") or ManagedRunState.QUEUED.value),
            thread_id=str(run.get("backend_session_id") or ""),
            plan_version=int(run.get("plan_version") or 0),
            what_this_thread_did=what,
            files_changed=files_changed,
            rubric_results=_rubric_results(plan, items, checkpoint_evidence=checkpoint_evidence, complete=complete),
            token_usage=[],
            residual_risks=_residual_risks(plan, complete=complete),
        )

    async def _existing_child_issues(self) -> list[dict[str, Any]]:
        fetch = getattr(self.tracker, "fetch_child_issues", None)
        if fetch is None:
            return []
        loaded = await fetch(self.root_issue_id, label_name=WORK_ITEM_LABEL)
        return [dict(item) for item in loaded if isinstance(item, dict)]

    def _existing_by_work_item(self, run_id: str, existing: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        by_issue_id = {str(issue.get("id") or ""): issue for issue in existing}
        mapped: dict[str, dict[str, Any]] = {}
        for projection in self.store.list_linear_projections(run_id):
            issue = by_issue_id.get(str(projection.get("linear_issue_id") or ""))
            if issue is not None:
                mapped[str(projection.get("work_item_id") or "")] = issue
        return mapped

    def _work_item_description(self, item: dict[str, Any]) -> str:
        payload = item["payload"] if isinstance(item.get("payload"), dict) else {}
        parallel = payload.get("parallelization") if isinstance(payload.get("parallelization"), dict) else {}
        lines = [
            f"Objective: {payload.get('objective') or ''}",
            "",
            "Acceptance Criteria:",
            *[f"- {criterion}" for criterion in payload.get("acceptance_criteria") or []],
            "",
            "Likely Files:",
            *[f"- `{path}`" for path in payload.get("files_likely_touched") or []],
            "",
            "Verification:",
            f"- RED: {((payload.get('verification') or {}).get('red_command') if isinstance(payload.get('verification'), dict) else '')}",
            *[f"- GREEN: {command}" for command in ((payload.get("verification") or {}).get("green_commands") if isinstance(payload.get("verification"), dict) else [])],
            "",
            "Dependencies:",
            *[f"- {dependency}" for dependency in (payload.get("dependencies") or ["None"])],
            "",
            "Parallelization:",
            f"- safe_to_parallelize: {str(bool(parallel.get('safe_to_parallelize'))).lower()}",
            f"- reason: {parallel.get('reason') or ''}",
            "",
            "Managed Run State:",
            f"- state: {item.get('state')}",
            f"- gate: {item.get('gate_status') or 'pending'}",
        ]
        return "\n".join(lines)

    async def _project_attempt_comments(self, run_id: str, run: dict[str, Any], work_item_id: str, issue_id: str) -> int:
        comment_issue = getattr(self.tracker, "comment_issue", None)
        update_comment = getattr(self.tracker, "update_issue_comment", None)
        if not callable(comment_issue):
            return 0
        payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
        existing = payload.get("attempt_comment_projections") if isinstance(payload.get("attempt_comment_projections"), dict) else {}
        mappings = {str(key): dict(value) for key, value in existing.items() if isinstance(value, dict)}
        projected = 0
        for attempt in _attempts_for_work_item(payload, work_item_id):
            attempt_id = str(attempt.get("attempt_id") or "")
            if not attempt_id:
                continue
            body = _attempt_comment_body(attempt)
            current = mappings.get(attempt_id) or {}
            comment_id = str(current.get("linear_comment_id") or "")
            if comment_id and callable(update_comment):
                result = await update_comment(comment_id, body)
            elif comment_id:
                continue
            else:
                result = await comment_issue(issue_id, body)
            saved_comment_id = str(result.get("comment_id") or comment_id)
            if not saved_comment_id:
                raise RuntimeError(f"managed_run_attempt_comment_missing_id run_id={run_id} attempt_id={attempt_id}")
            mappings[attempt_id] = {
                "attempt_id": attempt_id,
                "work_item_id": work_item_id,
                "linear_issue_id": issue_id,
                "linear_comment_id": saved_comment_id,
                "updated_at": _summary_text(attempt.get("completed_at") or attempt.get("started_at")),
            }
            projected += 1
        if projected:
            self.store.merge_run_payload(run_id, {"attempt_comment_projections": mappings})
        return projected


def _linear_state_target(state: str) -> tuple[list[str], str]:
    if state == WorkItemState.TODO.value:
        return ["Todo"], "unstarted"
    if state == WorkItemState.IN_PROGRESS.value:
        return ["In Progress"], "started"
    if state == WorkItemState.IN_REVIEW.value:
        return ["In Review"], "started"
    if state == WorkItemState.DONE.value:
        return ["Done"], "completed"
    if state == WorkItemState.BLOCKED.value:
        return ["Blocked", "Needs More"], "unstarted"
    if state == WorkItemState.CANCELLED.value:
        return ["Canceled", "Cancelled"], "canceled"
    return ["Todo"], "unstarted"


def _rubric_results(plan: Any, items: list[dict[str, Any]], *, checkpoint_evidence: list[str] | None = None, complete: bool) -> list[dict[str, Any]]:
    evidence = [str(item.get("gate_status") or item.get("state") or "") for item in items] + list(checkpoint_evidence or [])
    rubric = getattr(plan, "verification_rubric", None)
    if rubric is None:
        return [{"area": "correctness", "status": "passed" if complete else "pending", "evidence": evidence}]
    results = []
    for area in ["correctness", "quality", "integration", "documentation", "ship_readiness"]:
        checks = list(getattr(rubric, area, []) or [])
        results.append(
            {
                "area": area,
                "status": "passed" if complete else "pending",
                "evidence": checks + evidence,
            }
        )
    return results


def _checkpoint_evidence(results: list[dict[str, Any]]) -> list[str]:
    evidence: list[str] = []
    for result in results:
        status = "checkpoint_passed" if result.get("passed") else "checkpoint_failed"
        after = ",".join(str(item) for item in result.get("after") or [])
        verify = " && ".join(str(item) for item in result.get("verify") or [])
        reason = str(result.get("reason") or "")
        evidence.append(f"{status}:{after}:{verify}:{reason}")
    return evidence


def _residual_risks(plan: Any, *, complete: bool) -> list[str]:
    risks: list[str] = []
    for risk in getattr(plan, "risks", []) or []:
        if isinstance(risk, dict):
            risks.append(str(risk.get("summary") or risk.get("risk") or risk))
        else:
            risks.append(str(risk))
    if not complete:
        return risks + ["Run is not complete."]
    return risks


def _summary_text(value: Any) -> str:
    return str(value or "").replace("\n", " ").replace("\r", " ").strip()[:300]


def _projection_health_lines(payload: dict[str, Any]) -> list[str]:
    if "projection_healthy" not in payload:
        return []
    healthy = bool(payload.get("projection_healthy"))
    lines = [f"projection_healthy: {str(healthy).lower()}"]
    last_success = _summary_text(payload.get("last_successful_projection_at"))
    if last_success:
        lines.append(f"last_successful_projection_at: {last_success}")
    error = payload.get("last_projection_error")
    if isinstance(error, dict) and error.get("sanitized_reason"):
        lines.append(f"last_projection_error: {_summary_text(error.get('sanitized_reason'))}")
    return lines


def _attempts_for_work_item(payload: dict[str, Any], work_item_id: str) -> list[dict[str, Any]]:
    attempts: list[dict[str, Any]] = []
    for key in ("completed_attempts", "active_attempts"):
        raw = payload.get(key)
        if isinstance(raw, list):
            attempts.extend(dict(item) for item in raw if isinstance(item, dict) and str(item.get("work_item_id") or "") == work_item_id)
    return attempts


def _attempt_comment_body(attempt: dict[str, Any]) -> str:
    events = attempt.get("events") if isinstance(attempt.get("events"), list) else []
    event_summaries = [_event_summary(event) for event in events if isinstance(event, dict)]
    lines = [
        "## Symphony Managed Run Attempt",
        "",
        f"- attempt_id: {_summary_text(attempt.get('attempt_id'))}",
        f"- turn_kind: {_summary_text(attempt.get('kind') or attempt.get('mode'))}",
        f"- attempt_state: {_summary_text(attempt.get('state') or 'running')}",
        f"- backend_thread_id: {_summary_text(attempt.get('thread_id')) or 'unavailable'}",
        f"- verify_score: {_summary_text(attempt.get('verify_score')) or 'unavailable'}",
        f"- sanitized_error: {_summary_text(attempt.get('sanitized_error') or attempt.get('reason')) or 'none'}",
        f"- request_path: `{_summary_text(attempt.get('request_path'))}`",
        f"- result_path: `{_summary_text(attempt.get('result_path'))}`",
        f"- started_at: {_summary_text(attempt.get('started_at'))}",
        f"- completed_at: {_summary_text(attempt.get('completed_at')) or 'pending'}",
        "",
        "### Evidence",
    ]
    lines.extend(f"- {summary}" for summary in (event_summaries or ["No event evidence recorded."]))
    return "\n".join(lines)


def _event_summary(event: dict[str, Any]) -> str:
    name = _summary_text(event.get("event") or event.get("type") or "event")
    message = _summary_text(event.get("message") or event.get("summary") or "")
    return f"{name}: {message}" if message else name


__all__ = ["ManagedRunLinearProjector", "WORK_ITEM_LABEL"]
