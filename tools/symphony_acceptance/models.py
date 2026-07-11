from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


ALLOWED_TEST_LEVELS = frozenset({"unit", "contract", "integration", "system", "live"})


@dataclass(frozen=True)
class BusinessScenarioSpec:
    id: str
    actor: str
    customer_job: str
    start_state: str
    accepted_outcome: str
    visible_artifacts: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class AcceptanceScenarioSpec:
    id: str
    proves: str
    business_scenarios: tuple[str, ...]
    minimum_level: str
    real_boundaries: tuple[str, ...]
    authoritative_oracles: tuple[str, ...]
    operator_oracles: tuple[str, ...]
    required_evidence: tuple[str, ...]
    cleanup: tuple[str, ...]
    trigger_tags: tuple[str, ...]
    depends_on: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class JourneySpec:
    id: str
    proves: str
    business_scenarios: tuple[str, ...]
    preconditions: tuple[str, ...]
    minimum_level: str
    real_boundaries: tuple[str, ...]
    authoritative_oracles: tuple[str, ...]
    operator_oracles: tuple[str, ...]
    required_evidence: tuple[str, ...]
    cleanup: tuple[str, ...]
    trigger_tags: tuple[str, ...]
    depends_on: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


AcceptanceEntry = AcceptanceScenarioSpec | JourneySpec
