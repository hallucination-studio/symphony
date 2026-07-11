from __future__ import annotations

from .catalog import CANONICAL_JOURNEY_ID
from .impact_models import (
    _RISK_ORDER,
    ChangeImpactDecision,
    ChangeImpactInput,
    ChangeImpactPolicy,
    ChangeImpactRule,
    NotEvaluatedScenario,
    OperatorPromotion,
    RiskClass,
    SelectionStatus,
    _highest,
    _matches,
    _repo_path,
    promote_localized_decision,
)


def _matched_impact(
    change: ChangeImpactInput,
    policy: ChangeImpactPolicy,
) -> tuple[
    tuple[str, ...],
    tuple[str, ...],
    frozenset[ChangeImpactRule],
    tuple[str, ...],
    tuple[str, ...],
]:
    paths = tuple(sorted({_repo_path(path) for path in change.changed_paths}))
    production_paths = tuple(
        path
        for path in paths
        if any(_matches(path, root) for root in policy.production_roots)
    )
    rules: set[ChangeImpactRule] = set()
    unknown_paths: list[str] = []
    for path in paths:
        matched = {rule for rule in policy.rules if rule.matches(path)}
        rules.update(matched)
        if path in production_paths and not matched:
            unknown_paths.append(path)
    known_capabilities = {rule.capability for rule in policy.rules}
    unknown_capabilities = tuple(
        sorted(set(change.declared_capabilities) - known_capabilities)
    )
    rules.update(
        rule for rule in policy.rules if rule.capability in change.declared_capabilities
    )
    return (
        paths,
        production_paths,
        frozenset(rules),
        tuple(unknown_paths),
        unknown_capabilities,
    )


def _values(
    rules: frozenset[ChangeImpactRule],
    field: str,
) -> tuple[str, ...]:
    return tuple(sorted({value for rule in rules for value in getattr(rule, field)}))


def _classify_risk(
    change: ChangeImpactInput,
    policy: ChangeImpactPolicy,
    rules: frozenset[ChangeImpactRule],
    production_file_count: int,
) -> tuple[RiskClass, RiskClass, set[str]]:
    candidates: list[RiskClass] = [rule.risk_class for rule in rules] or ["localized"]
    capabilities = {rule.capability for rule in rules} | set(change.declared_capabilities)
    roles = {rule.runtime_role for rule in rules if rule.runtime_role}
    reasons = {f"matched_rule:{rule.capability}:{rule.risk_class}" for rule in rules}
    reasons.update(f"core_trigger:{trigger}" for trigger in _values(rules, "core_triggers"))
    major_signals = (
        (len(capabilities) >= 2, "major_multiple_capabilities"),
        (len(roles) >= 2, "major_multiple_runtime_roles"),
        (
            production_file_count >= policy.major_file_threshold,
            "major_production_file_threshold",
        ),
        (
            change.executable_lines_changed >= policy.major_line_threshold,
            "major_executable_line_threshold",
        ),
    )
    for matched, reason in major_signals:
        if matched:
            candidates.append("major")
            reasons.add(reason)
    objective = _highest(tuple(candidates))
    risk_class = _highest((objective, change.declared_risk_class))
    if risk_class != objective:
        reasons.add(f"declared_risk_promotion:{change.declared_risk_class}")
    return objective, risk_class, reasons


def classify_change(
    change: ChangeImpactInput,
    policy: ChangeImpactPolicy,
) -> ChangeImpactDecision:
    paths, production_paths, rules, unknown_paths, unknown_capabilities = (
        _matched_impact(change, policy)
    )
    objective, risk_class, reasons = _classify_risk(
        change,
        policy,
        rules,
        len(production_paths),
    )
    blocked = bool(unknown_paths or unknown_capabilities)
    if unknown_paths:
        reasons.add("unknown_production_paths")
    if unknown_capabilities:
        reasons.add("unknown_declared_capabilities")
    canonical = not blocked and risk_class in ("core", "major")
    selected = () if blocked else _values(rules, "acceptance_scenarios")
    if canonical:
        selected = tuple(sorted({*selected, CANONICAL_JOURNEY_ID}))
    skip_reason = (
        "selection_blocked_unknown_impact_mapping"
        if blocked
        else "localized_change_not_promoted"
    )
    return ChangeImpactDecision._from_classifier(
        schema_version=1,
        commit_sha=change.commit_sha,
        baseline_sha=change.baseline_sha,
        build_digest=change.build_digest,
        configuration_digest=change.configuration_digest,
        classifier_revision=policy.revision,
        classifier_digest=policy.digest,
        changed_paths=paths,
        declared_capabilities=tuple(sorted(set(change.declared_capabilities))),
        declared_risk_class=change.declared_risk_class,
        selection_status="blocked" if blocked else "selected",
        risk_class=None if blocked else risk_class,
        objective_risk_class=None if blocked else objective,
        core_triggers=_values(rules, "core_triggers"),
        production_file_count=len(production_paths),
        executable_lines_changed=change.executable_lines_changed,
        affected_capabilities=tuple(
            sorted({rule.capability for rule in rules} | set(change.declared_capabilities))
        ),
        affected_business_scenarios=_values(rules, "business_scenarios"),
        selected_acceptance_scenarios=selected,
        not_evaluated=(
            ()
            if canonical
            else (NotEvaluatedScenario(CANONICAL_JOURNEY_ID, skip_reason),)
        ),
        unknown_production_paths=unknown_paths,
        unknown_declared_capabilities=unknown_capabilities,
        canonical_journey_required=canonical,
        clean_resources_required=canonical,
        decision_reasons=tuple(sorted(reasons)),
    )


__all__ = [
    "ChangeImpactDecision",
    "ChangeImpactInput",
    "ChangeImpactPolicy",
    "ChangeImpactRule",
    "NotEvaluatedScenario",
    "OperatorPromotion",
    "RiskClass",
    "SelectionStatus",
    "classify_change",
    "promote_localized_decision",
]
