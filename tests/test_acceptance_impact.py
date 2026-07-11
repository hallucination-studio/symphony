from __future__ import annotations

from dataclasses import FrozenInstanceError, replace

import pytest

from tools.symphony_acceptance.catalog import CANONICAL_JOURNEY_ID
from tools.symphony_acceptance.impact import (
    ChangeImpactInput,
    ChangeImpactPolicy,
    ChangeImpactRule,
    OperatorPromotion,
    RiskClass,
    classify_change,
    promote_localized_decision,
)


def _rule(
    capability: str,
    risk_class: str,
    path: str,
    *,
    role: str = "podium",
) -> ChangeImpactRule:
    return ChangeImpactRule(
        path_prefixes=(path,),
        capability=capability,
        business_scenarios=(f"B_{capability}",),
        acceptance_scenarios=(f"accept_{capability}",),
        risk_class=risk_class,
        runtime_role=role,
        core_triggers=(f"{capability}_semantics",) if risk_class == "core" else (),
    )


def _input(
    *paths: str,
    declared_risk_class: RiskClass = "localized",
) -> ChangeImpactInput:
    return ChangeImpactInput(
        commit_sha="commit-a",
        baseline_sha="baseline-a",
        build_digest="sha256:build-a",
        configuration_digest="sha256:config-a",
        changed_paths=paths,
        declared_risk_class=declared_risk_class,
        executable_lines_changed=len(paths),
    )


def _policy(*rules: ChangeImpactRule, revision: str = "impact-v1") -> ChangeImpactPolicy:
    return ChangeImpactPolicy(revision=revision, rules=rules)


def test_classification_uses_core_then_major_then_localized_precedence() -> None:
    localized = _rule("runtime_copy", "localized", "packages/podium/web/")
    major = _rule("store_migration", "major", "packages/podium/src/podium/store/")
    core = _rule("dispatch", "core", "packages/podium/src/podium/linear_reconciler.py")

    decision = classify_change(
        _input(
            "packages/podium/web/src/copy.ts",
            "packages/podium/src/podium/store/migrations.py",
            "packages/podium/src/podium/linear_reconciler.py",
        ),
        _policy(localized, major, core),
    )

    assert decision.selection_status == "selected"
    assert decision.risk_class == "core"
    assert decision.affected_capabilities == ("dispatch", "runtime_copy", "store_migration")
    assert decision.canonical_journey_required is True
    assert decision.full_g3_required is True
    assert decision.clean_resources_required is True
    assert CANONICAL_JOURNEY_ID in decision.selected_acceptance_scenarios


@pytest.mark.parametrize("objective_risk", ["core", "major"])
def test_objective_core_or_major_rule_cannot_be_downgraded(
    objective_risk: str,
) -> None:
    rule = _rule("managed_run", objective_risk, "packages/conductor/src/conductor/")

    decision = classify_change(
        _input(
            "packages/conductor/src/conductor/engine.py",
            declared_risk_class="localized",
        ),
        _policy(rule),
    )

    assert decision.risk_class == objective_risk
    assert decision.canonical_journey_required is True
    assert decision.clean_resources_required is True
    assert CANONICAL_JOURNEY_ID in decision.selected_acceptance_scenarios


def test_unknown_production_path_blocks_all_scenario_selection() -> None:
    known = _rule("auth", "core", "packages/podium/src/podium/auth/")

    decision = classify_change(
        _input(
            "packages/podium/src/podium/auth/session.py",
            "packages/podium/src/podium/unregistered.py",
        ),
        _policy(known),
    )

    assert decision.selection_status == "blocked"
    assert decision.risk_class is None
    assert decision.unknown_production_paths == (
        "packages/podium/src/podium/unregistered.py",
    )
    assert decision.selected_acceptance_scenarios == ()
    assert decision.canonical_journey_required is False
    assert decision.full_g3_required is False
    assert "unknown_production_paths" in decision.decision_reasons


def test_unknown_impact_decision_cannot_be_rewritten_as_selected() -> None:
    decision = classify_change(
        _input("packages/podium/src/podium/unregistered.py"),
        _policy(),
    )

    with pytest.raises(ValueError, match="unknown impact requires blocked selection"):
        replace(
            decision,
            selection_status="selected",
            risk_class="localized",
            objective_risk_class="localized",
        )


def test_blocked_decision_cannot_require_canonical_journey() -> None:
    decision = classify_change(
        _input("packages/podium/src/podium/unregistered.py"),
        _policy(),
    )

    with pytest.raises(ValueError, match="blocked decision cannot require acceptance execution"):
        replace(
            decision,
            canonical_journey_required=True,
            clean_resources_required=True,
        )


def test_unknown_non_production_path_does_not_block_selection() -> None:
    decision = classify_change(
        _input("docs/product/runtime-pipeline.md"),
        _policy(),
    )

    assert decision.selection_status == "selected"
    assert decision.risk_class == "localized"
    assert decision.unknown_production_paths == ()


def test_localized_decision_selects_focused_scenario_and_records_canonical_skip() -> None:
    rule = _rule("runtime_copy", "localized", "packages/podium/web/")

    decision = classify_change(
        _input("packages/podium/web/src/copy.ts"),
        _policy(rule),
    )

    assert decision.risk_class == "localized"
    assert decision.selected_acceptance_scenarios == ("accept_runtime_copy",)
    assert decision.canonical_journey_required is False
    assert decision.clean_resources_required is False
    assert [(item.scenario_id, item.reason) for item in decision.not_evaluated] == [
        (CANONICAL_JOURNEY_ID, "localized_change_not_promoted"),
    ]


def test_operator_promotion_is_bound_to_one_exact_localized_decision() -> None:
    rule = _rule("runtime_copy", "localized", "packages/podium/web/")
    decision = classify_change(
        _input("packages/podium/web/src/copy.ts"),
        _policy(rule),
    )

    with pytest.raises(ValueError, match="exact decision digest"):
        promote_localized_decision(
            decision,
            OperatorPromotion(
                source_decision_digest="sha256:another-decision",
                operator="release-operator",
                reason="customer-visible release",
            ),
        )

    promotion = OperatorPromotion(
        source_decision_digest=decision.decision_digest,
        operator="release-operator",
        reason="customer-visible release",
    )
    promoted = promote_localized_decision(decision, promotion)

    assert promoted.operator_promotion == promotion
    assert promoted.risk_class == "localized"
    assert promoted.canonical_journey_required is True
    assert promoted.full_g3_required is True
    assert promoted.clean_resources_required is True
    assert promoted.selected_acceptance_scenarios == (
        "accept_runtime_copy",
        CANONICAL_JOURNEY_ID,
    )
    assert promoted.not_evaluated == ()
    assert promoted.commit_sha == decision.commit_sha
    assert promoted.build_digest == decision.build_digest
    assert promoted.configuration_digest == decision.configuration_digest
    assert promoted.classifier_digest == decision.classifier_digest

    with pytest.raises(FrozenInstanceError):
        promoted.canonical_journey_required = False  # type: ignore[misc]
    with pytest.raises(ValueError, match="promoted decision requires full G3"):
        replace(promoted, canonical_journey_required=False)
    with pytest.raises(ValueError, match="promotion no longer matches"):
        replace(promoted, commit_sha="commit-after-promotion")


def test_localized_canonical_selection_cannot_bypass_operator_promotion() -> None:
    rule = _rule("runtime_copy", "localized", "packages/podium/web/")
    decision = classify_change(
        _input("packages/podium/web/src/copy.ts"),
        _policy(rule),
    )

    with pytest.raises(ValueError, match="requires an exact operator promotion"):
        replace(
            decision,
            selected_acceptance_scenarios=(
                *decision.selected_acceptance_scenarios,
                CANONICAL_JOURNEY_ID,
            ),
            canonical_journey_required=True,
            clean_resources_required=True,
        )


def test_core_trigger_decision_cannot_be_rewritten_as_localized() -> None:
    decision = classify_change(
        _input("packages/conductor/src/conductor/engine.py"),
        _policy(_rule("engine", "core", "packages/conductor/src/conductor/")),
    )

    with pytest.raises(ValueError, match="core triggers require core objective risk"):
        replace(
            decision,
            objective_risk_class="localized",
            risk_class="localized",
            selected_acceptance_scenarios=("accept_engine",),
            not_evaluated=(),
            canonical_journey_required=False,
            clean_resources_required=False,
        )


def test_classifier_decision_cannot_be_reconstructed_as_a_valid_looking_downgrade() -> None:
    decision = classify_change(
        _input("packages/conductor/src/conductor/engine.py"),
        _policy(_rule("engine", "core", "packages/conductor/src/conductor/")),
    )

    with pytest.raises(ValueError, match="must be constructed by the classifier"):
        replace(
            decision,
            objective_risk_class="localized",
            risk_class="localized",
            core_triggers=(),
            selected_acceptance_scenarios=("accept_engine",),
            not_evaluated=(),
            canonical_journey_required=False,
            clean_resources_required=False,
            decision_reasons=(),
        )


def test_rule_rejects_core_triggers_without_core_risk() -> None:
    with pytest.raises(ValueError, match="core triggers require core risk"):
        ChangeImpactRule(
            path_prefixes=("packages/podium/src/podium/auth/",),
            capability="auth",
            business_scenarios=("B_auth",),
            acceptance_scenarios=("accept_auth",),
            risk_class="localized",
            core_triggers=("authorization_semantics",),
        )


def test_rule_rejects_canonical_journey_as_focused_scenario() -> None:
    with pytest.raises(ValueError, match="canonical journey cannot be a focused scenario"):
        ChangeImpactRule(
            path_prefixes=("packages/podium/src/podium/auth/",),
            capability="auth",
            business_scenarios=("B_auth",),
            acceptance_scenarios=(CANONICAL_JOURNEY_ID,),
            risk_class="core",
        )


def test_operator_promotion_rejects_blocked_core_and_major_decisions() -> None:
    promotion_values = {
        "source_decision_digest": "replaced-below",
        "operator": "release-operator",
        "reason": "manual acceptance",
    }
    decisions = [
        classify_change(
            _input("packages/unknown.py"),
            _policy(),
        ),
        classify_change(
            _input("packages/podium/src/podium/auth/session.py"),
            _policy(_rule("auth", "core", "packages/podium/src/podium/auth/")),
        ),
        classify_change(
            _input("packages/podium/src/podium/store/schema.py"),
            _policy(_rule("store", "major", "packages/podium/src/podium/store/")),
        ),
    ]

    for decision in decisions:
        promotion = OperatorPromotion(
            **{**promotion_values, "source_decision_digest": decision.decision_digest}
        )
        with pytest.raises(ValueError, match="selected localized decision"):
            promote_localized_decision(decision, promotion)


def test_decision_and_policy_digests_bind_code_build_configuration_and_classifier() -> None:
    rule = _rule("runtime_copy", "localized", "packages/podium/web/")
    policy = _policy(rule)
    base_input = _input("packages/podium/web/src/copy.ts")
    decision = classify_change(base_input, policy)

    payload = decision.to_dict()
    assert payload["commit_sha"] == "commit-a"
    assert payload["build_digest"] == "sha256:build-a"
    assert payload["configuration_digest"] == "sha256:config-a"
    assert payload["classifier_digest"] == policy.digest
    assert payload["decision_digest"] == decision.decision_digest

    changed_decision_digests = {
        classify_change(replace(base_input, commit_sha="commit-b"), policy).decision_digest,
        classify_change(
            replace(base_input, build_digest="sha256:build-b"), policy
        ).decision_digest,
        classify_change(
            replace(base_input, configuration_digest="sha256:config-b"), policy
        ).decision_digest,
        classify_change(base_input, _policy(rule, revision="impact-v2")).decision_digest,
    }

    assert decision.decision_digest not in changed_decision_digests
    assert len(changed_decision_digests) == 4


def test_major_breadth_signals_cannot_be_hidden_by_localized_declaration() -> None:
    first = _rule("one", "localized", "packages/podium/src/podium/one/", role="podium")
    second = _rule(
        "two",
        "localized",
        "packages/conductor/src/conductor/two/",
        role="conductor",
    )

    decision = classify_change(
        _input(
            "packages/podium/src/podium/one/change.py",
            "packages/conductor/src/conductor/two/change.py",
            declared_risk_class="localized",
        ),
        _policy(first, second),
    )

    assert decision.risk_class == "major"
    assert "major_multiple_capabilities" in decision.decision_reasons
    assert "major_multiple_runtime_roles" in decision.decision_reasons
    assert decision.canonical_journey_required is True
