from __future__ import annotations

from typing import Any

from performer_api.pipeline import (
    GateSpecContent,
    GateSpecSnapshot,
    GateStep,
    GateStepSource,
    GraphNode,
    GraphNodeState,
    PASS_THRESHOLD,
    PlanProposal,
)

from .conductor_pipeline import ConductorPipelineStore, GraphRevision


def import_offline_plan(store: ConductorPipelineStore, payload: dict[str, Any]) -> GraphRevision:
    """Import a hand-written plan through the validated graph path.

    This is intentionally not a scheduler entrypoint. It commits graph/gate
    state only; dispatch remains owned by Conductor's runtime scheduler.
    """

    graph_id = str(payload.get("graph_id") or "offline-graph")
    plan_attempt_id = str(payload.get("plan_attempt_id") or "offline-import")
    root_node_id = str(payload.get("root_node_id") or "root")
    raw_nodes = payload.get("nodes") if isinstance(payload.get("nodes"), list) else []
    nodes: list[GraphNode] = []
    gates: list[GateSpecSnapshot] = []
    blocks: list[tuple[str, str]] = []
    for raw in raw_nodes:
        if not isinstance(raw, dict):
            continue
        node_id = str(raw.get("node_id") or raw.get("id") or "")
        if not node_id:
            continue
        gate = GateSpecSnapshot.create(
            gate_id=str(raw.get("gate_id") or f"gate-{node_id}"),
            task_id=node_id,
            created_by=plan_attempt_id,
            created_at=str(payload.get("created_at") or "1970-01-01T00:00:00Z"),
            content=GateSpecContent(
                acceptance_criteria=_str_list(raw.get("acceptance_criteria")) or [f"{raw.get('title') or node_id} is complete"],
                verification_procedure=[
                    GateStep(step, GateStepSource.ISSUE_REQUIREMENT)
                    for step in _str_list(raw.get("verification_procedure"))
                ],
                rubric={str(score): _rubric(score) for score in range(5)},
                pass_threshold=PASS_THRESHOLD,
            ),
        )
        nodes.append(
            GraphNode(
                node_id=node_id,
                title=str(raw.get("title") or node_id),
                state=GraphNodeState.PLANNED,
                issue_id=_optional_str(raw.get("issue_id")),
                issue_identifier=_optional_str(raw.get("issue_identifier")),
                gate_snapshot_hash=gate.hash,
            )
        )
        gates.append(gate)
        for blocker in _str_list(raw.get("blocks")):
            blocks.append((blocker, node_id))
    node_ids = {node.node_id for node in nodes}
    blocked = {target for _source, target in blocks}
    blockers = {source for source, _target in blocks}
    proposal = PlanProposal(
        graph_id=graph_id,
        plan_attempt_id=plan_attempt_id,
        root_node_id=root_node_id,
        nodes=nodes,
        blocks=blocks,
        gates=gates,
        entry_node_ids=sorted(node_ids - blocked) or sorted(node_ids),
        exit_node_ids=sorted(node_ids - blockers) or sorted(node_ids),
    )
    return store.commit_plan(proposal)


def _str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if item is not None and str(item)]


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _rubric(score: int) -> str:
    return {
        0: "no valid implementation or unverifiable",
        1: "attempted but core gate fails",
        2: "partial or mock-only evidence",
        3: "gate passes with real evidence",
        4: "gate passes with robust evidence and edge cases",
    }[score]
