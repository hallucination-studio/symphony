from __future__ import annotations

from pathlib import Path
from typing import Any

from performer_api.pipeline import HumanEscalationReason, RuntimeMode

from .mode_common import (
    _attempt_event_printer,
    _fencing_fields,
    _managed_codex_backend,
    _optional_payload_str,
    _payload_kind,
    _sanitize_error,
    _thread_state_workspace_path,
)
from .workspace_execution_state import WorkspaceExecutionState


from .plan_mode_schema import PLAN_RESULT_SCHEMA
from .plan_mode_helpers import (
    _planner_prompt,
    _planner_prompt_payload,
    _planner_retry_prompt,
    _planner_structured_result,
    _planner_workspace_path,
    _positive_int,
    _proposal_blocks,
    _proposal_from_model_payload,
)


async def _run_plan_mode(payload: dict[str, object], *, agent_backend: Any | None = None) -> dict[str, object]:
    attempt_id = str(payload.get("attempt_id") or payload.get("plan_attempt_id") or "plan-attempt")
    graph_id = str(payload.get("graph_id") or "graph")
    root_node_id = str(payload.get("root_node_id") or str(payload.get("issue_id") or "root"))
    node_id = str(payload.get("node_id") or root_node_id)
    title = str(payload.get("title") or payload.get("issue_identifier") or node_id)
    try:
        backend = agent_backend or _managed_codex_backend()
    except RuntimeError as exc:
        return _failed_plan_result(
            payload,
            attempt_id=attempt_id,
            node_id=node_id,
            error=str(exc),
        )
    prompt = _planner_prompt(payload)
    workspace = _planner_workspace_path(payload)
    if workspace is None:
        return _failed_plan_result(
            payload,
            attempt_id=attempt_id,
            node_id=node_id,
            error="planner_workspace_required",
        )
    last_error = "invalid_plan_proposal"
    for _attempt in range(2):
        result, failure = await _invoke_planner_backend(
            payload,
            backend,
            workspace,
            prompt,
            attempt_id=attempt_id,
            node_id=node_id,
            title=title,
        )
        if failure is not None:
            return failure
        structured = _planner_structured_result(result)
        if not isinstance(structured, dict):
            last_error = "invalid_plan_proposal:missing_structured_result"
            prompt = _planner_retry_prompt(payload, last_error)
            continue
        proposal_payload = structured.get("proposal")
        if not isinstance(proposal_payload, dict):
            last_error = "invalid_plan_proposal:missing_proposal"
            prompt = _planner_retry_prompt(payload, last_error)
            continue
        try:
            proposal = _proposal_from_model_payload(proposal_payload, attempt_id=attempt_id)
        except (TypeError, ValueError) as exc:
            last_error = f"invalid_plan_proposal:{_sanitize_error(exc)}"
            prompt = _planner_retry_prompt(payload, last_error)
            continue
        return {
            "attempt_id": attempt_id,
            "node_id": node_id,
            "mode": RuntimeMode.PLAN.value,
            "status": "succeeded",
            **_fencing_fields(payload),
            "gate_snapshot_hash": "",
            "thread_id": getattr(result, "thread_id", None),
            "kind": _payload_kind(payload, default="codex"),
            "proposal": proposal.to_dict(),
        }
    return _failed_plan_result(
        payload,
        attempt_id=attempt_id,
        node_id=node_id,
        error=last_error,
    )


async def _invoke_planner_backend(
    payload: dict[str, object],
    backend: Any,
    workspace: Path,
    prompt: str,
    *,
    attempt_id: str,
    node_id: str,
    title: str,
) -> tuple[object | None, dict[str, object] | None]:
    try:
        execution_state = WorkspaceExecutionState(_thread_state_workspace_path(payload, fallback=workspace))
        existing_thread_id = execution_state.sdk_thread_id(issue_id=node_id)
        expected_thread_id = _optional_payload_str(payload.get("expected_thread_id"))
        if expected_thread_id and existing_thread_id != expected_thread_id:
            return None, _failed_plan_result(
                payload,
                attempt_id=attempt_id,
                node_id=node_id,
                error=HumanEscalationReason.THREAD_LOST.value,
                thread_id=expected_thread_id,
            )
        result = await backend.run_session(
            workspace,
            prompt,
            f"Plan {title}",
            on_event=_attempt_event_printer(RuntimeMode.PLAN, attempt_id=attempt_id, node_id=node_id),
            output_schema=PLAN_RESULT_SCHEMA,
            max_turns=1,
            existing_thread_id=existing_thread_id,
        )
        execution_state.write_sdk_thread(issue_id=node_id, result=result)
        return result, None
    except Exception as exc:
        return None, _failed_plan_result(
            payload,
            attempt_id=attempt_id,
            node_id=node_id,
            error=_sanitize_error(exc),
        )


def _failed_plan_result(
    payload: dict[str, object],
    *,
    attempt_id: str,
    node_id: str,
    error: str,
    thread_id: str | None = None,
) -> dict[str, object]:
    return {
        "attempt_id": attempt_id,
        "node_id": node_id,
        "mode": RuntimeMode.PLAN.value,
        "status": "failed",
        **_fencing_fields(payload),
        "gate_snapshot_hash": "",
        "proposal": None,
        "error": error,
        "thread_id": thread_id,
        "kind": _payload_kind(payload, default="codex"),
    }
