from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class LabelScheme:
    phase_prefix: str = "performer:phase/"
    type_prefix: str = "performer:type/"
    gate_prefix: str = "performer:gate/"
    score_prefix: str = "performer:score/"
    phases: dict[str, str] = field(
        default_factory=lambda: {
            "queued": "performer:phase/queued",
            "implementation": "performer:phase/implementation",
            "review": "performer:phase/review",
            "rework": "performer:phase/rework",
            "done": "performer:phase/done",
            "failed": "performer:phase/failed",
            "blocked": "performer:phase/blocked",
        }
    )
    types: dict[str, str] = field(
        default_factory=lambda: {
            "gate": "performer:type/gate",
            "evidence": "performer:type/evidence",
            "human_action": "performer:type/human-action",
            "repository_integration": "performer:type/repository-integration",
        }
    )
    gates: dict[str, str] = field(
        default_factory=lambda: {
            "pending": "performer:gate/pending",
            "passed": "performer:gate/passed",
            "pass_with_findings": "performer:gate/pass-with-findings",
            "failed": "performer:gate/failed",
        }
    )

    def score(self, value: int, total: int = 4) -> str:
        return f"{self.score_prefix}{value}/{total}"

    def all_static_labels(self) -> list[str]:
        return [*self.phases.values(), *self.types.values(), *self.gates.values()]


LABEL_SCHEME = LabelScheme()


PHASE_LABELS = {
    "queued": LABEL_SCHEME.phases["queued"],
    "dispatch_received": LABEL_SCHEME.phases["queued"],
    "implementation_running": LABEL_SCHEME.phases["implementation"],
    "implementation_done": LABEL_SCHEME.phases["implementation"],
    "review_running": LABEL_SCHEME.phases["review"],
    "rework": LABEL_SCHEME.phases["rework"],
    "completed": LABEL_SCHEME.phases["done"],
    "failed": LABEL_SCHEME.phases["failed"],
    "blocked": LABEL_SCHEME.phases["blocked"],
}

TYPE_LABELS = LABEL_SCHEME.types
GATE_LABELS = LABEL_SCHEME.gates
SCORE_LABEL_PREFIX = LABEL_SCHEME.score_prefix

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

LEGACY_LABEL_PREFIXES = (
    "performer:lifecycle/",
    "performer:dispatch/",
    "performer:retry/",
    "performer:error/",
    "performer:human/",
)

LEGACY_LABELS = {
    "performer:queued",
    "performer:starting",
    "performer:running",
    "performer:continuing",
    "performer:retrying",
    "performer:error",
    "performer:failed",
    "performer:done",
    "performer:type/task",
    "performer:type/acceptance",
    "performer:phase/planned",
    "performer:dispatch/accepted",
    "performer:dispatch/skipped",
    "performer:dispatch/failed",
    "performer:retry/pending",
    "performer:retry/exhausted",
    "performer:error/human-blocked",
    "performer:human/pending",
    "performer:human/resolved",
    "performer:human/needs-input",
    "performer:human/runtime-approval",
    "performer:human/runtime-error",
    "performer:human/verification",
}
