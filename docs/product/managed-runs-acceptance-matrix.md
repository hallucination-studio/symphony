# Managed Runs Acceptance Matrix

This matrix turns product design statements into blocking tests. A requirement
is not complete until its test is green and the evidence is visible in durable
state, API/report output, and Linear projection when the design requires it.

| Requirement | Source | Blocking Test | Status |
|---|---|---|---|
| One delegated Linear issue maps to one durable managed run. | `linear-native-managed-runs.md` | `test_conductor_exposes_managed_run_api_without_pipeline_compatibility` | covered |
| Plan validation rejects broad, cyclic, unverifiable, or unsafe plans. | `linear-native-managed-runs.md` | `test_managed_run_plan_validator_rejects_invalid_work_items` | covered |
| Every Performer plan/work-item request and result carries matching fenced context; stale plan, policy, lease, token, or turn values are rejected before applying a result. | `runtime-pipeline.md`; `pipeline-state.md` | `test_managed_run_turn_context_requires_and_compares_fencing_fields`; `test_performer_echoes_validated_fenced_turn_context`; `test_performer_rejects_missing_fenced_turn_context`; `test_managed_run_driver_carries_and_rejects_fenced_turn_context` | covered |
| `approval_required` records the plan and blocks execution until approval. | `linear-native-managed-runs.md` | `test_managed_run_driver_waits_for_plan_approval_before_work_item_turn` | covered |
| Work items execute only when dependency-ready. | `linear-native-managed-runs.md` | `test_managed_run_coordinator_advances_work_item_through_review_to_done` | covered |
| Parallel execution requires explicit safe parallelization policy. | `linear-native-managed-runs.md` | `test_managed_run_driver_starts_and_collects_parallel_work_items` | covered |
| Checkpoint failures block the managed run. | `linear-native-managed-runs.md` | `test_managed_run_coordinator_blocks_failed_checkpoint_after_group` | covered |
| Conductor reruns GREEN verification independently. | `gates-verification-integration.md` | `test_managed_run_driver_blocks_when_independent_green_command_fails` | covered |
| Final completion requires recorded Definition-of-Done rubric. | `linear-native-managed-runs.md` | `test_managed_run_projector_finalizes_verified_run_after_parent_summary` | covered |
| Projection health is durable and projected to the root summary. | `linear-projection.md` | `test_projection_sync_success_marks_managed_run_projection_healthy` | covered |
| Projection failures expose sanitized error state in API and durable payload. | `linear-projection.md` | `test_projection_sync_failure_is_visible_in_managed_run_state_and_api` | covered |
| Attempt comments use durable `attempt_id -> linear_comment_id` replay keys. | `linear-projection.md` | `test_managed_run_projector_projects_attempt_comment_by_durable_comment_id` | covered |
| Attempt comment projection covers plan, execute, and verify attempts with stable durable mappings. | `linear-projection.md` | `test_managed_run_projector_projects_plan_execute_and_verify_attempt_comments` | covered |
| Runtime waits use Managed Runs wait state, not legacy human-answer comments. | `linear-projection.md` | `test_runtime_human_answered_ignore_reason_uses_managed_run_language` | covered |
| Accepted work items freeze immutable gate snapshots with authoritative step provenance and canonical hashes. | `gates-verification-integration.md` | `test_gate_snapshot_is_frozen_hashed_and_requires_authoritative_step`; `test_managed_run_store_freezes_gate_snapshots_when_plan_is_saved` | covered |
| Terminal execute attempts record verification input snapshots and Conductor-published task output manifests. | `gates-verification-integration.md` | `test_verification_input_snapshot_and_task_manifest_roundtrip_with_score_threshold`; `test_managed_run_store_records_verification_inputs_and_publishes_manifests`; `test_managed_run_driver_runs_plan_work_item_and_verify` | covered |
| Dependent work items consume upstream output only through verified manifests. | `gates-verification-integration.md` | `test_managed_run_driver_starts_dependent_work_item_from_joined_verified_manifests` | covered |
| Verified parallel branches are joined deterministically before downstream execution. | `gates-verification-integration.md` | `test_managed_run_branch_join_merges_verified_manifest_branches`; `test_managed_run_driver_starts_dependent_work_item_from_joined_verified_manifests` | covered |
| Verified branch merge conflicts block the affected work item with visible action required. | `gates-verification-integration.md` | `test_managed_run_branch_join_blocks_on_conflicting_verified_branches`; `test_managed_run_driver_blocks_dependent_work_item_on_join_conflict` | covered |
| The local verifier creates a fresh disposable detached worktree, verifies artifact hashes before commands, and detects gate workspace mutation. | `gates-verification-integration.md` | `test_local_verifier_runs_gate_in_detached_disposable_worktree`; `test_local_verifier_blocks_artifact_hash_mismatch_before_running_gate`; `test_local_verifier_blocks_gate_workspace_mutation_without_touching_source_repo` | covered |
| Final release evidence includes gate hash, verification input, verifier command/evidence, score, manifest, join or conflict result, checkpoint evidence, and final rubric. | `gates-verification-integration.md` | `test_managed_run_view_exposes_complete_evidence_bundle` | covered |
| Linear child topology mirrors work-item dependencies as `blocks` relations; projection metadata exposes stable plan, work-item, verification, and runtime-wait identifiers with operator state. | `linear-projection.md` | `test_managed_run_projector_projects_dependency_blocks_and_operator_metadata` | covered |
| A Linear state flip approves an isolated revision-planning turn, which alone may commit an immutable new plan version; unchanged child issues update in place, removed children cancel, new children create, `blocks` refresh, and revision context remains visible. | `linear-projection.md`; `linear-native-managed-runs.md` | `test_plan_revision_state_flip_starts_isolated_revision_planning`; `test_managed_run_driver_applies_approved_plan_revision_from_isolated_plan_turn`; `test_managed_run_driver_blocks_invalid_revision_plan_and_allows_another_approved_revision_turn`; `test_managed_run_projector_projects_approved_plan_revision_shape` | covered |
| Plan approval and blocked work items write one durable instruction update, require an observed blocked-state flip to resume, and never accept free-text comments as commands. | `linear-projection.md` | `test_managed_run_human_action_instruction_is_idempotent_and_state_flip_resumes`; `test_managed_run_plan_approval_projects_root_instruction_and_ingests_state_flip`; `test_managed_run_generic_blocked_work_item_projects_instruction_and_reopens_only_on_state_flip` | covered |
| A run-level block can retry only after a parent state flip; an invalid revision candidate remains blocked until another approved revision-planning turn supplies a valid immutable plan. | `linear-projection.md`; `pipeline-state.md` | `test_managed_run_generic_parent_block_retries_only_after_root_state_flip`; `test_managed_run_driver_blocks_invalid_revision_plan_and_allows_another_approved_revision_turn` | covered |
| Linear dependency ingestion is union-only and never deletes local edges on lagging reads. | `linear-projection.md` | `test_linear_dependency_ingestion_is_union_only_and_drops_canceled_edges`; `test_linear_dependency_ingestion_rejects_cycles_without_committing` | covered |
| Real E2E classifies external instability separately from product failures; bootstrap configuration failures, Linear 401/403, and app-user scope rejection fail immediately with a non-retryable classification and concrete recovery action. | `real-run-testing-guide.md` | `test_real_codex_connectivity_probe_classifies_upstream_and_auth_failures`; `test_real_symphony_e2e_missing_linear_token_is_configuration_failure`; `test_real_symphony_e2e_records_bootstrap_failure`; `test_real_symphony_e2e_linear_auth_failure_is_immediate_and_classified`; `test_real_symphony_e2e_linear_app_user_scope_failure_is_immediate_and_classified`; `test_real_symphony_e2e_records_external_failure_classification` | covered |
| Per-run Codex credential staging stays outside the E2E evidence root; staging and per-role runtime-home credential copies are removed after logs are archived and processes stop. | `real-run-testing-guide.md`; `AGENT.md` | `test_real_symphony_e2e_stages_codex_home_outside_evidence_root`; `test_real_symphony_e2e_scrubs_only_runtime_home_credentials`; `test_real_symphony_e2e_archives_before_process_cleanup_after_unhandled_exception`; `test_real_symphony_e2e_scrubs_runtime_credentials_when_process_cleanup_fails` | covered |

## External E2E Boundary

Live E2E is still required for release evidence, but external instability is
classified separately from product behavior:

- `product_failure`: deterministic local or live product behavior failed;
- `environment_failure`: required local setup, credentials, or config is wrong;
- `external_service_unavailable`: Codex, Linear, or Podium dependencies are
  unavailable or rate limited;
- `credential_or_config_failure`: a live credential exists but is rejected.

The deterministic managed-run tests above must pass before a live E2E retry.
