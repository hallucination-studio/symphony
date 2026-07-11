from __future__ import annotations

from typing import Any

from .conductor_managed_run_projection_helpers import (
    attempt_comment_body,
    attempt_ids_for_work_item,
    attempts_for_work_item,
    checkpoint_evidence,
    last_synced_comment_ids,
    latest_attempt_id,
    linear_state_target,
    operator_wait_kind,
    parent_linear_state_target,
    projection_health_lines,
    residual_risks,
    rubric_results,
    summary_text,
)
from .conductor_managed_run_state import ManagedRunState
from .conductor_managed_run_summary import ThreadCompletionReport, render_run_summary_block
from .conductor_managed_run_coordinator import ConductorManagedRunCoordinator
from .conductor_managed_run_human_action_projection import project_human_action_instructions
from .conductor_managed_run_operator_events import ingest_managed_run_operator_events
from .conductor_managed_run_runtime_wait_projection import project_runtime_waits
from .conductor_managed_run_runtime_waits import waiting_runtime_wait
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
        existing = await self._existing_child_issues()
        existing_by_work_item = self._existing_by_work_item(run_id, existing)
        issue_by_work_item = dict(existing_by_work_item)
        work_items = self.store.list_work_items(run_id)
        root_issue = await self._existing_root_issue()
        ingested, run, work_items = await ingest_managed_run_operator_events(
            store=self.store,
            tracker=self.tracker,
            run_id=run_id,
            root_issue_id=self.root_issue_id,
            run=run,
            work_items=work_items,
            root_issue=root_issue,
            issues_by_work_item=issue_by_work_item,
        )
        projected += ingested
        projected += await self._project_parent_summary(run_id, run)
        projected += await self._project_attempt_comments(run_id, run, "", self.root_issue_id)
        for item in work_items:
            work_item_id = str(item["work_item_id"])
            issue = issue_by_work_item.get(work_item_id)
            if issue is None:
                issue = await self.tracker.create_child_issue_for(
                    parent_issue_id=self.root_issue_id,
                    title=str(item["payload"].get("title") or work_item_id),
                    description=self._work_item_description(item, wait=waiting_runtime_wait(run.get("payload") or {}, work_item_id)),
                    label_names=[],
                    delegate_id=self.delegate_id,
                )
                projected += 1
            issue_id = str(issue.get("id") or "")
            if not issue_id:
                raise RuntimeError(f"managed_run_projection_issue_missing_id run_id={run_id} work_item_id={work_item_id}")
            issue_by_work_item[work_item_id] = issue
            update_description = getattr(self.tracker, "update_issue_description_marker_block", None)
            if update_description is not None:
                await update_description(
                    issue_id,
                    "SYMPHONY WORK ITEM",
                    self._work_item_description(item, wait=waiting_runtime_wait(run.get("payload") or {}, work_item_id)),
                )
            transition = getattr(self.tracker, "transition_issue_by_state_target", None)
            if transition is not None:
                names, state_type = linear_state_target(str(item["state"]))
                await transition(issue_id, names=names, state_type=state_type)
                projected += 1
            self.store.record_linear_projection(
                run_id,
                work_item_id,
                linear_issue_id=issue_id,
                metadata=self._projection_metadata(run_id, run, item, issue),
            )
            projected += await self._project_attempt_comments(run_id, run, work_item_id, issue_id)
        projected += await self._project_dependency_blocks(work_items, issue_by_work_item)
        projected += await project_runtime_waits(
            store=self.store,
            tracker=self.tracker,
            run_id=run_id,
            root_issue_id=self.root_issue_id,
        )
        projected += await project_human_action_instructions(
            store=self.store,
            tracker=self.tracker,
            run_id=run_id,
            root_issue_id=self.root_issue_id,
            run=run,
            work_items=work_items,
            issues_by_work_item=issue_by_work_item,
        )
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
        transition = getattr(self.tracker, "transition_issue_by_state_target", None)
        if transition is None:
            return 1
        names, state_type = parent_linear_state_target(str(run.get("state") or ""))
        await transition(self.root_issue_id, names=names, state_type=state_type)
        return 2

    def _current_report(self, run_id: str, run: dict[str, Any]) -> ThreadCompletionReport:
        items = self.store.list_work_items(run_id)
        files_changed: list[dict[str, Any]] = []
        what = [f"projected {len(items)} bounded work item{'s' if len(items) != 1 else ''}"]
        latest_reason = summary_text(run.get("latest_reason"))
        if latest_reason:
            what.append(f"latest reason: {latest_reason}")
        what.extend(projection_health_lines(run.get("payload") if isinstance(run.get("payload"), dict) else {}))
        for item in items:
            result = item.get("result") if isinstance(item.get("result"), dict) else {}
            for changed in result.get("changed_files") or []:
                if isinstance(changed, dict):
                    files_changed.append({**changed, "work_item_id": item["work_item_id"]})
        checkpoint_evidence_items = checkpoint_evidence(self.store.list_checkpoint_results(run_id))
        plan = self.store.get_plan(run_id, int(run.get("plan_version") or 0)) if int(run.get("plan_version") or 0) else None
        complete = run.get("state") in {ManagedRunState.VERIFIED.value, ManagedRunState.DONE.value}
        return ThreadCompletionReport(
            status=str(run.get("state") or ManagedRunState.QUEUED.value),
            thread_id=str(run.get("backend_session_id") or ""),
            plan_version=int(run.get("plan_version") or 0),
            what_this_thread_did=what,
            files_changed=files_changed,
            rubric_results=rubric_results(plan, items, checkpoint_evidence=checkpoint_evidence_items, complete=complete),
            token_usage=[],
            residual_risks=residual_risks(plan, complete=complete),
        )

    async def _existing_child_issues(self) -> list[dict[str, Any]]:
        fetch = getattr(self.tracker, "fetch_child_issues", None)
        if fetch is None:
            return []
        loaded = await fetch(self.root_issue_id, label_name=None)
        return [dict(item) for item in loaded if isinstance(item, dict)]

    async def _existing_root_issue(self) -> dict[str, Any]:
        fetch = getattr(self.tracker, "fetch_issue", None)
        if not callable(fetch):
            return {}
        loaded = await fetch(self.root_issue_id)
        return dict(loaded) if isinstance(loaded, dict) else {}

    def _existing_by_work_item(self, run_id: str, existing: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        by_issue_id = {str(issue.get("id") or ""): issue for issue in existing}
        mapped: dict[str, dict[str, Any]] = {}
        for projection in self.store.list_linear_projections(run_id):
            issue = by_issue_id.get(str(projection.get("linear_issue_id") or ""))
            if issue is not None:
                mapped[str(projection.get("work_item_id") or "")] = issue
        return mapped

    def _work_item_description(self, item: dict[str, Any], *, wait: dict[str, Any] | None = None) -> str:
        payload = item["payload"] if isinstance(item.get("payload"), dict) else {}
        parallel = payload.get("parallelization") if isinstance(payload.get("parallelization"), dict) else {}
        lines = [
            "Managed Run Type: work-item",
            f"Managed Run Label: {WORK_ITEM_LABEL}",
            f"Managed Run Work Item: {item['work_item_id']}",
            "",
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
        if wait:
            lines.extend(
                [
                    "",
                    "Runtime Wait:",
                    f"- wait_id: {wait.get('wait_id') or ''}",
                    f"- wait_kind: {wait.get('wait_kind') or ''}",
                    f"- status: {wait.get('status') or ''}",
                    f"- message: {wait.get('sanitized_message') or ''}",
                ]
            )
        return "\n".join(lines)

    async def _project_attempt_comments(self, run_id: str, run: dict[str, Any], work_item_id: str, issue_id: str) -> int:
        comment_issue = getattr(self.tracker, "comment_issue", None)
        update_comment = getattr(self.tracker, "update_issue_comment", None)
        if not callable(comment_issue):
            return 0
        latest = self.store.get_run(run_id) or run
        payload = latest.get("payload") if isinstance(latest.get("payload"), dict) else {}
        existing = payload.get("attempt_comment_projections") if isinstance(payload.get("attempt_comment_projections"), dict) else {}
        mappings = {str(key): dict(value) for key, value in existing.items() if isinstance(value, dict)}
        projected = 0
        for attempt in attempts_for_work_item(payload, work_item_id):
            attempt_id = str(attempt.get("attempt_id") or "")
            if not attempt_id:
                continue
            body = attempt_comment_body(attempt)
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
                "updated_at": summary_text(attempt.get("completed_at") or attempt.get("started_at")),
            }
            projected += 1
        if projected:
            self.store.merge_run_payload(run_id, {"attempt_comment_projections": mappings})
        return projected

    async def _project_dependency_blocks(self, work_items: list[dict[str, Any]], issue_by_work_item: dict[str, dict[str, Any]]) -> int:
        ensure_relation = getattr(self.tracker, "ensure_issue_relation", None)
        if not callable(ensure_relation):
            return 0
        projected = 0
        for item in work_items:
            dependent_issue_id = str((issue_by_work_item.get(str(item["work_item_id"])) or {}).get("id") or "")
            payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
            for dependency in payload.get("dependencies") or []:
                dependency_issue_id = str((issue_by_work_item.get(str(dependency)) or {}).get("id") or "")
                if dependency_issue_id and dependent_issue_id:
                    await ensure_relation(issue_id=dependency_issue_id, related_issue_id=dependent_issue_id, relation_type="blocks")
                    projected += 1
        return projected

    def _projection_metadata(self, run_id: str, run: dict[str, Any], item: dict[str, Any], issue: dict[str, Any] | None = None) -> dict[str, Any]:
        work_item_id = str(item["work_item_id"])
        payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
        runtime_wait = waiting_runtime_wait(payload, work_item_id)
        skipped_label_names = []
        if isinstance(issue, dict):
            skipped_label_names = [str(name) for name in issue.get("skipped_label_names") or [] if str(name)]
        return {
            "run_id": run_id,
            "work_item_id": work_item_id,
            "parent_issue_id": self.root_issue_id,
            "plan_version": int(run.get("plan_version") or 0),
            "active_policy_id": str(payload.get("last_managed_run_policy_id") or ""),
            "active_policy_version": int(payload.get("last_managed_run_policy_version") or 0),
            "operator_status": "waiting_for_runtime_input" if runtime_wait else str(item.get("state") or ""),
            "operator_wait_kind": str(runtime_wait.get("wait_kind") or "") if runtime_wait else operator_wait_kind(item),
            "runtime_wait_id": str(runtime_wait.get("wait_id") or payload.get("runtime_wait_id") or "") if runtime_wait else str(payload.get("runtime_wait_id") or ""),
            "plan_attempt_id": latest_attempt_id(payload, kind="plan"),
            "work_item_attempt_id": latest_attempt_id(payload, kind="work_item", work_item_id=work_item_id),
            "verification_attempt_id": latest_attempt_id(payload, kind="verify", work_item_id=work_item_id),
            "linear_projection_id": f"{run_id}:{work_item_id}",
            "last_synced_comment_ids": last_synced_comment_ids(payload, work_item_id),
            "work_item_attempt_ids": attempt_ids_for_work_item(payload, work_item_id),
            "label_projection_degraded": bool(skipped_label_names),
            "skipped_label_names": skipped_label_names,
            "state": item["state"],
            "gate_status": item.get("gate_status") or "",
        }


__all__ = ["ManagedRunLinearProjector", "WORK_ITEM_LABEL"]
