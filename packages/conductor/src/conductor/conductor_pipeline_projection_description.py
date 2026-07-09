from __future__ import annotations

from .conductor_pipeline_projection_common import *


class DescriptionMixin:
    def _metadata(self, node: GraphNode, revision: GraphRevision) -> dict[str, Any]:
        return self.store.linear_projection_metadata(node, revision)

    def _description_block(self, node: GraphNode, revision: GraphRevision) -> str:
        gate = self.store.gate_for_node(node.node_id)
        metadata = self._metadata(node, revision)
        runtime_wait = self.store.active_runtime_wait_for_node(node.node_id)
        lines = self._description_metadata_lines(metadata)
        self._append_attempt_lines(lines, metadata)
        self._append_active_lease_lines(lines, metadata)
        self._append_human_wait_lines(lines, metadata)
        lines.append("```")
        self._append_runtime_wait_lines(lines, runtime_wait)
        self._append_gate_lines(lines, gate)
        return "\n".join(lines)

    def _description_metadata_lines(self, metadata: dict[str, Any]) -> list[str]:
        lines = [
            "```yaml",
            "symphony:",
            f"  graph_id: {metadata['graph_id']}",
            f"  node_id: {metadata['node_id']}",
            f"  plan_attempt_id: {metadata['plan_attempt_id']}",
            f"  gate_snapshot_hash: {metadata['gate_snapshot_hash'] or ''}",
            f"  conductor_revision: {metadata['conductor_revision']}",
            f"  operator_status: {metadata['operator_status']}",
        ]
        if metadata.get("operator_wait_kind"):
            lines.append(f"  operator_wait_kind: {_yaml_scalar(metadata.get('operator_wait_kind'))}")
        lines.extend(
            [
                f"  rework_count: {int(metadata.get('rework_count') or 0)}",
                f"  replan_depth: {int(metadata.get('replan_depth') or 0)}",
                f"  verify_score: {_yaml_scalar(metadata.get('verify_score'))}",
                "  attempts:",
            ]
        )
        return lines

    def _append_attempt_lines(self, lines: list[str], metadata: dict[str, Any]) -> None:
        debug_projection = _debug_projection_enabled()
        for attempt in metadata.get("attempts") or []:
            if not isinstance(attempt, dict):
                continue
            lines.extend(
                [
                    f"    - mode: {_yaml_scalar(attempt.get('mode'))}",
                    f"      state: {_yaml_scalar(attempt.get('state'))}",
                    f"      score: {_yaml_scalar(attempt.get('score'))}",
                ]
            )
            if attempt.get("thread_id"):
                lines.append(f"      thread_id: {_yaml_scalar(attempt.get('thread_id'))}")
            if attempt.get("kind"):
                lines.append(f"      kind: {_yaml_scalar(attempt.get('kind'))}")
            if debug_projection:
                lines.extend(
                    [
                        f"      attempt_id: {_yaml_scalar(attempt.get('attempt_id'))}",
                        f"      lease_id: {_yaml_scalar(attempt.get('lease_id'))}",
                        f"      process_pid: {_yaml_scalar(attempt.get('process_pid'))}",
                    ]
                )

    def _append_active_lease_lines(self, lines: list[str], metadata: dict[str, Any]) -> None:
        active_lease = metadata.get("active_lease") if isinstance(metadata.get("active_lease"), dict) else None
        if active_lease is not None:
            debug_projection = _debug_projection_enabled()
            lines.extend(
                [
                    "  active_lease:",
                    f"    mode: {_yaml_scalar(active_lease.get('mode'))}",
                    f"    heartbeat_at: {_yaml_scalar(active_lease.get('heartbeat_at'))}",
                ]
            )
            if debug_projection:
                lines.extend(
                    [
                        f"    lease_id: {_yaml_scalar(active_lease.get('lease_id'))}",
                        f"    fencing_token: {_yaml_scalar(active_lease.get('fencing_token'))}",
                        f"    attempt_id: {_yaml_scalar(active_lease.get('attempt_id'))}",
                    ]
                )

    def _append_human_wait_lines(self, lines: list[str], metadata: dict[str, Any]) -> None:
        if metadata.get("human_waits"):
            lines.append("  human_waits:")
            for wait in metadata.get("human_waits") or []:
                if isinstance(wait, dict):
                    lines.append(f"    - reason: {_yaml_scalar(wait.get('reason'))}")

    def _append_runtime_wait_lines(self, lines: list[str], runtime_wait: dict[str, Any] | None) -> None:
        if runtime_wait is not None:
            lines.extend(
                [
                    "",
                    "### Runtime Wait",
                    "",
                    "```yaml",
                    "runtime_wait:",
                    f"  status: {_yaml_scalar(runtime_wait.get('status'))}",
                    f"  wait_kind: {_yaml_scalar(runtime_wait.get('wait_kind'))}",
                    f"  attempt_id: {_yaml_scalar(runtime_wait.get('attempt_id'))}",
                    f"  mode: {_yaml_scalar(runtime_wait.get('mode'))}",
                    f"  lease_id: {_yaml_scalar(runtime_wait.get('lease_id'))}",
                    f"  updated_at: {_yaml_scalar(runtime_wait.get('updated_at'))}",
                    f"  message: {_yaml_scalar(runtime_wait.get('message'))}",
                    f"  command: {_yaml_scalar(runtime_wait.get('command'))}",
                    "```",
                ]
            )

    def _append_gate_lines(self, lines: list[str], gate: Any) -> None:
        if gate is not None:
            lines.extend(
                [
                    "",
                    "### Frozen Gate",
                    "",
                    "acceptance_criteria:",
                    *[f"- {item}" for item in gate.content.acceptance_criteria],
                    "verification_procedure:",
                    *[f"- {item}" for item in gate.content.verification_procedure],
                    "rubric:",
                    *[f"- {score}: {gate.content.rubric.get(str(score), '')}" for score in range(5)],
                    f"pass_threshold: {gate.content.pass_threshold}",
                ]
            )
