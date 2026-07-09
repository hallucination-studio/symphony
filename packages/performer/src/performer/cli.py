from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
from typing import Any

from performer_api.config import CodexConfig
from performer_api.pipeline import (
    GateSpecContent,
    GateSpecSnapshot,
    GateStepSource,
    GraphNode,
    HumanEscalationReason,
    PASS_THRESHOLD,
    PlanProposal,
    RuntimeMode,
)

from .codex_client import CodexSdkClient
from .workspace_execution_state import WorkspaceExecutionState


PLAN_RESULT_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "proposal": {
            "type": "object",
            "properties": {
                "graph_id": {"type": "string"},
                "plan_attempt_id": {"type": "string"},
                "root_node_id": {"type": "string"},
                "nodes": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "node_id": {"type": "string"},
                            "title": {"type": "string"},
                            "state": {
                                "type": "string",
                                "enum": [
                                    "planned",
                                    "ready",
                                    "executing",
                                    "execute_failed",
                                    "verifying",
                                    "verify_passed",
                                    "verify_failed",
                                    "replanning",
                                    "superseded",
                                    "need_human",
                                    "failed",
                                ],
                            },
                            "issue_id": {"type": "string"},
                            "issue_identifier": {"type": "string"},
                            "parent_node_id": {"type": "string"},
                            "gate_snapshot_hash": {"type": "string"},
                            "verify_score": {"type": "integer"},
                            "rework_count": {"type": "integer"},
                            "human_reason": {
                                "type": "string",
                                "enum": ["", *[reason.value for reason in HumanEscalationReason]],
                            },
                            "aggregate_state": {"type": "string"},
                            "superseded_by": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": [
                            "node_id",
                            "title",
                            "state",
                            "issue_id",
                            "issue_identifier",
                            "parent_node_id",
                            "gate_snapshot_hash",
                            "verify_score",
                            "rework_count",
                            "human_reason",
                            "aggregate_state",
                            "superseded_by",
                        ],
                        "additionalProperties": False,
                    },
                },
                "blocks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"from_node_id": {"type": "string"}, "to_node_id": {"type": "string"}},
                        "required": ["from_node_id", "to_node_id"],
                        "additionalProperties": False,
                    },
                },
                "gates": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "gate_id": {"type": "string"},
                            "task_id": {"type": "string"},
                            "created_by": {"type": "string"},
                            "created_at": {"type": "string"},
                            "hash": {"type": "string"},
                            "content": {
                                "type": "object",
                                "properties": {
                                    "acceptance_criteria": {"type": "array", "items": {"type": "string"}},
                                    "verification_procedure": {
                                        "type": "array",
                                        "items": {
                                            "type": "object",
                                            "properties": {
                                                "step": {"type": "string"},
                                                "source": {
                                                    "type": "string",
                                                    "enum": [
                                                        "issue_requirement",
                                                        "appendix_harness",
                                                        "planner_inferred",
                                                        "system_repair",
                                                    ],
                                                },
                                            },
                                            "required": ["step", "source"],
                                            "additionalProperties": False,
                                        },
                                    },
                                    "rubric": {
                                        "type": "object",
                                        "properties": {str(score): {"type": "string"} for score in range(5)},
                                        "required": [str(score) for score in range(5)],
                                        "additionalProperties": False,
                                    },
                                    "pass_threshold": {"type": "integer"},
                                    "required_credentials": {"type": "array", "items": {"type": "string"}},
                                    "artifact_expectations": {"type": "array", "items": {"type": "string"}},
                                },
                                "required": [
                                    "acceptance_criteria",
                                    "verification_procedure",
                                    "rubric",
                                    "pass_threshold",
                                    "required_credentials",
                                    "artifact_expectations",
                                ],
                                "additionalProperties": False,
                            },
                        },
                        "required": ["gate_id", "task_id", "created_by", "created_at", "hash", "content"],
                        "additionalProperties": False,
                    },
                },
                "entry_node_ids": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                "exit_node_ids": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                "max_subtasks": {"type": "integer"},
                "policy": {
                    "type": "object",
                    "properties": {
                        "max_subtasks": {"type": "integer"},
                        "allowed_edge_kinds": {"type": "array", "items": {"type": "string"}},
                        "dependency_policy": {"type": "string"},
                    },
                    "required": ["max_subtasks", "allowed_edge_kinds", "dependency_policy"],
                    "additionalProperties": False,
                },
            },
            "required": [
                "graph_id",
                "plan_attempt_id",
                "root_node_id",
                "nodes",
                "blocks",
                "gates",
                "entry_node_ids",
                "exit_node_ids",
                "max_subtasks",
                "policy",
            ],
            "additionalProperties": False,
        }
    },
    "required": ["proposal"],
    "additionalProperties": False,
}


async def run_mode_attempt(
    mode: RuntimeMode,
    attempt_request_path: Path,
    attempt_result_path: Path,
    *,
    agent_backend: Any | None = None,
) -> dict[str, object]:
    try:
        payload = json.loads(attempt_request_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"could not read {mode.value} attempt request: {attempt_request_path}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"{mode.value} attempt request must be a JSON object: {attempt_request_path}")
    if mode is RuntimeMode.PLAN:
        result = await _run_plan_mode(payload, agent_backend=agent_backend)
    elif mode is RuntimeMode.EXECUTE:
        result = await _run_execute_mode(payload, agent_backend=agent_backend)
    elif mode is RuntimeMode.VERIFY:
        result = _run_verify_mode(payload)
    else:
        raise RuntimeError(f"unsupported runtime mode: {mode.value}")
    _write_json_atomic(attempt_result_path, result)
    return result


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
        try:
            execution_state = WorkspaceExecutionState(_thread_state_workspace_path(payload, fallback=workspace))
            existing_thread_id = execution_state.sdk_thread_id(issue_id=node_id)
            expected_thread_id = _optional_payload_str(payload.get("expected_thread_id"))
            if expected_thread_id and existing_thread_id != expected_thread_id:
                return _failed_plan_result(
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
        except Exception as exc:
            return _failed_plan_result(
                payload,
                attempt_id=attempt_id,
                node_id=node_id,
                error=_sanitize_error(exc),
            )
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


def _planner_prompt(payload: dict[str, object]) -> str:
    issue_identifier = str(payload.get("issue_identifier") or payload.get("issue_id") or "")
    title = str(payload.get("title") or issue_identifier or payload.get("node_id") or "")
    issue_description = str(payload.get("issue_description") or "").strip()
    prompt_payload = _planner_prompt_payload(payload)
    pipeline_intent_instruction = ""
    if isinstance(payload.get("pipeline_intent"), dict) and payload.get("pipeline_intent"):
        pipeline_intent_instruction = (
            "The attempt request includes `pipeline_intent`, a structured Conductor intent contract. "
            "Use any node_ids named there exactly in the returned proposal so Conductor can validate the shape. "
        )
    replan_instruction = ""
    if isinstance(payload.get("failure_context"), dict) and payload.get("failure_context"):
        failed_node_id = str(payload.get("node_id") or "").strip()
        replan_instruction = (
            "This is a replan after a failed verify attempt. Return a replacement subgraph with "
            "new node_ids. The replacement proposal must not reuse the failed node_id"
            f"{f' `{failed_node_id}`' if failed_node_id else ''}; Conductor will preserve that failed node as superseded. "
            "The replacement proposal must preserve the original issue description's concrete file paths, commands, and success conditions. "
            "It must not replace `SYMPHONY_REAL_E2E_RESULT.md` with a different result file when that file was requested, "
            "and it must not drop `pytest tests/test_smoke.py -q` if it was part of the original task. "
        )
    return (
        "Produce a Symphony PlanProposal JSON object in a top-level `proposal` field. "
        "Every node must have a frozen gate snapshot, valid 0-4 rubric, pass_threshold=3, "
        "and dependency edges must be acyclic. The proposal must contain at least one planned "
        "executable node, at least one frozen gate whose task_id matches a node_id, and non-empty "
        "entry_node_ids and exit_node_ids. Do not return an empty plan. Entry nodes must exactly "
        "be nodes with no incoming blocks; exit nodes must exactly be nodes with no outgoing blocks. "
        "The root business-issue node must be the parent when a plan has multiple subtasks: every subtask node must set "
        "parent_node_id to root_node_id, and the root node has no gate and no blocks edges. Parent-child aggregation is "
        "not a dependency edge. "
        "Use the Linear issue description as the source of task truth; the frozen gate acceptance "
        "criteria and verification procedure must preserve concrete requested files, commands, and "
        "success conditions from that description. Each verification_procedure entry must carry "
        "a step and source provenance. Use source=issue_requirement for checks traceable to the "
        "issue, source=appendix_harness for acceptance harness checks, and source=planner_inferred "
        "only for unmandated planner elaboration. Every gate needs at least one authoritative "
        "source. Each step must be an executable POSIX shell command run from the workspace root, not prose or markdown. Use "
        "commands such as `test -f RELPATH`, `grep -q TEXT RELPATH`, and `pytest tests/test_smoke.py -q`; "
        "do not write steps like `Read the file`, `From the workspace root`, or `Run ... and confirm`. "
        "Do not freeze absolute local filesystem paths "
        "from this planner process into gates; refer to repository files by relative path or by "
        "`workspace root` so the executor and verifier can run in isolated workspaces. "
        f"{pipeline_intent_instruction}"
        f"{replan_instruction}\n\n"
        f"Task context:\nIssue: {issue_identifier}\nTitle: {title}\nDescription:\n{issue_description or '(none)'}\n\n"
        f"Attempt request:\n{json.dumps(prompt_payload, sort_keys=True)}"
    )


def _planner_retry_prompt(payload: dict[str, object], reason: str) -> str:
    return (
        f"{_planner_prompt(payload)}\n\n"
        f"The previous PlanProposal was rejected with `{reason}`. Return a corrected non-empty "
        "proposal that satisfies the validator. Do not repeat the rejected shape."
    )


def _planner_prompt_payload(payload: dict[str, object]) -> dict[str, object]:
    prompt_payload = dict(payload)
    if "workspace_path" in prompt_payload:
        prompt_payload["workspace_path"] = "<planner-workspace>"
    return prompt_payload


def _planner_workspace_path(payload: dict[str, object]) -> Path | None:
    workspace_path = _optional_payload_str(payload.get("workspace_path"))
    if not workspace_path:
        return None
    workspace = Path(workspace_path)
    if not workspace.is_dir():
        return None
    return workspace


def _planner_structured_result(result: object) -> dict[str, object] | None:
    structured = getattr(result, "structured_result", None)
    if isinstance(structured, dict):
        return structured
    final_response = getattr(result, "final_response", None)
    if not isinstance(final_response, str) or not final_response.strip():
        return None
    try:
        parsed = json.loads(final_response)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _proposal_from_model_payload(payload: dict[str, object], *, attempt_id: str) -> PlanProposal:
    gates: list[GateSpecSnapshot] = []
    for item in payload.get("gates") or []:
        if not isinstance(item, dict):
            continue
        content = GateSpecContent.from_dict(item.get("content") if isinstance(item.get("content"), dict) else {})
        task_id = str(item.get("task_id") or "")
        gate_id = str(item.get("gate_id") or f"gate-{task_id}")
        gates.append(
            GateSpecSnapshot.create(
                gate_id=gate_id,
                task_id=task_id,
                created_by=str(item.get("created_by") or attempt_id),
                created_at=str(item.get("created_at") or ""),
                content=content,
                version=_positive_int(item.get("version"), default=1),
            )
        )
    gate_by_task = {gate.task_id: gate for gate in gates}
    nodes: list[GraphNode] = []
    for item in payload.get("nodes") or []:
        if not isinstance(item, dict):
            continue
        node_payload = dict(item)
        node_payload["state"] = str(node_payload.get("state") or "planned").lower()
        reason = str(node_payload.get("human_reason") or "")
        if reason and reason not in {item.value for item in HumanEscalationReason}:
            node_payload["human_reason"] = ""
        node = GraphNode.from_dict(node_payload)
        gate = gate_by_task.get(node.node_id)
        nodes.append(
            GraphNode(
                node_id=node.node_id,
                title=node.title,
                state=node.state,
                issue_id=node.issue_id,
                issue_identifier=node.issue_identifier,
                parent_node_id=node.parent_node_id,
                gate_snapshot_hash=gate.hash if gate is not None else node.gate_snapshot_hash,
                verify_score=node.verify_score,
                rework_count=node.rework_count,
                superseded_by=node.superseded_by,
                human_reason=node.human_reason,
            )
        )
    return PlanProposal(
        graph_id=str(payload.get("graph_id") or ""),
        plan_attempt_id=str(payload.get("plan_attempt_id") or attempt_id),
        root_node_id=str(payload.get("root_node_id") or ""),
        nodes=nodes,
        blocks=_proposal_blocks(payload.get("blocks")),
        gates=gates,
        entry_node_ids=[str(item) for item in payload.get("entry_node_ids") or []],
        exit_node_ids=[str(item) for item in payload.get("exit_node_ids") or []],
    )


def _proposal_blocks(value: object) -> list[tuple[str, str]]:
    blocks: list[tuple[str, str]] = []
    for item in value or []:  # type: ignore[union-attr]
        if isinstance(item, dict):
            source = str(item.get("from_node_id") or item.get("source") or "")
            target = str(item.get("to_node_id") or item.get("target") or "")
            if source or target:
                blocks.append((source, target))
        elif isinstance(item, (list, tuple)) and len(item) == 2:
            blocks.append((str(item[0]), str(item[1])))
    return blocks


def _positive_int(value: object, *, default: int) -> int:
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


async def _run_execute_mode(payload: dict[str, object], *, agent_backend: Any | None = None) -> dict[str, object]:
    attempt_id = str(payload.get("attempt_id") or "execute-attempt")
    node_id = str(payload.get("node_id") or payload.get("task_id") or "")
    gate_hash = str(payload.get("gate_snapshot_hash") or "")
    workspace_path = _execute_workspace_path(payload)
    source_repository_path = _execute_repository_path(payload)
    verification_input: dict[str, object]
    if workspace_path:
        workspace = Path(workspace_path)
        if source_repository_path and Path(source_repository_path) != workspace:
            _materialize_execute_workspace(
                source_repository_path=Path(source_repository_path),
                workspace_path=workspace,
                base_revision=str(payload.get("base_revision") or ""),
            )
        try:
            backend = agent_backend or _managed_codex_backend()
        except RuntimeError as exc:
            return {
                "attempt_id": attempt_id,
                "mode": RuntimeMode.EXECUTE.value,
                "status": "failed",
                **_fencing_fields(payload),
                "node_id": node_id,
                "gate_snapshot_hash": gate_hash,
                "verification_input": {},
                "error": str(exc),
                "kind": _payload_kind(payload, default="codex"),
            }
        try:
            on_event = _attempt_event_printer(RuntimeMode.EXECUTE, attempt_id=attempt_id, node_id=node_id)
            await _emit_runtime_wait_probe_if_requested(on_event)
            execution_state = WorkspaceExecutionState(_thread_state_workspace_path(payload, fallback=workspace))
            existing_thread_id = execution_state.sdk_thread_id(issue_id=node_id)
            expected_thread_id = _optional_payload_str(payload.get("expected_thread_id"))
            if expected_thread_id and existing_thread_id != expected_thread_id:
                return _failed_execute_result(
                    payload,
                    attempt_id=attempt_id,
                    node_id=node_id,
                    gate_hash=gate_hash,
                    error=HumanEscalationReason.THREAD_LOST.value,
                    thread_id=expected_thread_id,
                )
            result = await backend.run_session(
                workspace,
                _executor_prompt(payload),
                f"Execute {node_id}",
                on_event=on_event,
                max_turns=1,
                existing_thread_id=existing_thread_id,
            )
            execution_state.write_sdk_thread(issue_id=node_id, result=result)
        except Exception as exc:
            return _failed_execute_result(
                payload,
                attempt_id=attempt_id,
                node_id=node_id,
                gate_hash=gate_hash,
                error=_sanitize_error(exc),
            )
        verification_input = _collect_git_verification_input(
            workspace_path=workspace,
            attempt_id=attempt_id,
            node_id=node_id,
            gate_hash=gate_hash,
            base_revision=str(payload.get("base_revision") or ""),
            repository_path=source_repository_path,
        )
    else:
        verification_input = {
            "task_id": node_id,
            "execute_attempt_id": attempt_id,
            "base_revision": str(payload.get("base_revision") or ""),
            "patch_uri": str(payload.get("patch_uri") or ""),
            "patch_hash": str(payload.get("patch_hash") or ""),
            "expected_result_tree": str(payload.get("expected_result_tree") or ""),
            "artifact_uris": list(payload.get("artifact_uris") or []),
            "declared_commands": list(payload.get("declared_commands") or []),
            "evidence_uri": str(payload.get("evidence_uri") or ""),
            "gate_snapshot_hash": gate_hash,
            "result_revision": _optional_payload_str(payload.get("result_revision")),
        }
    return {
        "attempt_id": attempt_id,
        "mode": RuntimeMode.EXECUTE.value,
        "status": "succeeded",
        **_fencing_fields(payload),
        "node_id": node_id,
        "gate_snapshot_hash": gate_hash,
        "thread_id": locals().get("result") and getattr(locals()["result"], "thread_id", None),
        "kind": _payload_kind(payload, default="codex"),
        "verification_input": verification_input,
    }


def _failed_execute_result(
    payload: dict[str, object],
    *,
    attempt_id: str,
    node_id: str,
    gate_hash: str,
    error: str,
    thread_id: str | None = None,
) -> dict[str, object]:
    return {
        "attempt_id": attempt_id,
        "mode": RuntimeMode.EXECUTE.value,
        "status": "failed",
        **_fencing_fields(payload),
        "node_id": node_id,
        "gate_snapshot_hash": gate_hash,
        "verification_input": {},
        "error": error,
        "thread_id": thread_id,
        "kind": _payload_kind(payload, default="codex"),
    }


def _executor_prompt(payload: dict[str, object]) -> str:
    gate_snapshot = payload.get("gate_snapshot")
    issue_identifier = str(payload.get("issue_identifier") or payload.get("node_id") or "")
    task_title = str(payload.get("task_title") or payload.get("node_id") or "")
    issue_description = str(payload.get("issue_description") or "").strip()
    return (
        "Implement exactly the requested Symphony pipeline node in this workspace. "
        "Do not mutate the frozen gate. Leave the repository with the patch that "
        "the verifier should apply against the baseline. Treat the task context and "
        "frozen gate as binding; if they name a specific file or command, do that "
        "specific work instead of broad investigation. All file writes must happen "
        "inside the current execution workspace. If a gate or issue text mentions an "
        "absolute path outside the current workspace, interpret the requested repository "
        "file relative to the current workspace root.\n\n"
        f"Task context:\nIssue: {issue_identifier}\nTitle: {task_title}\nDescription:\n{issue_description or '(none)'}\n\n"
        f"Attempt request:\n{json.dumps({**payload, 'gate_snapshot': gate_snapshot}, sort_keys=True, default=str)}"
    )


def _managed_codex_backend() -> CodexSdkClient:
    codex_home = os.environ.get("CODEX_HOME")
    if not codex_home:
        raise RuntimeError("managed_codex_home_required")
    if not Path(codex_home).is_dir():
        raise RuntimeError("managed_codex_home_required")
    return CodexSdkClient(
        CodexConfig(
            model=_env_str("CODEX_MODEL"),
            sdk_codex_bin=_env_str("CODEX_SDK_CODEX_BIN"),
            sandbox=_env_sandbox("CODEX_SANDBOX"),
            config_overrides=_env_config_overrides("CODEX_CONFIG_OVERRIDES"),
            hard_turn_timeout_ms=_env_int("CODEX_HARD_TURN_TIMEOUT_MS", 3_600_000),
            read_timeout_ms=_env_int("CODEX_READ_TIMEOUT_MS", 5_000),
            init_max_attempts=_env_int("CODEX_INIT_MAX_ATTEMPTS", 4),
            init_backoff_ms=_env_int("CODEX_INIT_BACKOFF_MS", 500),
            init_backoff_max_ms=_env_int("CODEX_INIT_BACKOFF_MAX_MS", 8_000),
            overload_max_attempts=_env_int("CODEX_OVERLOAD_MAX_ATTEMPTS", 5),
            overload_initial_delay_ms=_env_int("CODEX_OVERLOAD_INITIAL_DELAY_MS", 250),
            overload_max_delay_ms=_env_int("CODEX_OVERLOAD_MAX_DELAY_MS", 8_000),
        )
    )


async def _emit_runtime_wait_probe_if_requested(on_event: Any) -> None:
    if not _env_bool("SYMPHONY_EMIT_RUNTIME_WAIT_PROBE") and not _env_bool("CODEX_EMIT_RUNTIME_WAIT_PROBE"):
        return
    if not callable(on_event):
        return
    on_event(
        {
            "event": "sdk_approval_requested",
            "message": "waiting for command approval from runtime wait probe",
            "command": "symphony-runtime-wait-probe",
        }
    )
    delay_seconds = _env_float("SYMPHONY_RUNTIME_WAIT_PROBE_SECONDS", _env_float("CODEX_RUNTIME_WAIT_PROBE_SECONDS", 0.0))
    if delay_seconds > 0:
        await asyncio.sleep(delay_seconds)


def _attempt_event_printer(mode: RuntimeMode, *, attempt_id: str, node_id: str):
    def emit(event: dict[str, Any]) -> None:
        event_name = str(event.get("event") or event.get("type") or "codex_event")
        payload = {
            "event": "performer_attempt_event",
            "mode": mode.value,
            "attempt_id": attempt_id,
            "node_id": node_id,
            "codex_event": event_name,
        }
        for key in ("thread_id", "turn_id", "session_id", "message", "command", "exit_code", "http_status", "timeout_ms"):
            if key in event and event[key] is not None:
                payload[key] = _sanitize_error(str(event[key]))
        print(json.dumps(payload, sort_keys=True), flush=True)

    return emit


def _env_str(key: str) -> str | None:
    value = os.environ.get(key)
    if value is None:
        return None
    value = value.strip()
    return value or None


def _env_bool(key: str) -> bool:
    return str(os.environ.get(key) or "").strip().lower() in {"1", "true", "yes", "on"}


def _env_float(key: str, default: float) -> float:
    value = os.environ.get(key)
    if value is None or not value.strip():
        return default
    try:
        parsed = float(value)
    except ValueError:
        return default
    return parsed if parsed >= 0 else default


def _env_sandbox(key: str) -> str | None:
    value = _env_str(key)
    if value is None:
        return None
    return value.replace("-", "_")


def _env_int(key: str, default: int) -> int:
    value = os.environ.get(key)
    if value is None or not value.strip():
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


def _env_config_overrides(key: str) -> tuple[str, ...]:
    raw = os.environ.get(key)
    if raw is None or not raw.strip():
        return ()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return tuple(item for item in raw.split(os.pathsep) if item)
    if not isinstance(parsed, list):
        return ()
    return tuple(str(item) for item in parsed if str(item).strip())


def _execute_workspace_path(payload: dict[str, object]) -> str | None:
    direct = _optional_payload_str(payload.get("workspace_path"))
    if direct:
        return direct
    artifact_paths = payload.get("artifact_paths")
    if isinstance(artifact_paths, dict):
        workspace = _optional_payload_str(artifact_paths.get("workspace_path"))
        if workspace:
            return workspace
        attempt_dir = _optional_payload_str(artifact_paths.get("attempt_dir"))
        if attempt_dir:
            return str(Path(attempt_dir) / "workspace")
    return _execute_repository_path(payload)


def _thread_state_workspace_path(payload: dict[str, object], *, fallback: Path) -> Path:
    thread_state_workspace = _optional_payload_str(payload.get("thread_state_workspace_path"))
    if thread_state_workspace:
        return Path(thread_state_workspace)
    return fallback


def _payload_kind(payload: dict[str, object], *, default: str) -> str:
    return _optional_payload_str(payload.get("kind")) or default


def _execute_repository_path(payload: dict[str, object]) -> str | None:
    repository = payload.get("repository")
    if isinstance(repository, dict):
        resolved_repo_path = _optional_payload_str(repository.get("resolved_repo_path"))
        if resolved_repo_path:
            return resolved_repo_path
    return None


def _materialize_execute_workspace(
    *,
    source_repository_path: Path,
    workspace_path: Path,
    base_revision: str,
) -> None:
    if workspace_path.exists():
        shutil.rmtree(workspace_path)
    workspace_path.parent.mkdir(parents=True, exist_ok=True)
    _git(["clone", "--quiet", str(source_repository_path), str(workspace_path)], cwd=source_repository_path)
    if base_revision:
        _git(["checkout", "--quiet", base_revision], cwd=workspace_path)


def _run_verify_mode(payload: dict[str, object]) -> dict[str, object]:
    verification_input = payload.get("verification_input")
    if not isinstance(verification_input, dict):
        raise RuntimeError("verify mode requires verification_input")
    gate_snapshot_payload = payload.get("gate_snapshot")
    gate_snapshot = GateSpecSnapshot.from_dict(gate_snapshot_payload) if isinstance(gate_snapshot_payload, dict) else None
    gate_hash = str(payload.get("gate_snapshot_hash") or verification_input.get("gate_snapshot_hash") or "")
    if gate_snapshot is None or not gate_snapshot.frozen or not gate_hash:
        return _failed_verify_result(payload, verification_input, gate_hash, "frozen_gate_required")
    if gate_snapshot is not None and gate_snapshot.hash != gate_hash:
        return _failed_verify_result(payload, verification_input, gate_hash, "gate_snapshot_hash_mismatch")
    if str(verification_input.get("gate_snapshot_hash") or "") != gate_hash:
        return _failed_verify_result(payload, verification_input, gate_hash, "gate_snapshot_hash_mismatch")
    forced_failure = _forced_first_verify_failure_reason()
    if forced_failure is not None:
        return _failed_gate_verify_result(payload, verification_input, gate_hash, forced_failure)
    patch_verification = _verify_patch_hash(verification_input)
    if patch_verification.reason is not None:
        return _failed_verify_result(payload, verification_input, gate_hash, patch_verification.reason)
    artifact_mismatch = _verify_artifact_hashes(verification_input)
    if artifact_mismatch is not None:
        return _failed_verify_result(payload, verification_input, gate_hash, artifact_mismatch)
    command_failure = _run_gate_commands(gate_snapshot, verification_input, verification_workspace=patch_verification.workspace)
    if command_failure is not None:
        return _failed_verify_result(payload, verification_input, gate_hash, command_failure)
    return {
        "attempt_id": str(payload.get("attempt_id") or "verify-attempt"),
        "node_id": str(payload.get("node_id") or verification_input.get("task_id") or ""),
        "execute_attempt_id": str(payload.get("execute_attempt_id") or verification_input.get("execute_attempt_id") or ""),
        "mode": RuntimeMode.VERIFY.value,
        "status": "succeeded",
        **_fencing_fields(payload),
        "score": PASS_THRESHOLD,
        "passed": True,
        "gate_snapshot_hash": gate_hash,
        "verification_input": dict(verification_input),
        "kind": _payload_kind(payload, default="local-verifier"),
    }


def _failed_verify_result(
    payload: dict[str, object],
    verification_input: dict[str, object],
    gate_hash: str,
    reason: str,
) -> dict[str, object]:
    sanitized_reason = reason.replace("\x00", "").strip()[:500] or "verify_failed"
    return {
        "attempt_id": str(payload.get("attempt_id") or "verify-attempt"),
        "node_id": str(payload.get("node_id") or verification_input.get("task_id") or ""),
        "execute_attempt_id": str(payload.get("execute_attempt_id") or verification_input.get("execute_attempt_id") or ""),
        "mode": RuntimeMode.VERIFY.value,
        "status": "failed",
        **_fencing_fields(payload),
        "gate_snapshot_hash": gate_hash,
        "score": 0,
        "passed": False,
        "reason": sanitized_reason,
        "error": sanitized_reason,
        "kind": _payload_kind(payload, default="local-verifier"),
    }


def _failed_gate_verify_result(
    payload: dict[str, object],
    verification_input: dict[str, object],
    gate_hash: str,
    reason: str,
) -> dict[str, object]:
    sanitized_reason = reason.replace("\x00", "").strip()[:500] or "verify_failed"
    return {
        "attempt_id": str(payload.get("attempt_id") or "verify-attempt"),
        "node_id": str(payload.get("node_id") or verification_input.get("task_id") or ""),
        "execute_attempt_id": str(payload.get("execute_attempt_id") or verification_input.get("execute_attempt_id") or ""),
        "mode": RuntimeMode.VERIFY.value,
        "status": "succeeded",
        **_fencing_fields(payload),
        "gate_snapshot_hash": gate_hash,
        "score": 0,
        "passed": False,
        "error": sanitized_reason,
        "verification_input": dict(verification_input),
        "kind": _payload_kind(payload, default="local-verifier"),
    }


def _forced_first_verify_failure_reason() -> str | None:
    if os.environ.get("SYMPHONY_FORCE_FIRST_VERIFY_FAILURE_FOR_REPLAN") != "1":
        return None
    verifier_home = (
        os.environ.get("SYMPHONY_LOCAL_VERIFIER_PROBE_HOME", "").strip()
        or os.environ.get("SYMPHONY_LOCAL_VERIFIER_HOME", "").strip()
    )
    if not verifier_home:
        return None
    marker = Path(verifier_home) / "forced-first-verify-failure-for-replan.done"
    if marker.exists():
        return None
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("forced_first_verify_failure_for_replan\n", encoding="utf-8")
    return "forced_first_verify_failure_for_replan"


def _collect_git_verification_input(
    *,
    workspace_path: Path,
    attempt_id: str,
    node_id: str,
    gate_hash: str,
    base_revision: str,
    repository_path: str | None = None,
) -> dict[str, object]:
    _remove_generated_verification_caches(workspace_path)
    _git(["add", "--all"], cwd=workspace_path)
    no_changes = _git_command_succeeds(["diff", "--cached", "--quiet"], cwd=workspace_path)
    if not no_changes:
        _git(["commit", "--quiet", "-m", f"Execute pipeline node {node_id}"], cwd=workspace_path)
    branch_name = _git(["branch", "--show-current"], cwd=workspace_path).strip()
    commit_sha = _git(["rev-parse", "HEAD"], cwd=workspace_path).strip()
    evidence_path = workspace_path / ".symphony" / "pipeline" / attempt_id / "evidence.json"
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_path.write_text(
        json.dumps(
            {
                "attempt_id": attempt_id,
                "node_id": node_id,
                "branch_name": branch_name,
                "commit_sha": commit_sha,
                "no_changes": no_changes,
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    return {
        "task_id": node_id,
        "execute_attempt_id": attempt_id,
        "base_revision": base_revision or _git(["rev-parse", "HEAD"], cwd=workspace_path).strip(),
        "repository_path": repository_path or str(workspace_path),
        "workspace_path": str(workspace_path),
        "branch_name": branch_name,
        "commit_sha": commit_sha,
        "no_changes": no_changes,
        "artifact_uris": [{"uri": f"file://{evidence_path}", "sha256": _file_sha256(evidence_path), "type": "evidence"}],
        "declared_commands": [],
        "evidence_uri": f"file://{evidence_path}",
        "gate_snapshot_hash": gate_hash,
    }


def _git_command_succeeds(args: list[str], *, cwd: Path) -> bool:
    return subprocess.run(["git", *args], cwd=cwd, check=False, capture_output=True, text=True).returncode == 0


class _PatchVerificationResult:
    def __init__(self, *, reason: str | None = None, workspace: Path | None = None):
        self.reason = reason
        self.workspace = workspace


def _verify_patch_hash(verification_input: dict[str, object]) -> _PatchVerificationResult:
    commit_sha = _optional_payload_str(verification_input.get("commit_sha"))
    if commit_sha:
        workspace = _optional_payload_str(verification_input.get("repository_path"))
        if not workspace:
            return _PatchVerificationResult(reason="commit_unavailable")
        verify_workspace = _commit_verify_workspace(verification_input, fallback_parent=Path(workspace))
        if verify_workspace.exists():
            shutil.rmtree(verify_workspace)
        try:
            verify_workspace.parent.mkdir(parents=True, exist_ok=True)
            _git(["worktree", "add", "--detach", "--quiet", str(verify_workspace), commit_sha], cwd=Path(workspace))
        except (subprocess.SubprocessError, OSError):
            return _PatchVerificationResult(reason="verification_workspace_unavailable")
        return _PatchVerificationResult(workspace=verify_workspace)
    patch_uri = str(verification_input.get("patch_uri") or "")
    expected_hash = str(verification_input.get("patch_hash") or "")
    if not patch_uri.startswith("file://") or not expected_hash.startswith("sha256:"):
        return _PatchVerificationResult(reason="patch_unavailable")
    patch_path = Path(patch_uri.removeprefix("file://"))
    try:
        data = patch_path.read_bytes()
    except OSError:
        return _PatchVerificationResult(reason="patch_unavailable")
    actual = "sha256:" + hashlib.sha256(data).hexdigest()
    if actual != expected_hash:
        return _PatchVerificationResult(reason="patch_hash_mismatch")
    workspace = _optional_payload_str(verification_input.get("repository_path"))
    base_revision = _optional_payload_str(verification_input.get("base_revision"))
    expected_tree = _optional_payload_str(verification_input.get("expected_result_tree"))
    if not workspace or not base_revision or not expected_tree:
        return _PatchVerificationResult(reason="patch_unavailable")
    verify_workspace = patch_path.parent / "verify-worktree"
    if verify_workspace.exists():
        shutil.rmtree(verify_workspace)
    try:
        _git(["clone", "--quiet", workspace, str(verify_workspace)], cwd=Path(workspace))
        _git(["checkout", "--quiet", base_revision], cwd=verify_workspace)
    except (subprocess.SubprocessError, OSError):
        return _PatchVerificationResult(reason="verification_workspace_unavailable")
    if data:
        try:
            _run(["git", "apply", "--index", str(patch_path)], cwd=verify_workspace)
        except (subprocess.SubprocessError, OSError):
            return _PatchVerificationResult(reason="patch_apply_failed")
    try:
        actual_tree = _git(["write-tree"], cwd=verify_workspace).strip()
    except (subprocess.SubprocessError, OSError):
        return _PatchVerificationResult(reason="result_tree_unavailable")
    if actual_tree != expected_tree:
        return _PatchVerificationResult(reason="result_tree_mismatch")
    result_revision = _optional_payload_str(verification_input.get("result_revision"))
    if result_revision:
        try:
            result_revision_tree = _git(["rev-parse", f"{result_revision}^{{tree}}"], cwd=verify_workspace).strip()
        except subprocess.CalledProcessError:
            return _PatchVerificationResult(reason="result_revision_unavailable")
        if result_revision_tree != actual_tree:
            return _PatchVerificationResult(reason="result_revision_tree_mismatch")
    return _PatchVerificationResult(workspace=verify_workspace)


def _commit_verify_workspace(verification_input: dict[str, object], *, fallback_parent: Path) -> Path:
    evidence_uri = str(verification_input.get("evidence_uri") or "")
    if evidence_uri.startswith("file://"):
        return Path(evidence_uri.removeprefix("file://")).parent / "verify-worktree"
    attempt_id = _optional_payload_str(verification_input.get("execute_attempt_id")) or "verify"
    parent = fallback_parent / ".symphony" / "verify"
    parent.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=f"{attempt_id}-verify-", dir=str(parent)))


def _verify_artifact_hashes(verification_input: dict[str, object]) -> str | None:
    artifacts = verification_input.get("artifact_uris") or []
    if not isinstance(artifacts, list):
        return "artifact_unavailable"
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            return "artifact_unavailable"
        uri = str(artifact.get("uri") or "")
        expected_hash = str(artifact.get("sha256") or "")
        if not uri.startswith("file://") or not expected_hash.startswith("sha256:"):
            return "artifact_unavailable"
        path = Path(uri.removeprefix("file://"))
        try:
            actual_hash = _file_sha256(path)
        except OSError:
            return "artifact_unavailable"
        if actual_hash != expected_hash:
            return "artifact_hash_mismatch"
    return None


def _run_gate_commands(
    gate_snapshot: GateSpecSnapshot | None,
    verification_input: dict[str, object],
    *,
    verification_workspace: Path | None,
) -> str | None:
    if gate_snapshot is None:
        return None
    commands = gate_snapshot.content.verification_procedure
    if not commands:
        return "gate_command_failed"
    cwd = verification_workspace or _verification_command_cwd(verification_input)
    if cwd is None:
        return "gate_command_failed"
    baseline_status = ""
    baseline_tree = ""
    if verification_workspace is not None:
        try:
            baseline_status = _git(["status", "--porcelain"], cwd=verification_workspace).strip()
            baseline_tree = _git(["write-tree"], cwd=verification_workspace).strip()
        except (subprocess.SubprocessError, OSError):
            return "verifier_workspace_mutated"
    for command in commands:
        try:
            subprocess.run(
                command,
                cwd=cwd,
                shell=True,
                check=True,
                capture_output=True,
                text=True,
                timeout=300,
                env=_verification_command_env(),
            )
        except subprocess.CalledProcessError as exc:
            if command.source is GateStepSource.PLANNER_INFERRED:
                continue
            return _gate_command_failure_reason(command, exc)
        except subprocess.TimeoutExpired as exc:
            if command.source is GateStepSource.PLANNER_INFERRED:
                continue
            return _gate_command_failure_reason(command, exc)
        except (subprocess.SubprocessError, OSError) as exc:
            if command.source is GateStepSource.PLANNER_INFERRED:
                continue
            return _gate_command_failure_reason(command, exc)
    if verification_workspace is not None:
        try:
            status = _git(["status", "--porcelain"], cwd=verification_workspace).strip()
            actual_tree = _git(["write-tree"], cwd=verification_workspace).strip()
        except (subprocess.SubprocessError, OSError):
            return "verifier_workspace_mutated"
        if status != baseline_status or actual_tree != baseline_tree:
            return "verifier_workspace_mutated"
    return None


def _gate_command_failure_reason(command: str, exc: BaseException) -> str:
    parts = [f"gate_command_failed command={command!r}"]
    returncode = getattr(exc, "returncode", None)
    if returncode is not None:
        parts.append(f"exit_code={returncode}")
    stdout = getattr(exc, "stdout", None)
    stderr = getattr(exc, "stderr", None)
    parts.append(f"stdout={_single_line_tail(str(stdout or ''))!r}")
    parts.append(f"stderr={_single_line_tail(str(stderr or ''))!r}")
    if returncode is None:
        parts.append(f"error={_single_line_tail(str(exc))!r}")
    return _sanitize_error(" ".join(parts))


def _single_line_tail(value: str, *, limit: int = 240) -> str:
    text = " ".join(value.replace("\x00", "").split())
    return text[-limit:]


def _verification_command_env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    existing_pytest_addopts = env.get("PYTEST_ADDOPTS", "").strip()
    cache_disable = "-p no:cacheprovider"
    if cache_disable not in existing_pytest_addopts:
        env["PYTEST_ADDOPTS"] = f"{existing_pytest_addopts} {cache_disable}".strip()
    return env


def _remove_generated_verification_caches(workspace_path: Path) -> None:
    shutil.rmtree(workspace_path / ".pytest_cache", ignore_errors=True)
    for cache_dir in workspace_path.rglob("__pycache__"):
        if ".git" not in cache_dir.parts:
            shutil.rmtree(cache_dir, ignore_errors=True)
    for compiled in workspace_path.rglob("*.py[co]"):
        if ".git" not in compiled.parts:
            compiled.unlink(missing_ok=True)


def _verification_command_cwd(verification_input: dict[str, object]) -> Path | None:
    workspace = _optional_payload_str(verification_input.get("verification_workspace"))
    if workspace:
        return Path(workspace)
    repository_path = _optional_payload_str(verification_input.get("repository_path"))
    if repository_path:
        patch_uri = str(verification_input.get("patch_uri") or "")
        if patch_uri.startswith("file://"):
            verify_workspace = Path(patch_uri.removeprefix("file://")).parent / "verify-worktree"
            if verify_workspace.exists():
                return verify_workspace
        return Path(repository_path)
    return None


def _fencing_fields(payload: dict[str, object]) -> dict[str, object]:
    return {
        "graph_revision": int(payload.get("graph_revision") or 0),
        "policy_revision": int(payload.get("policy_revision") or 0),
        "lease_id": str(payload.get("lease_id") or ""),
        "fencing_token": str(payload.get("fencing_token") or ""),
    }


def _git(args: list[str], *, cwd: Path) -> str:
    return subprocess.check_output(["git", *args], cwd=cwd, text=True)


def _run(args: list[str], *, cwd: Path) -> None:
    subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True)


def _file_sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _optional_payload_str(value: object) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _sanitize_error(exc: Exception | str) -> str:
    text = str(exc).replace("\x00", "").strip()
    if not text:
        return exc.__class__.__name__ if isinstance(exc, Exception) else "runtime_error"
    text = re.sub(r"(?i)(authorization:\s*)(bearer|basic)\s+[^\s,;]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", text)
    text = re.sub(r"(?i)\b(token|password|client_secret|cookie)=([^ \t,;]+)", r"\1=[REDACTED]", text)
    return text[:500]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run one managed Performer plan/execute/verify attempt.")
    parser.add_argument("--mode", choices=[mode.value for mode in RuntimeMode], default=None, help="Run one managed plan/execute/verify attempt.")
    parser.add_argument("--attempt-request-path", default=None, help="Read one managed mode attempt request JSON file.")
    parser.add_argument("--attempt-result-path", default=None, help="Write one managed mode attempt result JSON file.")
    args = parser.parse_args(argv)
    if not args.mode or not args.attempt_request_path or not args.attempt_result_path:
        parser.error("--mode, --attempt-request-path, and --attempt-result-path are required")
    return args


def _write_json_atomic(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        asyncio.run(
            run_mode_attempt(
                RuntimeMode(args.mode),
                Path(args.attempt_request_path).resolve(),
                Path(args.attempt_result_path).resolve(),
            )
        )
        os._exit(0)
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        print(f"performer startup failed: {exc}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
