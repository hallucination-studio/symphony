from __future__ import annotations

from collections import Counter
from collections.abc import Iterable

from .models import (
    ALLOWED_TEST_LEVELS,
    AcceptanceEntry,
    AcceptanceScenarioSpec,
    BusinessScenarioSpec,
    JourneySpec,
)


CANONICAL_JOURNEY_ID = "customer_onboarding_to_completed_managed_run"


def _business(
    identifier: str,
    actor: str,
    customer_job: str,
    start_state: str,
    accepted_outcome: str,
    *visible_artifacts: str,
) -> BusinessScenarioSpec:
    return BusinessScenarioSpec(identifier, actor, customer_job, start_state, accepted_outcome, visible_artifacts)


BUSINESS_SCENARIOS: tuple[BusinessScenarioSpec, ...] = (
    _business("B01a_register_workspace_account", "workspace_visitor", "Register a workspace account.", "no_account", "authenticated_workspace", "browser_session", "podium_account"),
    _business("B01b_sign_in_existing_workspace", "workspace_member", "Sign in to an existing workspace.", "signed_out", "authenticated_workspace", "browser_session", "podium_account"),
    _business("B01c_sign_out_workspace_session", "workspace_member", "End the current workspace session.", "authenticated_workspace", "session_invalidated", "browser_session", "protected_bootstrap"),
    _business("B02_authorize_default_linear_app", "workspace_admin", "Authorize Symphony's default Linear app.", "no_linear_installation", "healthy_active_installation", "podium_installation", "linear_authorization", "polling_health"),
    _business("B03_activate_customer_owned_linear_app", "workspace_admin", "Activate a customer-owned Linear app.", "no_custom_installation", "healthy_active_installation", "podium_installation", "linear_app_identity", "polling_configuration"),
    _business("B04_replace_active_linear_app", "workspace_admin", "Replace the active Linear app without disrupting work.", "healthy_active_installation", "replacement_active_after_drain", "podium_installation", "runtime_health"),
    _business("B05a_reconnect_linear_installation", "workspace_admin", "Reconnect an unhealthy Linear installation.", "unhealthy_installation", "healthy_active_installation", "podium_installation", "linear_authorization"),
    _business("B05b_revoke_linear_installation", "workspace_admin", "Revoke an unwanted Linear installation.", "active_installation", "revoked_unroutable_installation", "podium_installation", "routing_state"),
    _business("B06a_select_managed_project", "workspace_admin", "Add a Linear project to Symphony scope.", "accessible_unselected_project", "selected_project", "podium_project", "linear_membership"),
    _business("B06b_deselect_managed_project", "workspace_admin", "Remove a Linear project from Symphony scope.", "selected_unbound_project", "deselected_unroutable_project", "podium_project", "linear_membership"),
    _business("B07_install_named_conductor", "operator", "Install an isolated named Conductor.", "no_runtime", "online_unbound_conductor", "podium_runtime", "install_command"),
    _business("B08_bind_project_repository", "operator", "Bind one project and repository to a Conductor.", "online_unbound_conductor", "routing_ready_binding", "podium_binding", "repository_health", "linear_label"),
    _business("B09_add_second_project_runtime", "operator", "Run a second isolated project runtime on the same host.", "one_active_runtime", "two_isolated_runtimes", "podium_runtime", "linear_labels"),
    _business("B10a_rename_runtime", "operator", "Rename a runtime without changing its identity.", "healthy_runtime", "renamed_healthy_runtime", "podium_runtime", "linear_label"),
    _business("B10b_replace_runtime", "operator", "Replace a project runtime after drain.", "bound_runtime", "replacement_owns_binding", "podium_runtime", "podium_binding"),
    _business("B10c_unbind_runtime", "operator", "Remove runtime ownership from a project.", "bound_runtime", "drained_unbound_runtime", "podium_runtime", "routing_state"),
    _business("B10d_rebind_runtime", "operator", "Bind an unbound runtime to a project again.", "online_unbound_runtime", "routing_ready_binding", "podium_runtime", "podium_binding"),
    _business("B11a_update_runtime", "operator", "Update a runtime to a healthy target version.", "healthy_old_version", "healthy_target_version", "podium_runtime", "operation_status"),
    _business("B11b_rollback_runtime", "operator", "Roll back an unhealthy runtime update.", "failed_runtime_update", "prior_version_healthy", "podium_runtime", "rollback_status"),
    _business("B12a_rotate_runtime_credentials", "operator", "Rotate scoped runtime credentials.", "active_runtime_credential", "old_revoked_new_healthy", "credential_status", "audit_event"),
    _business("B12b_suspend_runtime_routing", "operator", "Suspend new runtime work after drain.", "routing_ready_runtime", "routing_suspended", "routing_state", "drain_status"),
    _business("B12c_resume_runtime_routing", "operator", "Resume routing after health checks.", "healthy_suspended_runtime", "routing_ready_runtime", "routing_state", "runtime_health"),
    _business("B12d_inspect_runtime_logs_and_audit", "operator", "Diagnose runtime activity from sanitized evidence.", "runtime_operation_or_incident", "activity_understood", "podium_logs", "audit_events"),
    _business("B13_delegated_issue_to_verified_delivery", "project_member", "Delegate real work and receive a verified repository delivery.", "routing_ready_delegated_issue", "verified_delivery_ref_and_done_run", "linear_issue_tree", "podium_managed_run", "delivery_ref", "delivery_record"),
    _business("B14_understand_managed_delivery", "project_member", "Understand delivery progress, failure, and next action.", "active_or_terminal_run", "run_state_understood", "podium_managed_run", "linear_projection", "operator_logs"),
    _business("B15_resume_deferred_dispatch", "project_member", "Receive work after a temporary routing blocker clears.", "delegated_ineligible_issue", "exactly_one_run_after_recovery", "podium_dispatch", "linear_issue"),
    _business("B16_add_linear_dependency", "project_member", "Add a Linear dependency that changes execution order.", "active_immutable_plan", "validated_dependency_overlay", "linear_relation", "podium_managed_run"),
    _business("B17a_approve_managed_plan", "project_member", "Approve a proposed managed plan.", "plan_waiting_for_approval", "recorded_approval_resumes_run", "linear_root_issue", "podium_wait"),
    _business("B17b_approve_work_item_gate", "project_member", "Approve one gated work item.", "work_item_waiting_for_approval", "only_that_item_becomes_eligible", "linear_work_item", "podium_wait"),
    _business("B18_supply_missing_business_input", "project_member", "Supply missing information and resume managed work.", "managed_information_wait", "affected_work_resumed", "linear_issue", "podium_wait"),
    _business("B19_resolve_runtime_input_wait", "project_member", "Resolve a runtime approval or tool-input wait.", "runtime_wait", "same_turn_resumed", "linear_human_action_issue", "podium_runtime_wait"),
    _business("B20_approve_plan_revision", "project_member", "Approve a changed plan scope or dependency graph.", "accepted_plan_insufficient", "immutable_new_plan_version", "linear_issue_tree", "podium_managed_run"),
    _business("B21_receive_verified_rework", "project_member", "Receive corrected work after independent verification fails.", "verification_failure", "rework_verified", "linear_attempt_evidence", "podium_verification_history"),
    _business("B22_resolve_integration_conflict", "project_member", "Resolve an integration conflict and receive delivery.", "integration_conflict", "verified_delivery_after_resolution", "linear_action", "podium_delivery", "delivery_record"),
)


def _scenario(
    identifier: str,
    proves: str,
    business_scenarios: tuple[str, ...],
    *,
    minimum_level: str = "system",
    real_boundaries: tuple[str, ...] = (),
    authoritative_oracles: tuple[str, ...] = ("managed_run",),
    operator_oracles: tuple[str, ...] = ("podium", "linear", "logs"),
    required_evidence: tuple[str, ...] = ("authority_snapshot", "operator_snapshot", "cleanup"),
    trigger_tags: tuple[str, ...] = ("manual",),
) -> AcceptanceScenarioSpec:
    return AcceptanceScenarioSpec(
        identifier,
        proves,
        business_scenarios,
        minimum_level,
        real_boundaries,
        authoritative_oracles,
        operator_oracles,
        required_evidence,
        ("resource_ledger",),
        trigger_tags,
    )


ACCEPTANCE_SCENARIOS: tuple[AcceptanceScenarioSpec, ...] = (
    _scenario("workspace_account_access", "Registration, sign-in, and logout each produce the correct session outcome.", ("B01a_register_workspace_account", "B01b_sign_in_existing_workspace", "B01c_sign_out_workspace_session"), minimum_level="contract", real_boundaries=("browser",), authoritative_oracles=("session",), operator_oracles=("browser", "podium"), required_evidence=("session_responses", "cookie_state", "cleanup"), trigger_tags=("auth", "manual")),
    _scenario("customer_owned_app_activation", "A customer-owned Linear app becomes the first healthy active installation.", ("B03_activate_customer_owned_linear_app",), minimum_level="integration", real_boundaries=("browser", "linear", "podium"), authoritative_oracles=("installation",), required_evidence=("oauth_callback", "installation_health", "polling_health", "cleanup"), trigger_tags=("installation", "manual")),
    _scenario("oauth_candidate_cutover", "An invalid replacement cannot displace active and a valid candidate cuts over only after drain.", ("B04_replace_active_linear_app",), minimum_level="integration", real_boundaries=("browser", "linear", "podium", "conductor"), authoritative_oracles=("installation", "binding"), required_evidence=("candidate_generations", "drain", "config_ack", "cleanup"), trigger_tags=("installation", "cutover", "manual")),
    _scenario("linear_installation_reconnect", "Reauthorization restores one unhealthy installation without silently changing identity.", ("B05a_reconnect_linear_installation",), minimum_level="integration", real_boundaries=("browser", "linear", "podium"), authoritative_oracles=("installation",), required_evidence=("prior_reason", "reauthorization", "health", "cleanup"), trigger_tags=("installation", "manual")),
    _scenario("linear_installation_revoke", "Revocation retires one installation and disables its routing.", ("B05b_revoke_linear_installation",), minimum_level="integration", real_boundaries=("browser", "linear", "podium"), authoritative_oracles=("installation", "routing"), required_evidence=("revocation", "routing_state", "cleanup"), trigger_tags=("installation", "manual")),
    _scenario("project_deselection", "Deselecting a project removes Symphony scope without mutating Linear membership.", ("B06b_deselect_managed_project",), minimum_level="contract", real_boundaries=("browser", "linear", "podium"), authoritative_oracles=("topology",), required_evidence=("project_state", "membership_audit", "cleanup"), trigger_tags=("project_scope", "manual")),
    _scenario("delegated_issue_to_verified_delivery", "One delegated issue produces one exact verified repository delivery ref.", ("B13_delegated_issue_to_verified_delivery",), authoritative_oracles=("dispatch", "managed_run", "delivery", "repository"), required_evidence=("turns", "delivery_attempt", "delivery_record", "delivery_ref", "final_verification", "repository", "cleanup"), trigger_tags=("managed_delivery", "manual")),
    _scenario("managed_run_observability", "Active, blocked, failed, and done runs explain state, evidence, and next action.", ("B14_understand_managed_delivery",), real_boundaries=("linear", "podium"), required_evidence=("state_parity", "visible_reason", "next_action", "cleanup"), trigger_tags=("managed_runs", "observability", "manual")),
    _scenario("polling_restart_redelegation", "Restart resumes at the committed page without skips or duplicates, and redelegation opens one new epoch.", ("B13_delegated_issue_to_verified_delivery", "B14_understand_managed_delivery"), minimum_level="integration", real_boundaries=("linear", "podium"), authoritative_oracles=("polling", "dispatch"), required_evidence=("page_checkpoints", "normalized_observations", "delegation_epochs", "idempotency_keys", "dispatches", "cleanup"), trigger_tags=("polling", "manual")),
    _scenario("routing_guards", "Wrong organization, project, app user, blocker, capacity, or duplicate binding cannot route.", ("B08_bind_project_repository", "B15_resume_deferred_dispatch"), authoritative_oracles=("routing",), required_evidence=("eligibility_decisions", "skip_reasons", "cleanup"), trigger_tags=("routing", "manual")),
    _scenario("deferred_dispatch_recovery", "A temporary blocker or capacity release starts exactly one run after recovery.", ("B15_resume_deferred_dispatch",), real_boundaries=("linear", "podium"), authoritative_oracles=("routing", "managed_run"), required_evidence=("before_after_eligibility", "dispatch_run_mapping", "cleanup"), trigger_tags=("routing", "capacity", "manual")),
    _scenario("linear_dependency_ingestion", "A customer blocks relation appends a validated overlay and changes effective readiness.", ("B16_add_linear_dependency",), minimum_level="integration", real_boundaries=("linear",), authoritative_oracles=("plan", "dependency_overlay"), required_evidence=("plan_hash", "overlay_revisions", "effective_graph", "cleanup"), trigger_tags=("dependencies", "manual")),
    _scenario("plan_approval", "A plan resumes only through its recorded root approval state transition.", ("B17a_approve_managed_plan",), minimum_level="integration", real_boundaries=("linear",), authoritative_oracles=("managed_wait",), required_evidence=("wait_identity", "state_flip", "resume", "cleanup"), trigger_tags=("waits", "manual")),
    _scenario("work_item_approval", "Only the recorded gated work item becomes eligible after approval.", ("B17b_approve_work_item_gate",), minimum_level="integration", real_boundaries=("linear",), authoritative_oracles=("managed_wait", "readiness"), required_evidence=("gate_identity", "state_flip", "readiness", "cleanup"), trigger_tags=("waits", "manual")),
    _scenario("managed_information_wait", "Missing information resumes only the affected managed work after its state transition.", ("B18_supply_missing_business_input",), minimum_level="integration", real_boundaries=("linear",), authoritative_oracles=("managed_wait",), required_evidence=("reason", "instruction", "state_flip", "cleanup"), trigger_tags=("waits", "manual")),
    _scenario("runtime_wait", "Runtime approval or tool input resumes only through its Human Action issue.", ("B19_resolve_runtime_input_wait",), minimum_level="integration", real_boundaries=("linear", "conductor", "performer"), authoritative_oracles=("runtime_wait", "turn_lease"), required_evidence=("wait_identity", "human_action_issue", "resume", "cleanup"), trigger_tags=("waits", "runtime", "manual")),
    _scenario("attempt_retry_restart", "A crash or timeout uses a fresh TurnLease and rejects the stale result.", ("B13_delegated_issue_to_verified_delivery", "B14_understand_managed_delivery"), real_boundaries=("conductor", "performer"), authoritative_oracles=("managed_run", "turn_lease"), required_evidence=("old_new_turn_leases", "durable_cursor", "stale_rejection", "cleanup"), trigger_tags=("attempt", "recovery", "manual")),
    _scenario("verification_rework", "Independent verification failure preserves evidence and corrected work can pass.", ("B21_receive_verified_rework", "B14_understand_managed_delivery"), real_boundaries=("conductor",), authoritative_oracles=("verification", "managed_run"), required_evidence=("frozen_gate", "failed_evidence", "rework_history", "cleanup"), trigger_tags=("verification", "rework", "manual")),
    _scenario("plan_revision", "Approved scope or dependency change creates immutable plan v2 and preserves v1.", ("B20_approve_plan_revision", "B14_understand_managed_delivery"), real_boundaries=("linear",), authoritative_oracles=("plan", "managed_run"), required_evidence=("approval", "plan_versions", "projection_reconciliation", "cleanup"), trigger_tags=("planning", "revision", "manual")),
    _scenario("parallel_clean_join", "Compatible work overlaps and verified manifests join into the final candidate.", ("B13_delegated_issue_to_verified_delivery",), real_boundaries=("conductor", "performer"), authoritative_oracles=("managed_run", "delivery"), required_evidence=("overlap_windows", "manifests", "join_commit", "cleanup"), trigger_tags=("parallel", "delivery", "manual")),
    _scenario("integration_conflict_resolution", "A visible integration conflict resolves to an exact verified delivery ref.", ("B22_resolve_integration_conflict", "B14_understand_managed_delivery"), real_boundaries=("linear",), authoritative_oracles=("delivery",), required_evidence=("conflict", "resolver_result", "final_verification", "delivery_record", "cleanup"), trigger_tags=("delivery", "conflict", "manual")),
    _scenario("runtime_same_host_isolation", "A second project runtime cannot collide with the first.", ("B09_add_second_project_runtime",), minimum_level="live", real_boundaries=("podium", "conductor"), authoritative_oracles=("topology", "runtime"), required_evidence=("runtime_identity", "ports", "data_roots", "cleanup"), trigger_tags=("runtime_platform", "manual")),
    _scenario("runtime_rename", "Runtime rename preserves identity, health, and label parity.", ("B10a_rename_runtime",), minimum_level="live", real_boundaries=("podium", "conductor", "linear"), authoritative_oracles=("topology",), required_evidence=("prior_new_name", "runtime_identity", "linear_label", "cleanup"), trigger_tags=("runtime_platform", "manual")),
    _scenario("runtime_replacement", "Runtime replacement transfers ownership only after drain.", ("B10b_replace_runtime",), minimum_level="live", real_boundaries=("podium", "conductor", "linear"), authoritative_oracles=("topology", "routing"), required_evidence=("drain", "prior_new_runtime", "binding", "cleanup"), trigger_tags=("runtime_platform", "manual")),
    _scenario("runtime_unbind", "Runtime unbind drains and disables project routing.", ("B10c_unbind_runtime",), minimum_level="live", real_boundaries=("podium", "conductor", "linear"), authoritative_oracles=("topology", "routing"), required_evidence=("drain", "cleared_binding", "routing_state", "cleanup"), trigger_tags=("runtime_platform", "manual")),
    _scenario("runtime_rebind", "Runtime rebind creates one acknowledged routing-ready owner.", ("B10d_rebind_runtime",), minimum_level="live", real_boundaries=("podium", "conductor", "linear"), authoritative_oracles=("topology", "routing"), required_evidence=("reservation", "config_ack", "binding", "cleanup"), trigger_tags=("runtime_platform", "manual")),
    _scenario("runtime_update", "Runtime update reaches one healthy target version.", ("B11a_update_runtime",), minimum_level="live", real_boundaries=("podium", "conductor", "service_manager"), authoritative_oracles=("runtime_operation",), required_evidence=("target", "checksum", "restart", "health", "cleanup"), trigger_tags=("runtime_platform", "manual")),
    _scenario("runtime_rollback", "A failed runtime update restores the prior healthy version.", ("B11b_rollback_runtime",), minimum_level="live", real_boundaries=("podium", "conductor", "service_manager"), authoritative_oracles=("runtime_operation",), required_evidence=("failed_health", "prior_target", "restored_health", "cleanup"), trigger_tags=("runtime_platform", "manual")),
    _scenario("runtime_credential_rotation", "Credential rotation revokes old access and preserves scoped health.", ("B12a_rotate_runtime_credentials",), minimum_level="integration", real_boundaries=("podium", "conductor"), authoritative_oracles=("runtime_security",), required_evidence=("old_revocation", "new_health", "audit_event", "cleanup"), trigger_tags=("runtime_security", "manual")),
    _scenario("runtime_routing_suspension", "Routing suspension drains and prevents new dispatch.", ("B12b_suspend_runtime_routing",), minimum_level="integration", real_boundaries=("podium", "conductor"), authoritative_oracles=("routing",), required_evidence=("drain", "disabled_state", "no_new_lease", "cleanup"), trigger_tags=("routing", "manual")),
    _scenario("runtime_routing_resume", "Routing resumes only after repository and config health checks.", ("B12c_resume_runtime_routing",), minimum_level="integration", real_boundaries=("podium", "conductor"), authoritative_oracles=("routing",), required_evidence=("health_checks", "enabled_state", "eligible_lease", "cleanup"), trigger_tags=("routing", "manual")),
    _scenario("runtime_log_audit_access", "Runtime logs and audit evidence are scoped, sanitized, and actionable.", ("B12d_inspect_runtime_logs_and_audit",), minimum_level="integration", real_boundaries=("podium", "conductor"), authoritative_oracles=("runtime_audit",), required_evidence=("correlated_events", "leak_scan", "next_action", "cleanup"), trigger_tags=("observability", "security", "manual")),
)


JOURNEYS: tuple[JourneySpec, ...] = (
    JourneySpec(
        id=CANONICAL_JOURNEY_ID,
        proves="A new customer reaches one exact verified repository delivery and completed Managed Run.",
        business_scenarios=("B01a_register_workspace_account", "B01c_sign_out_workspace_session", "B02_authorize_default_linear_app", "B06a_select_managed_project", "B07_install_named_conductor", "B08_bind_project_repository", "B13_delegated_issue_to_verified_delivery", "B14_understand_managed_delivery"),
        preconditions=("clean_postgresql", "fresh_podium_account", "default_linear_app", "real_linear_project", "staged_codex_seed"),
        minimum_level="live",
        real_boundaries=("browser", "linear", "podium", "conductor", "performer", "codex", "repository"),
        authoritative_oracles=("installation", "binding", "polling", "dispatch", "managed_run", "delivery", "repository"),
        operator_oracles=("podium", "linear", "logs", "linear_customer_experience"),
        required_evidence=("installation", "runtime", "page_checkpoints", "normalized_observations", "delegation_epochs", "idempotency_keys", "dispatches", "turns", "delivery_attempt", "delivery_record", "delivery_ref", "final_verification", "repository", "linear_tree", "linear_experience_review", "cleanup"),
        cleanup=("resource_ledger", "credential_scrub", "cleanup_parity"),
        trigger_tags=("core_change", "major_change", "manual"),
    ),
)


def validate_catalog(
    businesses: tuple[BusinessScenarioSpec, ...],
    scenarios: tuple[AcceptanceScenarioSpec, ...],
    journeys: tuple[JourneySpec, ...],
) -> list[str]:
    errors = [error for business in businesses for error in _required_business_errors(business)]
    errors.extend(_duplicate_errors("business_scenario_id", (item.id for item in businesses)))
    entries: tuple[AcceptanceEntry, ...] = (*scenarios, *journeys)
    errors.extend(_duplicate_errors("acceptance_entry_id", (item.id for item in entries)))
    errors.extend(_duplicate_errors("acceptance_proves", (item.proves for item in entries)))
    errors.extend(error for entry in entries for error in _entry_errors(entry))

    business_ids = {item.id for item in businesses}
    covered: set[str] = set()
    for entry in entries:
        for business_id in entry.business_scenarios:
            if business_id in business_ids:
                covered.add(business_id)
            else:
                errors.append(f"unknown_business_scenario:{entry.id}:{business_id}")
    errors.extend(f"business_scenario_uncovered:{item.id}" for item in businesses if item.id not in covered)
    errors.extend(_dependency_errors(entries))
    errors.extend(_canonical_journey_errors(journeys))
    return sorted(set(errors))


def _duplicate_errors(kind: str, identifiers: Iterable[str]) -> list[str]:
    counts = Counter(identifiers)
    return [f"duplicate_{kind}:{identifier}" for identifier, count in counts.items() if count > 1]


def _required_business_errors(business: BusinessScenarioSpec) -> list[str]:
    required = {
        "id": business.id,
        "actor": business.actor,
        "customer_job": business.customer_job,
        "start_state": business.start_state,
        "accepted_outcome": business.accepted_outcome,
        "visible_artifacts": business.visible_artifacts,
    }
    identifier = business.id or "<missing>"
    return [f"business_scenario_field_required:{identifier}:{name}" for name, value in required.items() if not value]


def _entry_errors(entry: AcceptanceEntry) -> list[str]:
    required = {
        "id": entry.id,
        "proves": entry.proves,
        "business_scenarios": entry.business_scenarios,
        "minimum_level": entry.minimum_level,
        "authoritative_oracles": entry.authoritative_oracles,
        "operator_oracles": entry.operator_oracles,
        "required_evidence": entry.required_evidence,
        "cleanup": entry.cleanup,
        "trigger_tags": entry.trigger_tags,
    }
    identifier = entry.id or "<missing>"
    errors = [f"acceptance_entry_field_required:{identifier}:{name}" for name, value in required.items() if not value]
    if entry.minimum_level and entry.minimum_level not in ALLOWED_TEST_LEVELS:
        errors.append(f"acceptance_level_invalid:{identifier}:{entry.minimum_level}")
    if entry.minimum_level == "live" and not entry.real_boundaries:
        errors.append(f"live_boundary_required:{identifier}")
    if isinstance(entry, JourneySpec) and not entry.preconditions:
        errors.append(f"journey_preconditions_required:{identifier}")
    return errors


def _dependency_errors(entries: tuple[AcceptanceEntry, ...]) -> list[str]:
    dependencies = {entry.id: entry.depends_on for entry in entries}
    errors = [
        f"unknown_acceptance_dependency:{entry_id}:{dependency}"
        for entry_id, values in dependencies.items()
        for dependency in values
        if dependency not in dependencies
    ]
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(entry_id: str) -> None:
        if entry_id in visiting:
            errors.append(f"acceptance_dependency_cycle:{entry_id}")
            return
        if entry_id in visited:
            return
        visiting.add(entry_id)
        for dependency in dependencies.get(entry_id, ()):
            if dependency in dependencies:
                visit(dependency)
        visiting.remove(entry_id)
        visited.add(entry_id)

    for entry_id in dependencies:
        visit(entry_id)
    return errors


def _canonical_journey_errors(journeys: tuple[JourneySpec, ...]) -> list[str]:
    canonical = next((item for item in journeys if item.id == CANONICAL_JOURNEY_ID), None)
    if canonical is None:
        return ["canonical_journey_required"]

    errors: list[str] = []
    for boundary in ("browser", "linear", "podium", "conductor", "performer", "codex", "repository"):
        if boundary not in canonical.real_boundaries:
            errors.append(f"canonical_boundary_required:{boundary}")
    for authority in ("polling", "dispatch", "delivery", "repository"):
        if authority not in canonical.authoritative_oracles:
            errors.append(f"canonical_authority_required:{authority}")
    for evidence in ("page_checkpoints", "normalized_observations", "delegation_epochs", "idempotency_keys", "dispatches", "delivery_attempt", "delivery_record", "delivery_ref", "final_verification", "linear_experience_review", "cleanup"):
        if evidence not in canonical.required_evidence:
            errors.append(f"canonical_evidence_required:{evidence}")
    if "linear_customer_experience" not in canonical.operator_oracles:
        errors.append("canonical_operator_oracle_required:linear_customer_experience")
    for trigger in ("core_change", "major_change", "manual"):
        if trigger not in canonical.trigger_tags:
            errors.append(f"canonical_trigger_required:{trigger}")
    return errors
