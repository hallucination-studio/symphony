from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class LabelScheme:
    managed_run_prefix: str = "symphony:managed-run/"
    type_prefix: str = "performer:type/"
    managed_run: dict[str, str] = field(
        default_factory=lambda: {
            "planning": "symphony:managed-run/planning",
            "ready": "symphony:managed-run/ready",
            "executing": "symphony:managed-run/executing",
            "reviewing": "symphony:managed-run/reviewing",
            "verified": "symphony:managed-run/verified",
            "need_human": "symphony:managed-run/need-human",
            "failed": "symphony:managed-run/failed",
        }
    )
    types: dict[str, str] = field(
        default_factory=lambda: {
            "human_action": "performer:type/human-action",
            "repository_integration": "performer:type/repository-integration",
            "work_item": "symphony:type/work-item",
        }
    )

    def all_static_labels(self) -> list[str]:
        return [*self.managed_run.values(), *self.types.values()]


LABEL_SCHEME = LabelScheme()


MANAGED_RUN_LABELS = {
    "planning": LABEL_SCHEME.managed_run["planning"],
    "ready": LABEL_SCHEME.managed_run["ready"],
    "executing": LABEL_SCHEME.managed_run["executing"],
    "reviewing": LABEL_SCHEME.managed_run["reviewing"],
    "verified": LABEL_SCHEME.managed_run["verified"],
    "need_human": LABEL_SCHEME.managed_run["need_human"],
    "failed": LABEL_SCHEME.managed_run["failed"],
}

TYPE_LABELS = LABEL_SCHEME.types

HUMAN_INTERVENTION_LABELS = {
    "type": TYPE_LABELS["human_action"],
}
HUMAN_INTERVENTION_KIND_LABELS = {
    "preflight_needs_input": TYPE_LABELS["human_action"],
    "codex_needs_input": TYPE_LABELS["human_action"],
    "runtime_permission": TYPE_LABELS["human_action"],
    "runtime_error": TYPE_LABELS["human_action"],
    "verification_needs_human": TYPE_LABELS["human_action"],
}
