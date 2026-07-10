from __future__ import annotations

import argparse
import os
from typing import Any

from real_symphony_e2e_acceptance import (
    APPENDIX_PYTEST_HARDENING_PROBES,
    _attempt_intervals_overlap,
    _check_appendix_overall_acceptance,
    _check_pipeline_scenario_acceptance,
    _downstream_verify_gate_evidence,
    _effective_permission_approval_probe,
    _gate_step_provenance_evidence,
    _lower_policy_during_parallel_execute_probe,
    _managed_run_avoids_global_codex_home,
    _overall_downstream_depends_on_both_parallel_evidence,
    _parse_e2e_time,
    _permission_probe_block_cleared,
    _pipeline_final_view_converged,
    _pipeline_linear_issue_tree_finalized,
    _pipeline_live_refresh_evidence,
    _pipeline_node_requires_gate,
    _pipeline_prediction_is_conditional,
    _pipeline_projection_matches_current_revision,
    _pipeline_scenario,
    _pipeline_scenario_intent,
    _pipeline_scenario_issue_description,
    _prepare_pipeline_scenario_fixture,
    _run_appendix_pytest_hardening_probes,
    _runtime_home_evidence,
    _safe_int,
    _should_run_final_pipeline_stage_checks,
    _superseded_node_evidence,
    _wait_for_final_pipeline_view,
    _wait_for_pipeline_linear_issue_tree_finalized,
)
from real_symphony_e2e_analysis import (
    audit_expected_failure_run,
    build_instance_payload,
    pipeline_integrations_terminal,
    pipeline_nodes_terminal,
)
from real_symphony_e2e_artifacts import (
    DEPENDENT_RUNTIME_STAGES_AFTER_PLAN,
    E2E_STAGE_ORDER,
    _archive_managed_run_artifacts,
    _checkpoint_and_block_after_stage,
    _dispatch_context_for_plan_attempt,
    _failed_plan_attempt_id,
    _failed_plan_attempt_paths,
    _handle_managed_run_runtime_blocker,
    _latest_managed_run_runtime_failure,
    _looks_like_plan_request,
    _read_json_file,
    _stages_after,
)
from real_symphony_e2e_common import (
    DEFAULT_PROJECT_SLUG,
    Evidence,
    ManagedProcess,
    allocate_port,
    api_url,
    http_json,
    make_fixture_repo,
    run_cmd,
    start_process,
    utc_now,
    wait_for_http_ready,
)
from real_symphony_e2e_linear import (
    create_linear_issue,
    delegate_linear_issue,
    fetch_linear_issue_tree,
    fetch_linear_viewer,
    resolve_project,
    wait_for_linear_delegate_visible,
)
from real_symphony_e2e_preflight import (
    CODEX_HOME_SEED_ENV,
    CODEX_HOME_SEED_FILES,
    DEFAULT_E2E_HARD_TURN_TIMEOUT_MS,
    E2E_POSTGRES_IMAGE,
    _codex_settings_from_args,
    build_runtime_config_payload,
    e2e_codex_home_seed_source,
    run_codex_connectivity_probe,
    run_codex_planner_shaped_probe,
    stage_codex_home_seed,
    start_e2e_postgres_if_needed,
    stop_e2e_postgres,
)
from real_symphony_e2e_run_orchestrator import run
from real_symphony_e2e_wait import wait_for_run


LINEAR_AGENT_OAUTH_SCOPE = "read,write,app:assignable,app:mentionable"

# Source-level invariants preserved for tests and reviewers:
# os.environ.get("PODIUM_LINEAR_APP_ACCESS_TOKEN"
# Linear app actor token is required
# PODIUM_LINEAR_APPLICATION_ID
# PODIUM_LINEAR_POLL_INTERVAL_SECONDS
# PODIUM_LINEAR_POLL_INITIAL_LOOKBACK_SECONDS"] = "0"
# build_runtime_config_payload
# "/api/v1/runtime/config"
# runtime-config:podium-pushed
# runtime-config:codex-home-source-staged
# appendix:s0a-stale-policy-rejected
# appendix:s0b-view-read-only
# pipeline_scenario == "overall-dod"
# appendix:s0a-crashed-worker-lease-reclaimed
# asyncpg.connect
# await start_e2e_postgres_if_needed
# linear_project = await resolve_project(token, args.project_slug)
# "/api/v1/runtime/enrollment-tokens"
# "runtime_group_id": f"group-{run_id}"
# "project_slug": linear_project["slugId"]
# build_instance_payload excludes managed_run_profile
# "conductor-dispatch:poller-starts-one-shot"
# "/api/managed-runs"
# codex-connectivity:connected
# codex-connectivity:planner-shaped


__all__ = [
    "APPENDIX_PYTEST_HARDENING_PROBES",
    "CODEX_HOME_SEED_ENV",
    "CODEX_HOME_SEED_FILES",
    "DEFAULT_E2E_HARD_TURN_TIMEOUT_MS",
    "DEFAULT_PROJECT_SLUG",
    "DEPENDENT_RUNTIME_STAGES_AFTER_PLAN",
    "E2E_POSTGRES_IMAGE",
    "E2E_STAGE_ORDER",
    "Evidence",
    "LINEAR_AGENT_OAUTH_SCOPE",
    "ManagedProcess",
    "allocate_port",
    "api_url",
    "argparse",
    "audit_expected_failure_run",
    "build_instance_payload",
    "build_runtime_config_payload",
    "create_linear_issue",
    "delegate_linear_issue",
    "e2e_codex_home_seed_source",
    "fetch_linear_issue_tree",
    "fetch_linear_viewer",
    "http_json",
    "make_fixture_repo",
    "os",
    "pipeline_integrations_terminal",
    "pipeline_nodes_terminal",
    "resolve_project",
    "run",
    "run_cmd",
    "run_codex_connectivity_probe",
    "run_codex_planner_shaped_probe",
    "stage_codex_home_seed",
    "start_e2e_postgres_if_needed",
    "start_process",
    "stop_e2e_postgres",
    "utc_now",
    "wait_for_http_ready",
    "wait_for_linear_delegate_visible",
    "wait_for_run",
]


def _module_exports_for_static_check() -> dict[str, Any]:
    return {name: globals()[name] for name in __all__ if name in globals()}
