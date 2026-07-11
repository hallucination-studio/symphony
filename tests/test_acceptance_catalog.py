from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import replace
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from symphony_acceptance.catalog import (  # noqa: E402
    ACCEPTANCE_SCENARIOS,
    BUSINESS_SCENARIOS,
    JOURNEYS,
    validate_catalog,
)
from symphony_acceptance.markdown import render_catalog_markdown  # noqa: E402
from symphony_acceptance.models import (  # noqa: E402
    AcceptanceScenarioSpec,
    BusinessScenarioSpec,
    JourneySpec,
)


PRODUCT_CATALOG = ROOT / "docs" / "product" / "acceptance-catalog.md"
CANONICAL_JOURNEY_ID = "customer_onboarding_to_completed_managed_run"


def _business(identifier: str = "B_test") -> BusinessScenarioSpec:
    return BusinessScenarioSpec(
        id=identifier,
        actor="customer",
        customer_job="Complete one useful task.",
        start_state="ready",
        accepted_outcome="done",
        visible_artifacts=("result",),
    )


def _scenario(identifier: str = "scenario_test") -> AcceptanceScenarioSpec:
    return AcceptanceScenarioSpec(
        id=identifier,
        proves="One useful task produces one visible result.",
        business_scenarios=("B_test",),
        minimum_level="system",
        real_boundaries=(),
        authoritative_oracles=("result",),
        operator_oracles=("result",),
        required_evidence=("result",),
        cleanup=("local_state",),
        trigger_tags=("manual",),
    )


def test_catalog_is_valid_and_covers_every_business_scenario() -> None:
    assert validate_catalog(BUSINESS_SCENARIOS, ACCEPTANCE_SCENARIOS, JOURNEYS) == []
    assert len(BUSINESS_SCENARIOS) == 34
    assert len(ACCEPTANCE_SCENARIOS) == 32

    covered = {
        business_id
        for entry in (*ACCEPTANCE_SCENARIOS, *JOURNEYS)
        for business_id in entry.business_scenarios
    }
    assert covered == {item.id for item in BUSINESS_SCENARIOS}


def test_generated_product_catalog_matches_the_executable_catalog() -> None:
    expected = render_catalog_markdown(BUSINESS_SCENARIOS, ACCEPTANCE_SCENARIOS, JOURNEYS)

    assert PRODUCT_CATALOG.read_text(encoding="utf-8") == expected


def test_polling_restart_and_redelegation_has_decisive_evidence() -> None:
    scenario = next(item for item in ACCEPTANCE_SCENARIOS if item.id == "polling_restart_redelegation")

    assert scenario.business_scenarios == (
        "B13_delegated_issue_to_verified_delivery",
        "B14_understand_managed_delivery",
    )
    assert scenario.minimum_level == "integration"
    assert {"linear", "podium"}.issubset(scenario.real_boundaries)
    assert {"polling", "dispatch"}.issubset(scenario.authoritative_oracles)
    assert {
        "page_checkpoints",
        "normalized_observations",
        "delegation_epochs",
        "idempotency_keys",
        "dispatches",
        "cleanup",
    }.issubset(scenario.required_evidence)


def test_canonical_journey_requires_polling_delivery_and_customer_review() -> None:
    journey = next(item for item in JOURNEYS if item.id == CANONICAL_JOURNEY_ID)

    assert journey.business_scenarios == (
        "B01a_register_workspace_account",
        "B01c_sign_out_workspace_session",
        "B02_authorize_default_linear_app",
        "B06a_select_managed_project",
        "B07_install_named_conductor",
        "B08_bind_project_repository",
        "B13_delegated_issue_to_verified_delivery",
        "B14_understand_managed_delivery",
    )
    assert {"browser", "linear", "podium", "conductor", "performer", "codex", "repository"}.issubset(
        journey.real_boundaries
    )
    assert {"polling", "dispatch", "delivery", "repository"}.issubset(journey.authoritative_oracles)
    assert "linear_customer_experience" in journey.operator_oracles
    assert {
        "page_checkpoints",
        "normalized_observations",
        "delegation_epochs",
        "idempotency_keys",
        "dispatches",
        "delivery_attempt",
        "delivery_record",
        "delivery_ref",
        "final_verification",
        "linear_experience_review",
        "cleanup",
    }.issubset(journey.required_evidence)
    assert set(journey.trigger_tags) == {"core_change", "major_change", "manual"}


def test_validation_rejects_missing_required_fields() -> None:
    business = BusinessScenarioSpec(
        id="B_test",
        actor="",
        customer_job="",
        start_state="",
        accepted_outcome="",
        visible_artifacts=(),
    )
    scenario = AcceptanceScenarioSpec(
        id="",
        proves="",
        business_scenarios=(),
        minimum_level="",
        real_boundaries=(),
        authoritative_oracles=(),
        operator_oracles=(),
        required_evidence=(),
        cleanup=(),
        trigger_tags=(),
    )

    errors = validate_catalog((business,), (scenario,), JOURNEYS)

    for field in ("actor", "customer_job", "start_state", "accepted_outcome", "visible_artifacts"):
        assert f"business_scenario_field_required:B_test:{field}" in errors
    for field in (
        "id",
        "proves",
        "business_scenarios",
        "minimum_level",
        "authoritative_oracles",
        "operator_oracles",
        "required_evidence",
        "cleanup",
        "trigger_tags",
    ):
        assert f"acceptance_entry_field_required:<missing>:{field}" in errors


def test_validation_rejects_duplicate_ids_and_proof_claims() -> None:
    business = _business()
    scenario = _scenario()
    duplicate_id = replace(scenario, proves="A second distinct proof claim.")
    duplicate_proof = replace(scenario, id="scenario_other")

    errors = validate_catalog(
        (business, business),
        (scenario, duplicate_id, duplicate_proof),
        JOURNEYS,
    )

    assert "duplicate_business_scenario_id:B_test" in errors
    assert "duplicate_acceptance_entry_id:scenario_test" in errors
    assert f"duplicate_acceptance_proves:{scenario.proves}" in errors


def test_validation_rejects_unknown_and_uncovered_business_mappings() -> None:
    business = _business()
    scenario = replace(_scenario(), business_scenarios=("B_missing",))

    errors = validate_catalog((business,), (scenario,), JOURNEYS)

    assert "unknown_business_scenario:scenario_test:B_missing" in errors
    assert "business_scenario_uncovered:B_test" in errors


def test_validation_rejects_unknown_and_cyclic_dependencies() -> None:
    business = _business()
    first = replace(_scenario("first"), depends_on=("second", "missing"))
    second = replace(_scenario("second"), depends_on=("first",))

    errors = validate_catalog((business,), (first, second), JOURNEYS)

    assert "unknown_acceptance_dependency:first:missing" in errors
    assert "acceptance_dependency_cycle:first" in errors


def test_validation_rejects_invalid_levels_live_without_boundaries_and_empty_journey_preconditions() -> None:
    business = _business()
    invalid_level = replace(_scenario("invalid_level"), minimum_level="browser")
    boundaryless_live = replace(_scenario("boundaryless_live"), minimum_level="live")
    journey = replace(JOURNEYS[0], preconditions=())

    errors = validate_catalog((business,), (invalid_level, boundaryless_live), (journey,))

    assert "acceptance_level_invalid:invalid_level:browser" in errors
    assert "live_boundary_required:boundaryless_live" in errors
    assert f"journey_preconditions_required:{CANONICAL_JOURNEY_ID}" in errors


def test_validation_rejects_an_incomplete_canonical_journey() -> None:
    journey = replace(
        JOURNEYS[0],
        real_boundaries=("browser", "linear", "podium"),
        authoritative_oracles=("managed_run",),
        operator_oracles=("podium",),
        required_evidence=("cleanup",),
        trigger_tags=("manual",),
    )

    errors = validate_catalog(BUSINESS_SCENARIOS, ACCEPTANCE_SCENARIOS, (journey,))

    assert "canonical_boundary_required:repository" in errors
    assert "canonical_authority_required:polling" in errors
    assert "canonical_authority_required:delivery" in errors
    assert "canonical_evidence_required:page_checkpoints" in errors
    assert "canonical_evidence_required:delivery_record" in errors
    assert "canonical_operator_oracle_required:linear_customer_experience" in errors
    assert "canonical_trigger_required:core_change" in errors


def test_validation_requires_the_canonical_journey() -> None:
    errors = validate_catalog((_business(),), (_scenario(),), ())

    assert "canonical_journey_required" in errors


def test_catalog_cli_emits_valid_machine_readable_json() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "symphony_acceptance", "catalog", "--json"],
        cwd=ROOT,
        env={**os.environ, "PYTHONPATH": str(TOOLS)},
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["valid"] is True
    assert payload["errors"] == []
    assert len(payload["business_scenarios"]) == 34
    assert len(payload["acceptance_scenarios"]) == 32
    assert payload["journeys"][0]["id"] == CANONICAL_JOURNEY_ID


def test_catalog_cli_prints_and_writes_the_generated_markdown(tmp_path: Path) -> None:
    expected = render_catalog_markdown(BUSINESS_SCENARIOS, ACCEPTANCE_SCENARIOS, JOURNEYS)
    environment = {**os.environ, "PYTHONPATH": str(TOOLS)}
    printed = subprocess.run(
        [sys.executable, "-m", "symphony_acceptance", "catalog", "--markdown"],
        cwd=ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    output_path = tmp_path / "product" / "acceptance-catalog.md"
    written = subprocess.run(
        [
            sys.executable,
            "-m",
            "symphony_acceptance",
            "catalog",
            "--markdown",
            "--write",
            str(output_path),
        ],
        cwd=ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert printed.returncode == 0, printed.stderr
    assert printed.stdout == expected
    assert written.returncode == 0, written.stderr
    assert written.stdout == f"wrote={output_path}\n"
    assert output_path.read_text(encoding="utf-8") == expected
