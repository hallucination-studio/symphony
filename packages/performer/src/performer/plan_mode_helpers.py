from __future__ import annotations

import json
from pathlib import Path

from performer_api.pipeline import GateSpecContent, GateSpecSnapshot, GraphNode, HumanEscalationReason, PlanProposal

from .mode_common import _optional_payload_str


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
            "If `pipeline_intent.parallel_dependency_shape` names branch and downstream node ids, include those nodes "
            "and add `blocks` from every branch node to every downstream node. "
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
        "Every returned node, including `root_node_id` if included, must have a frozen gate "
        "snapshot, valid 0-4 rubric, pass_threshold=3, "
        "and dependency edges must be acyclic. The proposal must contain at least one planned "
        "executable node, at least one frozen gate whose task_id matches a node_id, and non-empty "
        "entry_node_ids and exit_node_ids. Do not return an empty plan. Entry nodes must exactly "
        "be nodes with no incoming blocks; exit nodes must exactly be nodes with no outgoing blocks. "
        "`parent_node_id` is only for Linear nesting/display and is never a dependency edge. "
        "Fan-in and fan-out must be expressed with `blocks` edges. "
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
