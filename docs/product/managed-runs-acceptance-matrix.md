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
| Real E2E classifies external instability separately from product failures. | `real-run-testing-guide.md` | `test_real_codex_connectivity_probe_classifies_upstream_and_auth_failures` | covered |

## External E2E Boundary

Live E2E is still required for release evidence, but external instability is
classified separately from product behavior:

- `product_failure`: deterministic local or live product behavior failed;
- `environment_failure`: required local setup, credentials, or config is wrong;
- `external_service_unavailable`: Codex, Linear, or Podium dependencies are
  unavailable or rate limited;
- `credential_or_config_failure`: a live credential exists but is rejected.

The deterministic managed-run tests above must pass before a live E2E retry.
