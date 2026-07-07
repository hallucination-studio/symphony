from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class LabelScheme:
    pipeline_prefix: str = "performer:pipeline/"
    type_prefix: str = "performer:type/"
    pipeline: dict[str, str] = field(
        default_factory=lambda: {
            "planning": "performer:pipeline/planning",
            "ready": "performer:pipeline/ready",
            "executing": "performer:pipeline/executing",
            "verifying": "performer:pipeline/verifying",
            "verify_passed": "performer:pipeline/verify-passed",
            "awaiting_human": "performer:pipeline/awaiting-human",
            "failed": "performer:pipeline/failed",
        }
    )
    types: dict[str, str] = field(
        default_factory=lambda: {
            "human_action": "performer:type/human-action",
            "repository_integration": "performer:type/repository-integration",
            "pipeline_node": "performer:type/pipeline-node",
        }
    )

    def all_static_labels(self) -> list[str]:
        return [*self.pipeline.values(), *self.types.values()]


LABEL_SCHEME = LabelScheme()


PIPELINE_LABELS = {
    "planning": LABEL_SCHEME.pipeline["planning"],
    "ready": LABEL_SCHEME.pipeline["ready"],
    "executing": LABEL_SCHEME.pipeline["executing"],
    "verifying": LABEL_SCHEME.pipeline["verifying"],
    "verify_passed": LABEL_SCHEME.pipeline["verify_passed"],
    "awaiting_human": LABEL_SCHEME.pipeline["awaiting_human"],
    "failed": LABEL_SCHEME.pipeline["failed"],
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
