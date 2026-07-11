from __future__ import annotations

from dataclasses import InitVar, asdict, dataclass, replace
from hashlib import sha256
import json
from pathlib import PurePosixPath
from typing import Any, Literal

from .catalog import CANONICAL_JOURNEY_ID


RiskClass = Literal["localized", "major", "core"]
SelectionStatus = Literal["selected", "blocked"]

_RISK_ORDER: dict[RiskClass, int] = {"localized": 0, "major": 1, "core": 2}
_DECISION_CONSTRUCTION_TOKEN = object()


def _require(**fields: str) -> None:
    missing = sorted(name for name, value in fields.items() if not value.strip())
    if missing:
        raise ValueError(f"required fields missing: {','.join(missing)}")


def _repo_path(value: str) -> str:
    path = PurePosixPath(value)
    if not value.strip() or path.is_absolute() or ".." in path.parts or str(path) == ".":
        raise ValueError(f"invalid repository path: {value!r}")
    return str(path)


def _matches(path: str, prefix: str) -> bool:
    prefix = _repo_path(prefix.rstrip("/"))
    return path == prefix or path.startswith(f"{prefix}/")


def _digest(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    return f"sha256:{sha256(encoded).hexdigest()}"


def _highest(risks: tuple[RiskClass, ...]) -> RiskClass:
    return max(risks, key=_RISK_ORDER.__getitem__)


@dataclass(frozen=True, slots=True)
class ChangeImpactRule:
    path_prefixes: tuple[str, ...]
    capability: str
    business_scenarios: tuple[str, ...]
    acceptance_scenarios: tuple[str, ...]
    risk_class: RiskClass
    runtime_role: str | None = None
    core_triggers: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.risk_class not in _RISK_ORDER:
            raise ValueError(f"invalid risk_class: {self.risk_class}")
        required_groups = (
            self.path_prefixes,
            (self.capability,),
            self.business_scenarios,
            self.acceptance_scenarios,
        )
        if any(not values or any(not value.strip() for value in values) for values in required_groups):
            raise ValueError("impact rule requires paths, capability, business, and acceptance mappings")
        for prefix in self.path_prefixes:
            _repo_path(prefix.rstrip("/"))
        if self.runtime_role is not None:
            _require(runtime_role=self.runtime_role)
        if self.core_triggers and self.risk_class != "core":
            raise ValueError("core triggers require core risk")
        if CANONICAL_JOURNEY_ID in self.acceptance_scenarios:
            raise ValueError("canonical journey cannot be a focused scenario")

    def matches(self, path: str) -> bool:
        return any(_matches(path, prefix) for prefix in self.path_prefixes)


@dataclass(frozen=True, slots=True)
class ChangeImpactPolicy:
    revision: str
    rules: tuple[ChangeImpactRule, ...]
    production_roots: tuple[str, ...] = ("packages/", "tools/")
    major_file_threshold: int = 12
    major_line_threshold: int = 500

    def __post_init__(self) -> None:
        _require(revision=self.revision)
        if not self.production_roots or min(self.major_file_threshold, self.major_line_threshold) < 1:
            raise ValueError("production roots and positive major thresholds are required")
        for root in self.production_roots:
            _repo_path(root.rstrip("/"))

    @property
    def digest(self) -> str:
        payload = asdict(self)
        payload["production_roots"] = sorted(payload["production_roots"])
        payload["rules"] = sorted(
            payload["rules"],
            key=lambda rule: json.dumps(rule, separators=(",", ":"), sort_keys=True),
        )
        return _digest(payload)


@dataclass(frozen=True, slots=True)
class ChangeImpactInput:
    commit_sha: str
    baseline_sha: str
    build_digest: str
    configuration_digest: str
    changed_paths: tuple[str, ...]
    declared_capabilities: tuple[str, ...] = ()
    declared_risk_class: RiskClass = "localized"
    executable_lines_changed: int = 0

    def __post_init__(self) -> None:
        _require(
            commit_sha=self.commit_sha,
            baseline_sha=self.baseline_sha,
            build_digest=self.build_digest,
            configuration_digest=self.configuration_digest,
        )
        if not self.changed_paths or self.declared_risk_class not in _RISK_ORDER:
            raise ValueError("changed paths and a valid declared risk are required")
        if self.executable_lines_changed < 0:
            raise ValueError("executable_lines_changed cannot be negative")
        for path in self.changed_paths:
            _repo_path(path)
        for capability in self.declared_capabilities:
            _require(declared_capability=capability)


@dataclass(frozen=True, slots=True)
class NotEvaluatedScenario:
    scenario_id: str
    reason: str


@dataclass(frozen=True, slots=True)
class OperatorPromotion:
    source_decision_digest: str
    operator: str
    reason: str

    def __post_init__(self) -> None:
        _require(
            source_decision_digest=self.source_decision_digest,
            operator=self.operator,
            reason=self.reason,
        )


@dataclass(frozen=True, slots=True)
class ChangeImpactDecision:
    schema_version: int
    commit_sha: str
    baseline_sha: str
    build_digest: str
    configuration_digest: str
    classifier_revision: str
    classifier_digest: str
    changed_paths: tuple[str, ...]
    declared_capabilities: tuple[str, ...]
    declared_risk_class: RiskClass
    selection_status: SelectionStatus
    risk_class: RiskClass | None
    objective_risk_class: RiskClass | None
    core_triggers: tuple[str, ...]
    production_file_count: int
    executable_lines_changed: int
    affected_capabilities: tuple[str, ...]
    affected_business_scenarios: tuple[str, ...]
    selected_acceptance_scenarios: tuple[str, ...]
    not_evaluated: tuple[NotEvaluatedScenario, ...]
    unknown_production_paths: tuple[str, ...]
    unknown_declared_capabilities: tuple[str, ...]
    canonical_journey_required: bool
    clean_resources_required: bool
    decision_reasons: tuple[str, ...]
    operator_promotion: OperatorPromotion | None = None
    _construction_token: InitVar[object | None] = None

    @classmethod
    def _from_classifier(cls, **values: Any) -> ChangeImpactDecision:
        return cls(**values, _construction_token=_DECISION_CONSTRUCTION_TOKEN)

    def __post_init__(self, _construction_token: object | None) -> None:
        if self.schema_version != 1:
            raise ValueError("unsupported change-impact schema_version")
        if self.operator_promotion and not self.full_g3_required:
            raise ValueError("promoted decision requires full G3 from clean resources")
        has_unknown_impact = bool(
            self.unknown_production_paths or self.unknown_declared_capabilities
        )
        if has_unknown_impact and self.selection_status != "blocked":
            raise ValueError("unknown impact requires blocked selection")
        if self.selection_status == "blocked":
            if (
                self.risk_class is not None
                or self.objective_risk_class is not None
                or self.selected_acceptance_scenarios
            ):
                raise ValueError("blocked decision cannot select risk or scenarios")
            if (
                self.canonical_journey_required
                or self.clean_resources_required
                or self.operator_promotion is not None
            ):
                raise ValueError("blocked decision cannot require acceptance execution")
            if _construction_token is not _DECISION_CONSTRUCTION_TOKEN:
                raise ValueError("change impact decisions must be constructed by the classifier")
            return
        if self.selection_status != "selected" or self.risk_class not in _RISK_ORDER:
            raise ValueError("selected decision requires a valid risk_class")
        if self.objective_risk_class is None:
            raise ValueError("selected decision requires objective_risk_class")
        if self.core_triggers and self.objective_risk_class != "core":
            raise ValueError("core triggers require core objective risk")
        matched_risks = tuple(
            reason.rpartition(":")[2]
            for reason in self.decision_reasons
            if reason.startswith("matched_rule:")
            and reason.rpartition(":")[2] in _RISK_ORDER
        )
        if matched_risks and _RISK_ORDER[self.objective_risk_class] < _RISK_ORDER[_highest(matched_risks)]:
            raise ValueError("objective risk cannot downgrade matched rules")
        if (
            any(reason.startswith("major_") for reason in self.decision_reasons)
            and self.objective_risk_class == "localized"
        ):
            raise ValueError("major signals require major objective risk")
        minimum = _highest((self.objective_risk_class, self.declared_risk_class))
        if self.risk_class != minimum:
            raise ValueError("risk_class cannot downgrade objective or declared risk")
        if self.risk_class in ("core", "major") and not self.full_g3_required:
            raise ValueError("core/major decision requires full G3 from clean resources")
        if self.risk_class == "localized" and self.canonical_journey_required:
            if self.operator_promotion is None:
                raise ValueError("localized canonical selection requires an exact operator promotion")
        if self.canonical_journey_required != self.clean_resources_required:
            raise ValueError("canonical journey must run from clean resources")
        selected_canonical = CANONICAL_JOURNEY_ID in self.selected_acceptance_scenarios
        if self.canonical_journey_required != selected_canonical:
            raise ValueError("canonical journey requirement and selection must agree")
        if self.operator_promotion:
            if self.operator_promotion.source_decision_digest != self.base_decision_digest:
                raise ValueError("operator promotion no longer matches its source decision")
        if _construction_token is not _DECISION_CONSTRUCTION_TOKEN:
            raise ValueError("change impact decisions must be constructed by the classifier")

    @property
    def full_g3_required(self) -> bool:
        return self.canonical_journey_required and self.clean_resources_required and (
            CANONICAL_JOURNEY_ID in self.selected_acceptance_scenarios
        )

    def _payload(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["size_signals"] = {
            "production_file_count": payload.pop("production_file_count"),
            "executable_lines_changed": payload.pop("executable_lines_changed"),
        }
        payload["full_g3_required"] = self.full_g3_required
        return payload

    def _base_payload(self) -> dict[str, Any]:
        payload = self._payload()
        if self.operator_promotion is None:
            return payload
        payload["selected_acceptance_scenarios"] = tuple(
            item
            for item in payload["selected_acceptance_scenarios"]
            if item != CANONICAL_JOURNEY_ID
        )
        other_skips = tuple(
            item
            for item in payload["not_evaluated"]
            if item["scenario_id"] != CANONICAL_JOURNEY_ID
        )
        payload["not_evaluated"] = (*other_skips, {
            "scenario_id": CANONICAL_JOURNEY_ID,
            "reason": "localized_change_not_promoted",
        })
        payload["canonical_journey_required"] = False
        payload["clean_resources_required"] = False
        payload["full_g3_required"] = False
        payload["decision_reasons"] = tuple(
            reason
            for reason in payload["decision_reasons"]
            if reason != "operator_promoted_full_g3"
        )
        payload["operator_promotion"] = None
        return payload

    @property
    def base_decision_digest(self) -> str:
        return _digest(self._base_payload())

    @property
    def decision_digest(self) -> str:
        return _digest(self._payload())

    def to_dict(self) -> dict[str, Any]:
        return {**self._payload(), "decision_digest": self.decision_digest}


def promote_localized_decision(
    decision: ChangeImpactDecision,
    promotion: OperatorPromotion,
) -> ChangeImpactDecision:
    if promotion.source_decision_digest != decision.decision_digest:
        raise ValueError("operator promotion must reference the exact decision digest")
    if decision.selection_status != "selected" or decision.risk_class != "localized":
        raise ValueError("operator promotion requires a selected localized decision")
    if decision.operator_promotion is not None:
        raise ValueError("localized decision has already been promoted")
    return replace(
        decision,
        selected_acceptance_scenarios=(
            *decision.selected_acceptance_scenarios,
            CANONICAL_JOURNEY_ID,
        ),
        not_evaluated=tuple(
            item
            for item in decision.not_evaluated
            if item.scenario_id != CANONICAL_JOURNEY_ID
        ),
        canonical_journey_required=True,
        clean_resources_required=True,
        decision_reasons=tuple(
            sorted({*decision.decision_reasons, "operator_promoted_full_g3"})
        ),
        operator_promotion=promotion,
        _construction_token=_DECISION_CONSTRUCTION_TOKEN,
    )
