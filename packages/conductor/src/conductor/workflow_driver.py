from __future__ import annotations

from pathlib import Path
from typing import Any

from performer_api.turns import ExecuteResult, GateResult, TurnContext
from performer_api.workflow import Plan, Task

from .gate import AcceptanceGate
from .runtime import PerformerRuntime
from .store import ConductorStore
from .workflow import Workflow


class WorkflowDriver:
    """Drive one durable parent through plan, sequential tasks, and one gate."""

    def __init__(self, service: Any) -> None:
        self.service = service
        self.store: ConductorStore = service.workflow_store
        self.workflow: Workflow = service.workflow
        self.runtime: PerformerRuntime = service.performer_runtime
        self.gate: AcceptanceGate = service.acceptance_gate

    async def drive_once(self) -> dict[str, int]:
        counts = {"started": 0, "applied": 0, "failed": 0}
        for run in self.store.list_runs():
            try:
                result = await self._drive_run(run)
            except Exception as exc:
                self.store.fail_run(str(run["run_id"]), _reason(exc))
                counts["failed"] += 1
                continue
            for key, value in result.items():
                counts[key] = counts.get(key, 0) + value
        return counts

    async def _drive_run(self, run: dict[str, Any]) -> dict[str, int]:
        state = str(run.get("state") or "")
        if state in {"done", "failed"}:
            return {}
        instance = self.service.store.get_instance(str(run.get("instance_id") or ""))
        if instance is None:
            raise RuntimeError("managed_run_instance_missing")
        if state == "awaiting_approval":
            return await self._resume_approved_plan(run, instance)
        if state == "blocked" and str(run.get("latest_reason") or "").startswith("runtime_wait:"):
            if await self._runtime_wait_reopened(run, instance):
                refreshed = self.store.get_run(str(run["run_id"])) or run
                return await self._drive_run(refreshed)
            return {}
        if int(run.get("plan_version") or 0) == 0:
            return await self._plan(run, instance)
        if state != "executing":
            return {}
        task = self.workflow.next_task(str(run["run_id"]))
        if task is None:
            return {}
        return await self._execute_task(run, instance, task)

    async def _plan(self, run: dict[str, Any], instance: Any) -> dict[str, int]:
        run_id = str(run["run_id"])
        attempt = self.workflow.start_plan(run_id)
        context = TurnContext(run_id, "", str(attempt["attempt_id"]), int(attempt["fencing_token"]), "plan")
        body = await self._run_turn(
            run,
            instance,
            context,
            {
                "turn_kind": "plan",
                "workspace_path": instance.workspace_root,
                "issue_description": _issue_description(run),
                "thread_id": str((run.get("payload") or {}).get("thread_id") or ""),
                "context": context.to_dict(),
            },
            role="plan",
        )
        if "runtime_wait" in body:
            return await self._record_wait(run, instance, context, body["runtime_wait"], {})
        plan = Plan.from_dict(body.get("plan") if isinstance(body.get("plan"), dict) else {})
        version = self.workflow.record_plan(
            run_id,
            context.attempt_id,
            context.fencing_token,
            plan,
            policy_revision=self._policy_revision(),
        )
        self.store.update_run_payload(run_id, {"thread_id": body.get("thread_id") or ""})
        await self._project_plan(run, instance, plan)
        return {"started": 1, "applied": 1, "plan_version": version}

    async def _execute_task(self, run: dict[str, Any], instance: Any, task_row: dict[str, Any]) -> dict[str, int]:
        run_id = str(run["run_id"])
        task = Task.from_dict(task_row.get("task") or {})
        attempt = self.workflow.start_task(run_id, task.id)
        await self._project_task_state(run, instance, task_row, "in_progress")
        context = TurnContext(run_id, task.id, str(attempt["attempt_id"]), int(attempt["fencing_token"]), "execute")
        body = await self._run_turn(
            run,
            instance,
            context,
            {
                "turn_kind": "execute",
                "workspace_path": instance.workspace_root,
                "task": task.to_dict(),
                "thread_id": str((run.get("payload") or {}).get("thread_id") or ""),
                "context": context.to_dict(),
            },
            role="execute",
        )
        if "runtime_wait" in body:
            return await self._record_wait(run, instance, context, body["runtime_wait"], task_row)
        result = ExecuteResult.from_dict(body.get("result") if isinstance(body.get("result"), dict) else {})
        ready = result.status == "ready_for_gate"
        updated = self.workflow.record_execute(
            run_id,
            context.attempt_id,
            context.fencing_token,
            ready_for_gate=ready,
            result=result.to_dict(),
        )
        self.store.update_run_payload(run_id, {"thread_id": body.get("thread_id") or ""})
        if not ready:
            await self._project_task_state(run, instance, updated, "blocked")
            await self._comment_task(run, instance, updated, f"Execution blocked: {result.blocked_reason or result.summary}")
            return {"applied": 1}

        gate_attempt = self.workflow.start_gate(run_id, task.id)
        command_results = self.gate.run_commands(task, Path(instance.workspace_root))
        command_evidence = {"commands": [item.to_dict() for item in command_results]}
        gate_context = TurnContext(
            run_id,
            task.id,
            str(gate_attempt["attempt_id"]),
            int(gate_attempt["fencing_token"]),
            "gate",
        )
        gate_body = await self._run_turn(
            run,
            instance,
            gate_context,
            {
                "turn_kind": "gate",
                "workspace_path": instance.workspace_root,
                "task": task.to_dict(),
                "evidence": command_evidence,
                "thread_id": str((run.get("payload") or {}).get("thread_id") or ""),
                "context": gate_context.to_dict(),
            },
            role="gate",
        )
        if "runtime_wait" in gate_body:
            return await self._record_wait(run, instance, gate_context, gate_body["runtime_wait"], task_row)
        codex_gate = GateResult.from_dict(
            gate_body.get("gate_result") if isinstance(gate_body.get("gate_result"), dict) else {}
        )
        evaluated, command_evidence = self.gate.evaluate(
            task,
            Path(instance.workspace_root),
            codex_gate,
            command_results=command_results,
        )
        evidence = {
            **command_evidence,
            "codex_gate": codex_gate.to_dict(),
            "artifact_refs": evaluated.artifact_refs,
            "provenance": evaluated.provenance,
            "rubric": evaluated.rubric,
        }
        updated = self.workflow.record_gate(
            run_id,
            gate_context.attempt_id,
            gate_context.fencing_token,
            passed=evaluated.passed,
            score=evaluated.score,
            threshold=evaluated.threshold,
            evidence=evidence,
        )
        command_count = len(command_results)
        passed_commands = sum(1 for result in command_results if result.passed)
        gate_note = ""
        if not evaluated.passed:
            gate_note = " One automatic rework remains." if updated["state"] == "in_progress" else " A second failure blocks this task."
        await self._comment_task(
            run,
            instance,
            updated,
            (
                f"Codex Gate {'passed' if evaluated.passed else 'failed'} "
                f"({evaluated.score}/{evaluated.threshold}); "
                f"verification commands {passed_commands}/{command_count} passed.{gate_note}"
            ),
        )
        await self._project_task_state(run, instance, updated, "done" if updated["state"] == "done" else "in_progress" if updated["state"] == "in_progress" else "blocked")
        if updated["state"] == "done":
            latest = self.store.get_run(run_id) or run
            if latest.get("state") == "done":
                await self._comment_parent(run, instance, "All Sub Issues passed the verification commands and Codex Gate.")
                await self._transition(parent_id=str(run["parent_issue_id"]), instance=instance, names=["Done", "Completed"], state_type="completed")
            return {"applied": 1}
        return {"applied": 1}

    async def _record_wait(self, run: dict[str, Any], instance: Any, context: TurnContext, wait: Any, task: dict[str, Any]) -> dict[str, int]:
        reason = str(wait.get("reason") or "Codex runtime wait")
        self.workflow.record_runtime_wait(
            str(run["run_id"]),
            context.attempt_id,
            context.fencing_token,
            kind=str(wait.get("kind") or "approval_requested"),
            reason=reason,
        )
        wait = self.store.list_runtime_waits(str(run["run_id"]))[-1]
        scope_issue_id = str(task.get("linear_issue_id") or run["parent_issue_id"])
        wait_issue = await self.service._managed_run_tracker(instance).create_child_issue_for(
            parent_issue_id=scope_issue_id,
            title=f"[Human Action] Runtime wait: {str(wait.get('kind') or 'approval')}",
            description=(
                "Complete this Linear issue after resolving the Codex runtime wait. "
                f"The next poll resumes the fenced task.\n\nReason: {reason}"
            ),
        )
        self.store.attach_wait_issue(
            str(wait["wait_id"]),
            issue_id=str(wait_issue.get("id") or ""),
            identifier=str(wait_issue.get("identifier") or ""),
        )
        await self._project_task_state(run, instance, task, "blocked")
        await self._comment_task(run, instance, task, f"Codex runtime wait: {reason}")
        return {"applied": 0}

    async def _run_turn(
        self,
        run: dict[str, Any],
        instance: Any,
        context: TurnContext,
        request: dict[str, Any],
        *,
        role: str,
    ) -> dict[str, Any]:
        root = Path(instance.instance_dir) / "state" / "workflow-runs" / str(run["run_id"]) / context.attempt_id
        paths = self.runtime.paths(root)
        env = self._runtime_environment(instance, role, Path(instance.workspace_root), context.attempt_id)
        self.runtime.write_request(paths, request)
        event = _turn_log_fields(context, role, paths)
        self.runtime.append_event(Path(instance.log_path), f"event=performer_turn_started {event}")
        try:
            payload = self.runtime.run(paths, codex_home=Path(env["CODEX_HOME"]), env=env)
            accepted = self.runtime.accept_result(context, payload)
        except Exception as exc:
            self.runtime.append_event(
                Path(instance.log_path),
                f"event=performer_turn_failed {event} error_type={exc.__class__.__name__} sanitized_reason={_reason(exc)}",
            )
            raise
        self.runtime.append_event(Path(instance.log_path), f"event=performer_turn_completed {event}")
        return accepted

    def _runtime_environment(self, instance: Any, role: str, workspace: Path, attempt_id: str) -> dict[str, str]:
        _ = role
        return self.runtime.prepare_environment(
            Path(instance.instance_dir) / "state",
            workspace_path=workspace,
            home_scope=attempt_id,
        )

    async def _project_plan(self, run: dict[str, Any], instance: Any, plan: Plan) -> None:
        proxy = self.service._managed_run_tracker(instance)
        parent_id = str(run["parent_issue_id"])
        delegate_id = str((run.get("payload") or {}).get("agent_app_user_id") or "") or None
        for task in plan.tasks:
            issue = await proxy.create_child_issue_for(
                parent_issue_id=parent_id,
                title=task.title,
                description=_task_description(task),
                delegate_id=delegate_id,
            )
            self.store.attach_task_issue(
                str(run["run_id"]),
                task.id,
                issue_id=str(issue.get("id") or ""),
                identifier=str(issue.get("identifier") or ""),
                state=str((issue.get("state") or {}).get("name") or "") if isinstance(issue.get("state"), dict) else "",
            )
        plan_block = "\n".join(
            [
                "## Symphony Plan",
                plan.summary,
                *(f"- `{task.id}`: {task.title}" for task in plan.tasks),
                "",
                "This plan is executed sequentially; each Sub Issue must pass its verification commands and one Codex Gate.",
            ]
        )
        await proxy.update_issue_description_marker_block(parent_id, "SYMPHONY_PLAN", plan_block)
        if plan.approval_required:
            await proxy.comment_issue(parent_id, "Plan committed and awaiting Linear approval before execution.")

    async def _resume_approved_plan(self, run: dict[str, Any], instance: Any) -> dict[str, int]:
        proxy = self.service._managed_run_tracker(instance)
        issue = await proxy.fetch_issue(str(run["parent_issue_id"]))
        state = issue.get("state") if isinstance(issue.get("state"), dict) else {}
        state_name = str(state.get("name") or "").lower()
        if state_name in {"blocked", "backlog", "canceled", "cancelled"}:
            return {}
        self.workflow.approve_plan(
            str(run["run_id"]),
            int(run.get("plan_version") or 0),
            approval_id=f"linear-state:{state_name or 'reopened'}",
        )
        await proxy.comment_issue(str(run["parent_issue_id"]), "Plan approval observed from Linear; sequential execution resumed.")
        return {"applied": 1}

    async def _runtime_wait_reopened(self, run: dict[str, Any], instance: Any) -> bool:
        waits = [wait for wait in self.store.list_runtime_waits(str(run["run_id"])) if wait.get("state") == "open"]
        if not waits:
            return False
        wait = waits[-1]
        issue_id = str(run["parent_issue_id"])
        task_id = str(wait.get("task_id") or "")
        wait_issue_id = str(wait.get("linear_issue_id") or "")
        if wait_issue_id:
            issue_id = wait_issue_id
        elif task_id:
            task = self.store.get_task(str(run["run_id"]), task_id) or {}
            issue_id = str(task.get("linear_issue_id") or issue_id)
        issue = await self.service._managed_run_tracker(instance).fetch_issue(issue_id)
        state = issue.get("state") if isinstance(issue.get("state"), dict) else {}
        state_name = str(state.get("name") or "").lower()
        if state_name in {"blocked", "backlog", "canceled", "cancelled"}:
            return False
        resumed = self.workflow.resume_runtime_wait(str(run["run_id"]))
        if resumed:
            await self.service._managed_run_tracker(instance).comment_issue(
                issue_id,
                "Runtime wait reopened from Linear; the fenced turn will resume on the next polling cycle.",
            )
        return resumed

    async def _project_task_state(self, run: dict[str, Any], instance: Any, task: dict[str, Any], target: str) -> None:
        issue_id = str(task.get("linear_issue_id") or "")
        if not issue_id:
            return
        names = {
            "in_progress": ["In Progress", "Started"],
            "blocked": ["Blocked"],
            "done": ["Done", "Completed"],
        }[target]
        await self._transition(parent_id=issue_id, instance=instance, names=names, state_type="completed" if target == "done" else "started" if target == "in_progress" else "backlog")
        self.store.update_task_linear_state(str(run["run_id"]), str(task["task_id"]), target)

    async def _transition(self, *, parent_id: str, instance: Any, names: list[str], state_type: str) -> None:
        proxy = self.service._managed_run_tracker(instance)
        result = await proxy.transition_issue_by_state_target(parent_id, names=names, state_type=state_type)
        if result.get("success") is False:
            raise RuntimeError(f"linear_state_transition_failed:{result.get('reason') or 'unknown'}")

    async def _comment_parent(self, run: dict[str, Any], instance: Any, body: str) -> None:
        await self.service._managed_run_tracker(instance).comment_issue(str(run["parent_issue_id"]), body)

    async def _comment_task(self, run: dict[str, Any], instance: Any, task: dict[str, Any], body: str) -> None:
        issue_id = str(task.get("linear_issue_id") or run["parent_issue_id"])
        await self.service._managed_run_tracker(instance).comment_issue(issue_id, body)

    def _policy_revision(self) -> int:
        return 1


def _task_description(task: Task) -> str:
    return "\n".join(
        [
            f"## Objective\n{task.objective}",
            "## Acceptance Criteria",
            *(f"- {criterion}" for criterion in task.acceptance_criteria),
            "## Verification",
            *(f"- `{command}`" for command in task.verification_commands),
            "## File Scope",
            *(f"- `{path}`" for path in task.files_likely_touched),
        ]
    )


def _issue_description(run: dict[str, Any]) -> str:
    payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
    return str(payload.get("issue_description") or payload.get("issue_title") or run.get("issue_identifier") or "")


def _turn_log_fields(context: TurnContext, role: str, paths: Any) -> str:
    return " ".join(
        (
            f"run_id={context.run_id}",
            f"work_item_id={context.task_id or '-'}",
            f"attempt_id={context.attempt_id}",
            f"fencing_token={context.fencing_token}",
            f"turn_kind={role}",
            f"request_path={paths.request}",
            f"result_path={paths.result}",
        )
    )


def _reason(error: Exception) -> str:
    text = str(error).strip().replace("\n", " ")
    return text[:500] or error.__class__.__name__


__all__ = ["WorkflowDriver"]
