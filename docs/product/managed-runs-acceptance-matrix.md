# Managed Runs Acceptance Matrix

This matrix turns product design statements into blocking tests. A requirement
is not complete until its test is green and the evidence is visible in durable
state, API/report output, and Linear projection when the design requires it.

| Requirement | Source | Blocking Test | Status |
|---|---|---|---|
| One delegated Linear issue maps to one durable managed run. | `linear-native-managed-runs.md` | `test_conductor_exposes_managed_run_api_without_pipeline_compatibility` | covered |
| Plan validation rejects broad, cyclic, unverifiable, or unsafe plans. | `linear-native-managed-runs.md` | `test_managed_run_plan_validator_rejects_invalid_work_items` | covered |
| `approval_required` records the plan and blocks execution until approval. | `linear-native-managed-runs.md` | `test_managed_run_driver_waits_for_plan_approval_before_work_item_turn` | covered |
| Work items execute only when dependency-ready. | `linear-native-managed-runs.md` | `test_managed_run_coordinator_advances_work_item_through_review_to_done` | covered |
| Parallel execution requires explicit safe parallelization policy. | `linear-native-managed-runs.md` | `test_managed_run_driver_starts_and_collects_parallel_work_items` | covered |
| Checkpoint failures block the managed run. | `linear-native-managed-runs.md` | `test_managed_run_coordinator_blocks_failed_checkpoint_after_group` | covered |
| Conductor reruns GREEN verification independently. | `gates-verification-integration.md` | `test_managed_run_driver_blocks_when_independent_green_command_fails` | covered |
| Final completion requires recorded Definition-of-Done rubric. | `linear-native-managed-runs.md` | `test_managed_run_projector_finalizes_verified_run_after_parent_summary` | covered |
| Projection health is durable and projected to the root summary. | `linear-projection.md` | `test_projection_sync_success_marks_managed_run_projection_healthy` | covered |
| Projection failures expose sanitized error state in API and durable payload. | `linear-projection.md` | `test_projection_sync_failure_is_visible_in_managed_run_state_and_api` | covered |
| Attempt comments use durable `attempt_id -> linear_comment_id` replay keys. | `linear-projection.md` | `test_managed_run_projector_projects_attempt_comment_by_durable_comment_id` | covered |
| Runtime waits use Managed Runs wait state, not legacy human-answer comments. | `linear-projection.md` | `test_runtime_human_answered_ignore_reason_uses_managed_run_language` | covered |
| Accepted work items freeze immutable gate snapshots with authoritative step provenance and canonical hashes. | `gates-verification-integration.md` | `test_gate_snapshot_is_frozen_hashed_and_requires_authoritative_step`; `test_managed_run_store_freezes_gate_snapshots_when_plan_is_saved` | covered |
| Terminal execute attempts record verification input snapshots and Conductor-published task output manifests. | `gates-verification-integration.md` | `test_verification_input_snapshot_and_task_manifest_roundtrip_with_score_threshold`; `test_managed_run_store_records_verification_inputs_and_publishes_manifests`; `test_managed_run_driver_runs_plan_work_item_and_verify` | covered |
| Dependent work items consume upstream output only through verified manifests. | `gates-verification-integration.md` | `test_managed_run_driver_starts_dependent_work_item_from_joined_verified_manifests` | covered |
| Verified parallel branches are joined deterministically before downstream execution. | `gates-verification-integration.md` | `test_managed_run_branch_join_merges_verified_manifest_branches`; `test_managed_run_driver_starts_dependent_work_item_from_joined_verified_manifests` | covered |
| Verified branch merge conflicts block the affected work item with visible action required. | `gates-verification-integration.md` | `test_managed_run_branch_join_blocks_on_conflicting_verified_branches`; `test_managed_run_driver_blocks_dependent_work_item_on_join_conflict` | covered |
| The local verifier creates a fresh disposable detached worktree, verifies artifact hashes before commands, and detects gate workspace mutation. | `gates-verification-integration.md` | `test_local_verifier_runs_gate_in_detached_disposable_worktree`; `test_local_verifier_blocks_artifact_hash_mismatch_before_running_gate`; `test_local_verifier_blocks_gate_workspace_mutation_without_touching_source_repo` | covered |
| Final release evidence includes gate hash, verification input, verifier command/evidence, score, manifest, join or conflict result, checkpoint evidence, and final rubric. | `gates-verification-integration.md` | `test_managed_run_view_exposes_complete_evidence_bundle` | covered |
| Linear child topology mirrors work-item dependencies as `blocks` relations with operator metadata. | `linear-projection.md` | `test_managed_run_projector_projects_dependency_blocks_and_operator_metadata` | covered |
| Real E2E classifies external instability separately from product failures. | `real-run-testing-guide.md` | `test_real_codex_connectivity_probe_classifies_upstream_and_auth_failures` | covered |

## Remaining Blocking Gaps

| Requirement | Source | Needed Blocking Test | Status |
|---|---|---|---|
| Plan revision approval mirrors unchanged, canceled, and new work-item issues with visible revision context. | `linear-projection.md` | Projection test for an approved revision containing kept, canceled, and added child issues plus refreshed `blocks`. | gap |
| Work-item blocked human action writes one durable instruction update and resumes only by blocked-state flip, not by free-text comments. | `linear-projection.md` | Store/projection/ingestion test for wait identity, instruction comment idempotency, ignored comment-only resume, and accepted state-flip resume. | gap |
| Linear dependency ingestion is union-only and never deletes local edges on lagging reads. | `linear-projection.md` | Topology ingestion test that adds human-created `blocks`, drops canceled edges, and commits nothing when unchanged. | gap |
| Attempt comment projection covers plan, execute, and verify attempts with stable durable `attempt_id -> linear_comment_id` mappings. | `linear-projection.md` | Projection test with multiple attempt kinds, replayed sync, and verify score/error updates. | gap |

## External E2E Boundary

Live E2E is still required for release evidence, but external instability is
classified separately from product behavior:

- `product_failure`: deterministic local or live product behavior failed;
- `environment_failure`: required local setup, credentials, or config is wrong;
- `external_service_unavailable`: Codex, Linear, or Podium dependencies are
  unavailable or rate limited;
- `credential_or_config_failure`: a live credential exists but is rejected.

The deterministic managed-run tests above must pass before a live E2E retry.
