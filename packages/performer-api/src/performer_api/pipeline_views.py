from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .pipeline_enums import RuntimeMode
from .pipeline_utils import _jsonable_dict


@dataclass(frozen=True)
class PipelineModeView:
    mode: RuntimeMode
    active: int
    limit: int | None
    queued: int
    node_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode.value,
            "active": self.active,
            "limit": self.limit,
            "queued": self.queued,
            "node_ids": list(self.node_ids),
        }


@dataclass(frozen=True)
class PredictedCall:
    node_id: str
    predicted_position: int | None
    blocked_by: list[str]
    earliest_mode: RuntimeMode | None
    confidence: str = "conditional"

    def to_dict(self) -> dict[str, Any]:
        return {
            "node": self.node_id,
            "predicted_position": self.predicted_position,
            "blocked_by": list(self.blocked_by),
            "earliest_mode": self.earliest_mode.value if self.earliest_mode is not None else None,
            "confidence": self.confidence,
        }


@dataclass(frozen=True)
class PipelineView:
    graph_revision: int
    policy_revision: int
    policy_id: str
    policy_source: str
    last_scheduler_policy_id: str
    last_scheduler_policy_version: int
    last_scheduler_policy_source: str
    last_scheduler_tick_at: str
    nodes: list[dict[str, Any]]
    modes: list[PipelineModeView]
    predicted_call_order: list[PredictedCall]
    capacity: dict[str, Any] = field(default_factory=dict)
    blocks: list[tuple[str, str]] = field(default_factory=list)
    gates: list[dict[str, Any]] = field(default_factory=list)
    leases: list[dict[str, Any]] = field(default_factory=list)
    attempts: list[dict[str, Any]] = field(default_factory=list)
    integration_queue: list[dict[str, Any]] = field(default_factory=list)
    manifests: list[dict[str, Any]] = field(default_factory=list)
    human_waits: list[dict[str, Any]] = field(default_factory=list)
    runtime_waits: list[dict[str, Any]] = field(default_factory=list)
    stuck_observations: list[dict[str, Any]] = field(default_factory=list)
    linear_projections: list[dict[str, Any]] = field(default_factory=list)
    graph_deliveries: list[dict[str, Any]] = field(default_factory=list)
    prediction_basis: dict[str, Any] = field(default_factory=dict)
    runtime_config: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "graph_revision": self.graph_revision,
            "policy_revision": self.policy_revision,
            "policy_id": self.policy_id,
            "policy_source": self.policy_source,
            "last_scheduler_policy_id": self.last_scheduler_policy_id,
            "last_scheduler_policy_version": self.last_scheduler_policy_version,
            "last_scheduler_policy_source": self.last_scheduler_policy_source,
            "last_scheduler_tick_at": self.last_scheduler_tick_at,
            "nodes": [_jsonable_dict(node) for node in self.nodes],
            "modes": [mode.to_dict() for mode in self.modes],
            "predicted_call_order": [call.to_dict() for call in self.predicted_call_order],
            "capacity": _jsonable_dict(self.capacity),
            "blocks": [[source, target] for source, target in self.blocks],
            "gates": [_jsonable_dict(gate) for gate in self.gates],
            "leases": [_jsonable_dict(lease) for lease in self.leases],
            "attempts": [_jsonable_dict(attempt) for attempt in self.attempts],
            "integration_queue": [_jsonable_dict(item) for item in self.integration_queue],
            "manifests": [_jsonable_dict(manifest) for manifest in self.manifests],
            "human_waits": [_jsonable_dict(wait) for wait in self.human_waits],
            "runtime_waits": [_jsonable_dict(wait) for wait in self.runtime_waits],
            "stuck_observations": [_jsonable_dict(observation) for observation in self.stuck_observations],
            "linear_projections": [_jsonable_dict(projection) for projection in self.linear_projections],
            "graph_deliveries": [_jsonable_dict(delivery) for delivery in self.graph_deliveries],
            "prediction_basis": _jsonable_dict(self.prediction_basis),
            "runtime_config": _jsonable_dict(self.runtime_config),
        }
