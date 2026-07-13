from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any

from performer_api.performer_control import PerformerControlError
from performer_api.runtime_policy import RuntimePolicy, canonical_sha256
from performer_api.turns import (
    ExecuteResult,
    GateResult,
    PerformerTurnRequest,
    PerformerTurnResult,
    TurnContext,
)
from performer_api.workflow import Plan, Task

from .acceptance_evidence import canonical_gate_evidence
from .gate import AcceptanceGate
from .conductor_smoke_protocol import sanitize_reason
from .runtime import PerformerRuntime, StaleRuntimeResult
from .store import ConductorStore, StaleAttemptError


class WorkflowDriver:
    """Drive one durable parent through plan, sequential tasks, and one gate."""

    def __init__(self, service: Any) -> None:
        self.service = service
        self.store: ConductorStore = service.store
        self.runtime: PerformerRuntime = service.performer_runtime
        self.gate: AcceptanceGate = service.acceptance_gate
        self._turn_reservation: ContextVar[bool] = ContextVar(
            "workflow_driver_turn_reservation", default=False
        )

    async def drive_once(self) -> dict[str, int]:
        counts = {"started": 0, "applied": 0, "failed": 0}
        for run in self.store.list_runs():
            try:
                result = await self._drive_run(run)
            except (StaleAttemptError, StaleRuntimeResult) as exc:
                self._record_stale_result(run, exc)
                continue
            except Exception as exc:
                reason = _reason(exc)
                run_id = str(run["run_id"])
                self.store.fail_run(run_id, reason)
                instance = self.store.get_instance(str(run.get("instance_id") or ""))
                if instance is not None:
                    self.runtime.append_event(
                        Path(instance.log_path),
                        "event=managed_run_drive_failed level=error "
                        f"run_id={run_id} error_type={exc.__class__.__name__} "
                        f"error_code={reason.split(':', 1)[0]} sanitized_reason={reason.replace(' ', '_')} "
                        "action_required=true retryable=false next_action=inspect_managed_run_state",
                    )
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
        if state == "blocked" and isinstance(
            (run.get("payload") or {}).get("performer_readiness_block"), dict
        ):
            marker = dict((run.get("payload") or {})["performer_readiness_block"])
            projection = marker.get("linear_projection")
            if not isinstance(projection, dict) or projection.get("status") != "complete":
                await self._project_performer_readiness_block(run, instance, marker)
                return {}
            if not self._performer_is_ready(instance):
                return {}
            if not await self._project_performer_resumed_marker(run, instance, marker):
                return {}
            identity = self._performer_identity(instance)
            resumed = self.store.resume_run_from_performer_block(
                str(run["run_id"]),
                performer_kind=identity["performer_kind"],
                binding_generation=identity["binding_generation"],
                execution_policy_sha256=identity["execution_policy_sha256"],
            )
            if resumed.get("state") == "blocked":
                return {}
            await self._record_performer_resumed(resumed, instance, marker)
            return await self._drive_run(resumed)
        if state == "executing" and str(run.get("latest_reason") or "") == "stale_gate_projection_failed":
            return await self._retry_stale_gate_todo_projection(run, instance)
        if int(run.get("plan_version") or 0) == 0:
            return await self._plan(run, instance)
        if state != "executing":
            return {}
        if any(not task.get("linear_issue_id") for task in self.store.list_tasks(str(run["run_id"]))):
            payload = self.store.get_plan(str(run["run_id"]))
            if payload is None:
                raise RuntimeError("managed_run_plan_missing")
            await self._project_plan(run, instance, Plan.from_dict(payload))
            return {"applied": 1}
        task = self.store.next_task(str(run["run_id"]))
        if task is None:
            return {}
        return await self._execute_task(run, instance, task)

    async def _plan(self, run: dict[str, Any], instance: Any) -> dict[str, int]:
        run_id = str(run["run_id"])
        async with self._reserved_performer_turn():
            if not await self._require_performer_ready(run, instance):
                return {"applied": 1}
            attempt = self.store.start_plan(run_id)
            context = TurnContext(
                run_id,
                "",
                str(attempt["attempt_id"]),
                int(attempt["fencing_token"]),
                "plan",
            )
            request = self._turn_request(
                instance,
                context,
                thread_id=str((run.get("payload") or {}).get("thread_id") or ""),
                issue_description=_issue_description(run),
            )
            body = await self._run_turn(
                run,
                instance,
                context,
                request.to_dict(),
                role="plan",
            )
        if body.get("runtime_wait") is not None:
            return await self._record_wait(run, instance, context, body["runtime_wait"], {})
        plan = Plan.from_dict(body.get("plan") if isinstance(body.get("plan"), dict) else {})
        version = self.store.record_plan(
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
        async with self._reserved_performer_turn():
            if not await self._require_performer_ready(run, instance, task_row=task_row):
                return {"applied": 1}
            attempt = self.store.start_task(run_id, task.id)
            await self._project_task_state(run, instance, task_row, "in_progress")
            context = TurnContext(
                run_id,
                task.id,
                str(attempt["attempt_id"]),
                int(attempt["fencing_token"]),
                "execute",
            )
            execute_request = self._turn_request(
                instance,
                context,
                thread_id=str((run.get("payload") or {}).get("thread_id") or ""),
                task=task,
            )
            body = await self._run_turn(
                run,
                instance,
                context,
                execute_request.to_dict(),
                role="execute",
            )
        if body.get("runtime_wait") is not None:
            return await self._record_wait(run, instance, context, body["runtime_wait"], task_row)
        result = ExecuteResult.from_dict(
            body.get("execute_result") if isinstance(body.get("execute_result"), dict) else {}
        )
        ready = result.status == "ready_for_gate"
        updated = self.store.record_execute(
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

        ready_for_gate_row = self.store.get_task(run_id, task.id) or updated
        refreshed_run = self.store.get_run(run_id) or run
        async with self._reserved_performer_turn():
            if not await self._require_performer_ready(
                refreshed_run,
                instance,
                task_row=ready_for_gate_row,
            ):
                return {"applied": 1}
            gate_attempt = self.store.start_gate(run_id, task.id)
            command_results = self.gate.run_commands(task, Path(instance.workspace_root))
            command_evidence = {"commands": [item.to_dict() for item in command_results]}
            prompt_command_evidence = _sanitize_command_evidence(
                command_evidence,
                attempt_id=str(gate_attempt["attempt_id"]),
                plan_version=int((gate_attempt.get("result") or {}).get("plan_version") or 0),
            )
            gate_context = TurnContext(
                run_id,
                task.id,
                str(gate_attempt["attempt_id"]),
                int(gate_attempt["fencing_token"]),
                "gate",
            )
            captured_plan_version = int(
                (gate_attempt.get("result") or {}).get("plan_version") or 0
            )
            gate_request = self._turn_request(
                instance,
                gate_context,
                thread_id=str((run.get("payload") or {}).get("thread_id") or ""),
                task=task,
                evidence=prompt_command_evidence,
            )
            gate_body = await self._run_turn(
                run,
                instance,
                gate_context,
                gate_request.to_dict(),
                role="gate",
            )
        if gate_body.get("runtime_wait") is not None:
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
        try:
            updated = self.store.record_gate(
                run_id,
                gate_context.attempt_id,
                gate_context.fencing_token,
                passed=evaluated.passed,
                score=evaluated.score,
                threshold=evaluated.threshold,
                command_passed=sum(1 for result in command_results if result.passed),
                command_total=len(command_results),
                evidence=evidence,
            )
        except StaleAttemptError as exc:
            reason = _reason(exc)
            if reason not in {"missing_gate_plan_version", "stale_plan_version"}:
                raise
            stale_task = self.store.get_task(run_id, task.id) or task_row
            self._log_gate_event(
                event="managed_run_gate_result_stale",
                level="warning",
                run=run,
                instance=instance,
                context=gate_context,
                captured_plan_version=captured_plan_version,
                error_type=exc.__class__.__name__,
                error_code=reason,
                sanitized_reason=reason,
                action_required=False,
                retryable=True,
                next_action="re_run_current_plan_revision",
            )
            await self._comment_task(run, instance, stale_task, f"Gate result discarded: {reason}. Re-running the current plan revision.")
            try:
                await self._project_task_state(run, instance, stale_task, "todo")
            except RuntimeError:
                self.store.update_run_reason(run_id, "stale_gate_projection_failed")
                self._log_gate_event(
                    event="managed_run_gate_stale_projection_failed",
                    level="error",
                    run=run,
                    instance=instance,
                    context=gate_context,
                    captured_plan_version=captured_plan_version,
                    error_type="LinearStateProjectionError",
                    error_code="linear_state_transition_failed",
                    sanitized_reason="linear_state_transition_failed",
                    action_required=False,
                    retryable=True,
                    next_action="retry_linear_state_projection",
                )
                return {"applied": 0}
            return {"applied": 1}
        except ValueError as exc:
            reason = _reason(exc)
            self._log_gate_event(
                event="managed_run_gate_rejected",
                level="error",
                run=run,
                instance=instance,
                context=gate_context,
                captured_plan_version=captured_plan_version,
                error_type=exc.__class__.__name__,
                error_code=reason,
                sanitized_reason=reason,
                action_required=True,
                retryable=False,
                next_action="inspect_gate_result",
            )
            raise
        gate_note = ""
        summary = self.store.get_gate_evidence_summary(run_id, task.id) or {}
        if not summary.get("passed"):
            gate_note = " One automatic rework remains." if updated["state"] == "in_progress" else " A second failure blocks this task."
        if updated["state"] == "blocked":
            failure_code = str(summary.get("failure_code") or "codex_gate_failed")
            self._log_gate_event(
                event="managed_run_gate_failed",
                level="error",
                run=run,
                instance=instance,
                context=gate_context,
                captured_plan_version=captured_plan_version,
                error_type="GateFailure",
                error_code=failure_code,
                sanitized_reason=failure_code,
                action_required=True,
                retryable=False,
                next_action="request_plan_revision",
            )
        await self._comment_task(
            run,
            instance,
            updated,
            _gate_comment(summary, gate_note),
        )
        await self._project_task_state(run, instance, updated, "done" if updated["state"] == "done" else "in_progress" if updated["state"] == "in_progress" else "blocked")
        if updated["state"] == "done":
            latest = self.store.get_run(run_id) or run
            if latest.get("state") == "done":
                await self._comment_parent(run, instance, "All Sub Issues passed the verification commands and Codex Gate.")
                await self._transition(parent_id=str(run["parent_issue_id"]), instance=instance, names=["Done", "Completed"], state_type="completed")
            return {"applied": 1}
        return {"applied": 1}

    async def _retry_stale_gate_todo_projection(self, run: dict[str, Any], instance: Any) -> dict[str, int]:
        run_id = str(run["run_id"])
        stale_task = next(
            (
                task
                for task in self.store.list_tasks(run_id)
                if task.get("state") == "todo"
                and task.get("gate_status") in {"missing_gate_plan_version", "stale_plan_version"}
                and task.get("linear_issue_id")
                and task.get("linear_state") != "todo"
            ),
            None,
        )
        if stale_task is None:
            self.store.update_run_reason(run_id, "stale_plan_version")
            return {}
        try:
            await self._project_task_state(run, instance, stale_task, "todo")
        except RuntimeError:
            return {}
        self.store.update_run_reason(run_id, str(stale_task.get("gate_status") or "stale_plan_version"))
        return {"applied": 1}

    async def _record_wait(self, run: dict[str, Any], instance: Any, context: TurnContext, wait: Any, task: dict[str, Any]) -> dict[str, int]:
        reason = sanitize_reason(wait.get("reason") or "Codex runtime wait")
        self.store.record_runtime_wait(
            str(run["run_id"]),
            context.attempt_id,
            context.fencing_token,
            kind=str(wait.get("kind") or "approval_requested"),
            reason=reason,
        )
        wait = self.store.list_runtime_waits(str(run["run_id"]))[-1]
        scope_issue_id = str(task.get("linear_issue_id") or run["parent_issue_id"])
        wait_issue = await self.service._managed_run_tracker().create_child_issue_for(
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
        async def invoke() -> tuple[dict[str, Any], str]:
            root = (
                Path(instance.instance_dir)
                / "state"
                / "workflow-runs"
                / str(run["run_id"])
                / context.attempt_id
            )
            paths = self.runtime.paths(root)
            self.runtime.write_request(paths, request)
            event = _turn_log_fields(context, role, paths)
            self.runtime.append_event(
                Path(instance.log_path), f"event=performer_turn_started {event}"
            )
            payload = await self.runtime.run_async(paths)
            accepted = self.runtime.accept_result(context, payload)
            return PerformerTurnResult.from_dict(accepted).to_dict(), event

        event = ""
        try:
            if self._turn_reservation.get():
                accepted, event = await invoke()
            else:
                async with self._performer_operation():
                    accepted, event = await invoke()
        except StaleRuntimeResult as exc:
            self.runtime.append_event(
                Path(instance.log_path),
                f"event=performer_result_stale level=warning {event} error_type={exc.__class__.__name__} "
                f"error_code={_reason(exc)} sanitized_reason={_reason(exc)} action_required=false "
                "retryable=true next_action=ignore_stale_result",
            )
            raise
        except Exception as exc:
            self.runtime.append_event(
                Path(instance.log_path),
                f"event=performer_turn_failed {event} error_type={exc.__class__.__name__} "
                f"error_code={_reason(exc).split(':', 1)[0]} sanitized_reason={_reason(exc).replace(' ', '_')} "
                "action_required=true retryable=false next_action=inspect_performer_attempt",
            )
            raise
        self.runtime.append_event(Path(instance.log_path), f"event=performer_turn_completed {event}")
        return accepted

    @asynccontextmanager
    async def _reserved_performer_turn(self):
        async with self._performer_operation():
            token = self._turn_reservation.set(True)
            try:
                yield
            finally:
                self._turn_reservation.reset(token)

    @asynccontextmanager
    async def _performer_operation(self):
        coordinator = self.service.performer_coordinator
        operation = getattr(coordinator, "turn_exchange", None)
        if callable(operation):
            async with operation():
                yield
            return
        raise RuntimeError("performer_coordinator_unavailable")

    def _turn_request(
        self,
        instance: Any,
        context: TurnContext,
        *,
        thread_id: str,
        issue_description: str = "",
        task: Task | None = None,
        evidence: dict[str, Any] | None = None,
    ) -> PerformerTurnRequest:
        identity = self._performer_identity(instance)
        return PerformerTurnRequest(
            protocol_version=1,
            context=context,
            performer_kind=identity["performer_kind"],
            performer_binding_id=identity["performer_binding_id"],
            binding_generation=identity["binding_generation"],
            execution_policy=identity["execution_policy"],
            execution_policy_sha256=identity["execution_policy_sha256"],
            turn_policy_sha256=identity["turn_policy_sha256"],
            workspace_path=str(instance.workspace_root),
            thread_id=thread_id,
            issue_description=issue_description,
            task=task,
            evidence=evidence,
        )

    def _performer_identity(self, instance: Any) -> dict[str, Any]:
        filters = instance.linear_filters if isinstance(instance.linear_filters, dict) else {}
        policy = RuntimePolicy.from_dict(filters.get("execution_policy"))
        policy_hash = canonical_sha256(policy.to_dict())
        supplied_hash = str(filters.get("execution_policy_sha256") or "")
        if supplied_hash != policy_hash:
            raise RuntimeError("execution_policy_hash_mismatch")
        performer_kind = str(filters.get("performer_kind") or "")
        performer_binding_id = str(filters.get("performer_binding_id") or "")
        binding_generation = filters.get("performer_binding_generation")
        turn_policy_sha256 = str(filters.get("turn_policy_sha256") or "")
        if not performer_kind or not performer_binding_id:
            raise RuntimeError("performer_binding_required")
        if (
            isinstance(binding_generation, bool)
            or not isinstance(binding_generation, int)
            or binding_generation <= 0
        ):
            raise RuntimeError("performer_binding_generation_invalid")
        if len(turn_policy_sha256) != 64:
            raise RuntimeError("turn_policy_hash_invalid")
        return {
            "performer_kind": performer_kind,
            "performer_binding_id": performer_binding_id,
            "binding_generation": binding_generation,
            "execution_policy": policy.to_dict(),
            "execution_policy_sha256": policy_hash,
            "turn_policy_sha256": turn_policy_sha256,
        }

    def _performer_is_ready(self, instance: Any) -> bool:
        identity = self._performer_identity(instance)
        state = self.store.get_performer_control_state()
        return (
            state.get("status") == "ready"
            and state.get("last_check_status") == "passed"
            and state.get("performer_kind") == identity["performer_kind"]
            and state.get("binding_generation") == identity["binding_generation"]
            and state.get("execution_policy_sha256")
            == identity["execution_policy_sha256"]
            and int(state.get("capability_version") or 0) > 0
        )

    async def _require_performer_ready(
        self,
        run: dict[str, Any],
        instance: Any,
        *,
        task_row: dict[str, Any] | None = None,
    ) -> bool:
        if self._performer_is_ready(instance):
            return True
        identity = self._performer_identity(instance)
        state = self.store.get_performer_control_state()
        error = _performer_readiness_error(state, identity)
        existing = (run.get("payload") or {}).get("performer_readiness_block")
        if isinstance(existing, dict):
            return False
        blocked = self.store.block_run_for_performer(
            str(run["run_id"]),
            task_id=str(task_row.get("task_id") or "") if task_row is not None else None,
            performer_kind=identity["performer_kind"],
            binding_generation=identity["binding_generation"],
            execution_policy_sha256=identity["execution_policy_sha256"],
            error=error,
        )
        self._log_performer_readiness_event(
            event="managed_run_performer_blocked",
            level="error" if error.action_required else "warning",
            run=blocked,
            instance=instance,
            error=error,
            task_id=str(task_row.get("task_id") or "") if task_row is not None else "",
        )
        marker = dict(
            (blocked.get("payload") or {}).get("performer_readiness_block") or {}
        )
        await self._project_performer_readiness_block(blocked, instance, marker)
        return False

    async def _project_performer_readiness_block(
        self,
        run: dict[str, Any],
        instance: Any,
        marker: dict[str, Any],
    ) -> None:
        run_id = str(run["run_id"])
        task_id = str(marker.get("task_id") or "")
        issue_id = str(run["parent_issue_id"])
        try:
            if task_id:
                task = self.store.get_task(run_id, task_id)
                if task is None:
                    raise RuntimeError("performer_readiness_task_missing")
                issue_id = str(task.get("linear_issue_id") or issue_id)
                await self._project_task_state(run, instance, task, "blocked")
            else:
                await self._transition(
                    parent_id=issue_id,
                    instance=instance,
                    names=["Blocked"],
                    state_type="backlog",
                )
            result = await self.service._managed_run_tracker().update_issue_description_marker_block(
                issue_id,
                "SYMPHONY_PERFORMER_READINESS",
                _performer_block_marker(marker),
            )
            if result.get("success") is False:
                raise RuntimeError("performer_readiness_description_projection_failed")
        except Exception as exc:
            reason = _reason(exc)[:500]
            updated = self.store.record_performer_readiness_projection(
                run_id,
                status="pending",
                error_code="performer_readiness_projection_failed",
                sanitized_reason=reason,
                next_action="retry_linear_projection",
            )
            updated_marker = dict(
                (updated.get("payload") or {}).get("performer_readiness_block") or {}
            )
            updated_projection = dict(updated_marker.get("linear_projection") or {})
            self.runtime.append_event(
                Path(instance.log_path),
                "event=linear_projection_updated level=error "
                f"instance_id={instance.id} run_id={run_id} work_item_id={task_id or '-'} "
                f"attempt_number={int(updated_projection.get('attempt_number') or 0)} "
                f"error_type={exc.__class__.__name__} "
                "error_code=performer_readiness_projection_failed "
                f"sanitized_reason={reason.replace(' ', '_')} "
                "action_required=false retryable=true next_action=retry_linear_projection",
            )
            return
        self.store.record_performer_readiness_projection(
            run_id,
            status="complete",
            next_action="wait_for_compatible_performer_check",
        )
        self.runtime.append_event(
            Path(instance.log_path),
            "event=linear_projection_updated level=info "
            f"instance_id={instance.id} run_id={run_id} work_item_id={task_id or '-'} "
            "error_code=none sanitized_reason=performer_readiness_block_projected "
            "action_required=false retryable=false "
            "next_action=wait_for_compatible_performer_check",
        )

    async def _project_performer_resumed_marker(
        self,
        run: dict[str, Any],
        instance: Any,
        marker: dict[str, Any],
    ) -> bool:
        run_id = str(run["run_id"])
        task_id = str(marker.get("task_id") or "")
        issue_id = str(run["parent_issue_id"])
        if task_id:
            task = self.store.get_task(run_id, task_id) or {}
            issue_id = str(task.get("linear_issue_id") or issue_id)
        try:
            result = await self.service._managed_run_tracker().update_issue_description_marker_block(
                issue_id,
                "SYMPHONY_PERFORMER_READINESS",
                _performer_resumed_marker(marker),
            )
            if result.get("success") is False:
                raise RuntimeError("performer_resume_description_projection_failed")
        except Exception as exc:
            self.runtime.append_event(
                Path(instance.log_path),
                "event=linear_projection_updated level=warning "
                f"instance_id={instance.id} run_id={run_id} work_item_id={task_id or '-'} "
                f"error_type={exc.__class__.__name__} "
                "error_code=performer_resume_projection_failed "
                f"sanitized_reason={_reason(exc).replace(' ', '_')[:500]} "
                "action_required=false retryable=true next_action=retry_linear_projection",
            )
            return False
        return True

    async def _record_performer_resumed(
        self,
        run: dict[str, Any],
        instance: Any,
        marker: dict[str, Any],
    ) -> None:
        self.runtime.append_event(
            Path(instance.log_path),
            " ".join(
                (
                    "event=managed_run_performer_resumed",
                    "level=info",
                    f"instance_id={instance.id}",
                    f"run_id={run['run_id']}",
                    f"work_item_id={str(marker.get('task_id') or '-')}",
                    f"performer_kind={str(marker.get('performer_kind') or '-')}",
                    f"binding_generation={int(marker.get('binding_generation') or 0)}",
                    "action_required=false",
                    "retryable=false",
                    "next_action=resume_prior_phase",
                )
            ),
        )

    def _log_performer_readiness_event(
        self,
        *,
        event: str,
        level: str,
        run: dict[str, Any],
        instance: Any,
        error: PerformerControlError,
        task_id: str,
    ) -> None:
        identity = self._performer_identity(instance)
        fields = (
            f"event={event}",
            f"level={level}",
            f"instance_id={instance.id}",
            f"run_id={run['run_id']}",
            f"work_item_id={task_id or '-'}",
            f"performer_kind={identity['performer_kind']}",
            f"binding_generation={identity['binding_generation']}",
            f"error_type=PerformerControlError",
            f"error_code={error.error_code}",
            f"sanitized_reason={error.sanitized_reason.replace(' ', '_')[:500]}",
            f"action_required={'true' if error.action_required else 'false'}",
            f"retryable={'true' if error.retryable else 'false'}",
            f"attempt_number={error.attempt_number or 0}",
            f"next_action={error.next_action.replace(' ', '_')[:500]}",
        )
        self.runtime.append_event(Path(instance.log_path), " ".join(fields))

    def _record_stale_result(self, run: dict[str, Any], error: Exception) -> None:
        run_id = str(run["run_id"])
        reason = _reason(error)
        self.store.update_run_reason(run_id, reason)
        instance = self.store.get_instance(str(run.get("instance_id") or ""))
        if instance is None:
            return
        fields = (
            "event=managed_run_result_stale",
            "level=warning",
            f"instance_id={instance.id}",
            f"run_id={run_id}",
            f"work_item_id={str(run.get('active_task_id') or '-')}",
            f"error_type={error.__class__.__name__}",
            f"error_code={reason}",
            f"sanitized_reason={reason.replace(' ', '_')[:500]}",
            "action_required=false",
            "retryable=true",
            "next_action=ignore_stale_result",
        )
        self.runtime.append_event(Path(instance.log_path), " ".join(fields))

    async def _project_plan(self, run: dict[str, Any], instance: Any, plan: Plan) -> None:
        proxy = self.service._managed_run_tracker()
        run_id = str(run["run_id"])
        parent_id = str(run["parent_issue_id"])
        delegate_id = str((run.get("payload") or {}).get("agent_app_user_id") or "") or None
        for task_row in self.store.list_tasks(run_id):
            if task_row.get("linear_issue_id"):
                continue
            task = Task.from_dict(task_row.get("task") or {})
            issue = await proxy.create_child_issue_for(
                parent_issue_id=parent_id,
                title=task.title,
                description=_task_description(task),
                delegate_id=delegate_id,
            )
            self.store.attach_task_issue(
                run_id,
                task.id,
                issue_id=str(issue.get("id") or ""),
                identifier=str(issue.get("identifier") or ""),
                state=str(issue.get("state") or ""),
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
            await self._transition(parent_id=parent_id, instance=instance, names=["Blocked"], state_type="backlog")
            await proxy.comment_issue(parent_id, "Plan committed and awaiting Linear approval before execution.")

    async def _resume_approved_plan(self, run: dict[str, Any], instance: Any) -> dict[str, int]:
        proxy = self.service._managed_run_tracker()
        issue = await proxy.fetch_issue(str(run["parent_issue_id"]))
        state_name = _linear_state_name(issue)
        if state_name in {"blocked", "backlog", "canceled", "cancelled"}:
            return {}
        self.store.approve_plan(
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
        issue = await self.service._managed_run_tracker().fetch_issue(issue_id)
        state_name = _linear_state_name(issue)
        if state_name in {"blocked", "backlog", "canceled", "cancelled"}:
            return False
        resumed = self.store.resume_runtime_wait(str(run["run_id"]))
        if resumed:
            await self.service._managed_run_tracker().comment_issue(
                issue_id,
                "Runtime wait reopened from Linear; the fenced turn will resume on the next polling cycle.",
            )
        return resumed

    async def _project_task_state(self, run: dict[str, Any], instance: Any, task: dict[str, Any], target: str) -> None:
        issue_id = str(task.get("linear_issue_id") or "")
        if not issue_id:
            return
        names, state_type = {
            "todo": (["Backlog", "Todo"], "backlog"),
            "in_progress": (["In Progress", "Started"], "started"),
            "blocked": (["Blocked"], "backlog"),
            "done": (["Done", "Completed"], "completed"),
        }[target]
        await self._transition(parent_id=issue_id, instance=instance, names=names, state_type=state_type)
        self.store.update_task_linear_state(str(run["run_id"]), str(task["task_id"]), target)

    def _log_gate_event(
        self,
        *,
        event: str,
        level: str,
        run: dict[str, Any],
        instance: Any,
        context: TurnContext,
        captured_plan_version: int,
        error_type: str,
        error_code: str,
        sanitized_reason: str,
        action_required: bool,
        retryable: bool,
        next_action: str,
    ) -> None:
        current = self.store.get_run(context.run_id) or run
        fields = (
            f"event={event}",
            f"level={level}",
            f"instance_id={instance.id}",
            f"run_id={context.run_id}",
            f"work_item_id={context.task_id}",
            f"attempt_id={context.attempt_id}",
            f"fencing_token={context.fencing_token}",
            "turn_kind=gate",
            f"plan_version={captured_plan_version}",
            f"current_plan_version={int(current.get('plan_version') or 0)}",
            f"policy_revision={int(current.get('policy_revision') or 0)}",
            f"error_type={error_type}",
            f"error_code={error_code}",
            f"sanitized_reason={sanitized_reason.replace(' ', '_')[:500]}",
            f"action_required={'true' if action_required else 'false'}",
            f"retryable={'true' if retryable else 'false'}",
            f"next_action={next_action}",
        )
        self.runtime.append_event(Path(instance.log_path), " ".join(fields))

    async def _transition(self, *, parent_id: str, instance: Any, names: list[str], state_type: str) -> None:
        proxy = self.service._managed_run_tracker()
        result = await proxy.transition_issue_by_state_target(parent_id, names=names, state_type=state_type)
        if result.get("success") is False:
            raise RuntimeError(f"linear_state_transition_failed:{result.get('reason') or 'unknown'}")

    async def _comment_parent(self, run: dict[str, Any], instance: Any, body: str) -> None:
        await self.service._managed_run_tracker().comment_issue(str(run["parent_issue_id"]), body)

    async def _comment_task(self, run: dict[str, Any], instance: Any, task: dict[str, Any], body: str) -> None:
        issue_id = str(task.get("linear_issue_id") or run["parent_issue_id"])
        await self.service._managed_run_tracker().comment_issue(issue_id, body)

    def _policy_revision(self) -> int:
        return 1

    @staticmethod
    def _execution_policy(instance: Any) -> dict[str, Any]:
        filters = instance.linear_filters if isinstance(instance.linear_filters, dict) else {}
        policy = filters.get("execution_policy")
        return RuntimePolicy.from_dict(policy if isinstance(policy, dict) else {}).to_dict()


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


def _gate_comment(summary: dict[str, Any], note: str) -> str:
    commands = summary.get("commands") if isinstance(summary.get("commands"), dict) else {}
    passed = bool(summary.get("passed"))
    score = int(summary.get("score") or 0)
    threshold = int(summary.get("threshold") or 0)
    command_passed = int(commands.get("passed") or 0)
    command_total = int(commands.get("total") or 0)
    parts = [
        f"Codex Gate {'passed' if passed else 'failed'} ({score}/{threshold}); "
        f"verification commands {command_passed}/{command_total} passed.{note}"
    ]
    catalog = summary.get("catalog") if isinstance(summary.get("catalog"), dict) else {}
    catalog_id = str(catalog.get("id") or "")
    if catalog_id:
        parts.append(f"Catalog {catalog_id}.")
    rubric = summary.get("rubric") if isinstance(summary.get("rubric"), list) else []
    rubric_rows = [_rubric_comment(row) for row in rubric if isinstance(row, dict)]
    if rubric_rows:
        parts.append(f"Rubric {'; '.join(rubric_rows)}.")
    provenance = summary.get("provenance") if isinstance(summary.get("provenance"), list) else []
    sources = [str(row.get("source") or "") for row in provenance if isinstance(row, dict) and row.get("source")]
    if sources:
        parts.append(f"Provenance {', '.join(dict.fromkeys(sources))}.")
    parts.append(
        f"Manifest refs {int(summary.get('manifest_count') or 0)}; "
        f"artifacts {int(summary.get('artifact_count') or 0)}."
    )
    failure_code = str(summary.get("failure_code") or "")
    if failure_code:
        parts.append(f"Failure code {failure_code}.")
    return " ".join(parts)[:1_500]


def _rubric_comment(row: dict[str, Any]) -> str:
    identifier = str(row.get("id") or "")
    score = int(row.get("score") or 0)
    details: list[str] = []
    if "weight" in row:
        details.append(f"weight {int(row.get('weight') or 0)}")
    if "threshold" in row:
        details.append(f"threshold {int(row.get('threshold') or 0)}")
    return f"{identifier}={score}" + (f" ({'; '.join(details)})" if details else "")


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
    return sanitize_reason(str(error).strip()) or error.__class__.__name__


def _linear_state_name(issue: dict[str, Any]) -> str:
    state = issue.get("state")
    if isinstance(state, dict):
        state = state.get("name")
    return str(state or "").strip().lower()


def _performer_readiness_error(
    state: dict[str, Any],
    identity: dict[str, Any],
) -> PerformerControlError:
    compatible_identity = (
        state.get("performer_kind") == identity["performer_kind"]
        and state.get("binding_generation") == identity["binding_generation"]
        and state.get("execution_policy_sha256") == identity["execution_policy_sha256"]
        and int(state.get("capability_version") or 0) > 0
    )
    if not compatible_identity:
        return PerformerControlError(
            error_code="performer_check_required",
            sanitized_reason="The Performer binding or policy changed and requires a new Check.",
            action_required=True,
            retryable=False,
            attempt_number=None,
            next_action="Run the manual Performer Check for the current binding.",
        )
    if state.get("status") == "checking":
        return PerformerControlError(
            error_code="performer_busy",
            sanitized_reason="The Performer manual Check is still running.",
            action_required=False,
            retryable=True,
            attempt_number=state.get("attempt_number"),
            next_action="Wait for the current Check to finish.",
        )
    if state.get("status") == "failed" and state.get("error_code"):
        return PerformerControlError(
            error_code=str(state["error_code"]),
            sanitized_reason=str(
                state.get("sanitized_reason") or "The Performer manual Check failed."
            ),
            action_required=bool(state.get("action_required")),
            retryable=bool(state.get("retryable")),
            attempt_number=state.get("attempt_number"),
            next_action=str(
                state.get("next_action")
                or "Repair the Performer backend configuration and run Check again."
            ),
        )
    return PerformerControlError(
        error_code="performer_check_required",
        sanitized_reason="A successful manual Performer Check is required.",
        action_required=True,
        retryable=False,
        attempt_number=None,
        next_action="Run the manual Performer Check.",
    )


def _performer_block_marker(marker: dict[str, Any]) -> str:
    return "\n".join(
        (
            "## Performer Readiness",
            "Status: blocked",
            f"Error code: `{str(marker.get('error_code') or 'performer_check_required')}`",
            f"Reason: {str(marker.get('sanitized_reason') or 'A successful manual Performer Check is required.')}",
            f"Next action: {str(marker.get('next_action') or 'Run the manual Performer Check.')}",
        )
    )[:1_500]


def _performer_resumed_marker(marker: dict[str, Any]) -> str:
    return "\n".join(
        (
            "## Performer Readiness",
            "Status: resumed",
            "Last Check: passed",
            f"Backend: `{str(marker.get('performer_kind') or 'performer')}`",
            "The compatible manual Performer Check passed and the managed run resumed.",
        )
    )[:1_500]


def _sanitize_command_evidence(
    evidence: dict[str, Any],
    *,
    attempt_id: str,
    plan_version: int,
) -> dict[str, Any]:
    commands = evidence.get("commands") if isinstance(evidence.get("commands"), list) else []
    passed = sum(1 for command in commands if isinstance(command, dict) and command.get("passed") is True)
    normalized = canonical_gate_evidence(
        {"commands": commands},
        passed=passed == len(commands),
        score=1,
        threshold=1,
        attempt_id=attempt_id,
        plan_version=max(1, plan_version),
        catalog=None,
        manifest_refs=[],
        command_passed=passed,
        command_total=len(commands),
    )
    return {"commands": normalized["commands"]}


__all__ = ["WorkflowDriver"]
