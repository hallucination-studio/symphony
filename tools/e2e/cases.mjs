import { createHash } from "node:crypto";

export const FOREGROUND_E2E_CASE_IDS = Object.freeze([
  "approved_happy_path",
  "plan_rejected_and_replanned",
  "information_requested_and_answered",
  "root_revision_and_comment",
  "parallel_multi_conductor",
  "same_conductor_preemption",
  "conductor_restart_recovery",
]);

export const FOREGROUND_E2E_COMMON_ASSERTION_IDS = Object.freeze([
  "case_scope_isolated",
  "requirement_input_preserved",
  "durable_facts_correlated",
  "final_evidence_complete",
  "no_e2e_control_facts",
]);

const COMMON_ASSERTIONS = Object.freeze([
  ["case_scope_isolated", "required", "equals", ["case_topology", "repositories", "routing", "ownership"], ["case_id", "root_ids", "repository_ids", "conductor_ids"]],
  ["requirement_input_preserved", "required", "equals", ["root_descriptions", "user_inputs", "native_activity"], ["case_id", "root_ids", "input_hashes", "comment_ids"]],
  ["durable_facts_correlated", "required", "linked", ["issues", "comments", "reactions", "managed_records", "stage_results", "usage", "delivery", "git"], ["root_ids", "cycle_ids", "stage_ids", "remote_versions", "git_revisions"]],
  ["final_evidence_complete", "required", "aggregate", ["active_tree", "archived_tree", "status_catalog", "relations", "comments", "activity", "managed_records", "git"], ["root_ids", "pagination_coverage", "repository_ids"]],
  ["no_e2e_control_facts", "prohibited", "equals", ["human_actions", "managed_records", "dag", "timeline", "usage", "completion"], ["root_ids", "writer_actor_ids"]],
]);

export const FOREGROUND_E2E_CASES = deepFreeze([
  caseDefinition({
    caseId: "approved_happy_path",
    roots: [root({
      rootKey: "approved-root",
      conductorRef: "conductor-a",
      repositoryRef: "approved-repository",
      title: "Add a focused text normalization helper",
      description: "Implement a small text normalization helper in the dedicated test repository and cover its supported input with focused tests.",
      acceptanceCriteria: [
        "The helper has focused tests for its supported input.",
        "The repository checks pass.",
        "The completed change is ready for review.",
      ],
    })],
    interactions: [
      waitForAction("approved-root", "plan_review"),
      terminalAction("approved-root", "Approved"),
    ],
    verificationBoundary: "in_review_delivery",
    assertions: [
      assertion("plan_approval_precedes_work", "required", "ordered", ["plan_review", "work"], ["root_id", "plan_contract_id", "approval_resolution_id"]),
      assertion("stage_chain_delivered", "required", "linked", ["plan", "work", "verify", "delivery", "git"], ["root_id", "cycle_id", "stage_execution_ids", "git_revision"]),
      assertion("turn_usage_aggregated", "required", "aggregate", ["stage_usage", "cycle_usage", "root_usage"], ["root_id", "cycle_ids", "turn_ids"]),
      assertion("boundary_in_review_delivery", "boundary", "linked", ["root_status", "verify_result", "delivery", "git"], ["root_id", "verify_result_id", "delivery_id", "git_revision"]),
      assertion("work_before_approval", "prohibited", "ordered", ["plan_review", "work"], ["root_id", "plan_contract_id", "approval_resolution_id"]),
      assertion("duplicate_or_synthetic_completion", "prohibited", "unique", ["completion", "managed_records", "timeline"], ["root_id", "stage_execution_ids", "writer_actor_ids"]),
      assertion("usage_missing_or_double_counted", "prohibited", "aggregate", ["stage_usage", "cycle_usage", "root_usage"], ["root_id", "cycle_ids", "turn_ids"]),
    ],
  }),
  caseDefinition({
    caseId: "plan_rejected_and_replanned",
    roots: [root({
      rootKey: "rejected-plan-root",
      conductorRef: "conductor-b",
      repositoryRef: "rejected-plan-repository",
      title: "Add a small reversible identifier utility",
      description: "Implement a small utility that reverses a short identifier and cover the supported behavior with focused tests.",
      acceptanceCriteria: [
        "The initial Plan is available for review.",
        "A rejected Plan produces a fresh replacement Plan rather than in-place mutation.",
      ],
    })],
    interactions: [
      waitForAction("rejected-plan-root", "plan_review"),
      comment("rejected-plan-root", "The plan should preserve the existing utility contract before adding the new behavior."),
      terminalAction("rejected-plan-root", "Rejected"),
    ],
    verificationBoundary: "fresh_plan_review",
    assertions: [
      assertion("rejection_consumed_and_replied", "required", "linked", ["human_action", "comments", "reconciler_reply"], ["root_id", "action_id", "source_comment_id", "reply_id"]),
      assertion("rejected_lineage_retained", "required", "archived", ["plan_contract", "plan_result", "human_action", "stage_execution"], ["root_id", "old_contract_id", "old_execution_id", "old_action_id"]),
      assertion("rejected_contract_superseded", "required", "linked", ["plan_contract", "archive", "plan_execution", "human_action"], ["root_id", "old_contract_id", "new_contract_id", "new_execution_id", "new_action_id"]),
      assertion("boundary_fresh_plan_review", "boundary", "linked", ["plan_contract", "plan_execution", "human_action"], ["root_id", "new_contract_id", "new_execution_id", "new_action_id"]),
      assertion("work_against_rejected_contract", "prohibited", "linked", ["work", "plan_contract", "human_resolution"], ["root_id", "old_contract_id", "work_execution_ids"]),
      assertion("contract_overwritten_or_history_deleted", "prohibited", "archived", ["plan_contract", "plan_result", "human_action"], ["root_id", "old_contract_id", "old_execution_id", "old_action_id"]),
      assertion("test_created_replacement", "prohibited", "equals", ["plan_contract", "human_action", "writer_actor"], ["root_id", "new_contract_id", "new_action_id", "writer_actor_ids"]),
    ],
  }),
  caseDefinition({
    caseId: "information_requested_and_answered",
    roots: [root({
      rootKey: "information-root",
      conductorRef: "conductor-c",
      repositoryRef: "information-repository",
      title: "Format an identifier after obtaining the required separator",
      description: "Add an identifier formatter. The separator is intentionally unspecified and must be requested before a Plan is finalized.",
      acceptanceCriteria: [
        "The missing separator is requested through a Human Action.",
        "The answer leads to a fresh Plan that records the selected separator.",
      ],
    })],
    interactions: [
      waitForAction("information-root", "clarification"),
      comment("information-root", "Use a colon as the identifier separator."),
      terminalAction("information-root", "Answered"),
    ],
    verificationBoundary: "fresh_plan_review",
    assertions: [
      assertion("information_action_actionable", "required", "linked", ["human_action", "action_description"], ["root_id", "action_id", "action_kind"]),
      assertion("answer_consumed_and_receipted", "required", "linked", ["human_action", "comments", "reconciler_reply", "reaction"], ["root_id", "action_id", "source_comment_id", "reply_id"]),
      assertion("answer_drives_fresh_plan", "required", "linked", ["human_resolution", "plan_execution", "plan_contract", "human_action"], ["root_id", "action_id", "answer_comment_id", "new_execution_id", "new_contract_id"]),
      assertion("boundary_fresh_plan_review", "boundary", "linked", ["plan_execution", "plan_contract", "human_action"], ["root_id", "new_execution_id", "new_contract_id", "new_action_id"]),
      assertion("missing_answer_assumed", "prohibited", "equals", ["human_action", "plan_contract", "comments"], ["root_id", "action_id", "plan_contract_id"]),
      assertion("test_unblocks_or_mutates_stage", "prohibited", "equals", ["plan", "work", "verify", "managed_records"], ["root_id", "writer_actor_ids"]),
    ],
  }),
  caseDefinition({
    caseId: "root_revision_and_comment",
    roots: [root({
      rootKey: "revision-root",
      conductorRef: "conductor-c",
      repositoryRef: "revision-repository",
      title: "Add an uppercase identifier helper",
      description: "Implement an uppercase identifier helper with focused tests.",
      acceptanceCriteria: [
        "The initial requirement is planned before the revision.",
        "The revised requirement starts a successor Cycle with a fresh Plan review.",
      ],
    })],
    interactions: [
      { kind: "update_root_description", rootKey: "revision-root", description: "Replace the uppercase helper with a lowercase identifier helper and focused tests." },
      { kind: "create_comment", rootKey: "revision-root", body: "The original helper name no longer matches the requirement." },
      { kind: "edit_comment", rootKey: "revision-root", body: "The original helper name no longer matches the revised requirement." },
      { kind: "resolve_comment_thread", rootKey: "revision-root" },
      { kind: "reopen_comment_thread", rootKey: "revision-root" },
    ],
    verificationBoundary: "successor_plan_review",
    assertions: [
      assertion("ordinary_inputs_consumed_once", "required", "unique", ["root_description", "comments", "reconciler_inputs", "replies", "reactions"], ["root_id", "input_ids", "reply_ids"]),
      assertion("thread_transitions_receipted", "required", "thread-state", ["comments", "thread_state", "replies", "reactions"], ["root_id", "thread_root_comment_id", "reply_ids"]),
      assertion("revision_supersedes_cycle", "required", "archived", ["cycle", "plan_execution", "plan_contract", "human_action"], ["root_id", "old_cycle_id", "new_cycle_id", "new_execution_id", "new_contract_id"]),
      assertion("boundary_successor_plan_review", "boundary", "linked", ["cycle", "plan_execution", "plan_contract", "human_action"], ["root_id", "new_cycle_id", "new_execution_id", "new_contract_id", "new_action_id"]),
      assertion("system_comment_treated_as_input", "prohibited", "equals", ["comments", "reconciler_inputs"], ["root_id", "system_comment_ids", "input_ids"]),
      assertion("thread_history_lost", "prohibited", "thread-state", ["comments", "thread_state", "activity"], ["root_id", "thread_root_comment_id", "comment_versions"]),
      assertion("undeclared_revision_or_conductor_interpretation", "prohibited", "equals", ["root_description", "comments", "reconciler_inputs"], ["root_id", "declared_input_hashes", "input_ids"]),
    ],
  }),
  caseDefinition({
    caseId: "parallel_multi_conductor",
    roots: [
      root({
        rootKey: "parallel-a-root",
        conductorRef: "conductor-a",
        repositoryRef: "parallel-a-repository",
        title: "Add a prefix helper",
        description: "Implement a small prefix helper with focused tests.",
        acceptanceCriteria: ["The helper is delivered with a passing Verify result."],
      }),
      root({
        rootKey: "parallel-b-root",
        conductorRef: "conductor-b",
        repositoryRef: "parallel-b-repository",
        title: "Add a suffix helper",
        description: "Implement a small suffix helper with focused tests.",
        acceptanceCriteria: ["The helper is delivered with a passing Verify result."],
      }),
    ],
    interactions: [
      waitForAction("parallel-a-root", "plan_review"),
      terminalAction("parallel-a-root", "Approved"),
      waitForAction("parallel-b-root", "plan_review"),
      terminalAction("parallel-b-root", "Approved"),
    ],
    verificationBoundary: "all_roots_delivered",
    assertions: [
      assertion("root_ownership_and_workspace_isolated", "required", "unique", ["root_ownership", "routing", "workspaces", "repositories"], ["root_ids", "conductor_ids", "repository_ids"]),
      assertion("independent_delivery_chains", "required", "linked", ["plan", "work", "verify", "delivery", "git"], ["root_ids", "cycle_ids", "stage_execution_ids", "git_revisions"]),
      assertion("cross_conductor_stage_overlap", "required", "interval-overlap", ["stage_executions", "stage_results"], ["root_ids", "conductor_ids", "execution_ids"]),
      assertion("boundary_all_roots_delivered", "boundary", "aggregate", ["root_status", "verify_results", "deliveries", "git"], ["root_ids", "verify_result_ids", "delivery_ids", "git_revisions"]),
      assertion("cross_conductor_takeover", "prohibited", "equals", ["root_ownership", "routing", "activity"], ["root_ids", "conductor_ids"]),
      assertion("shared_workspace_writer", "prohibited", "unique", ["workspaces", "stage_executions"], ["root_ids", "workspace_ids", "execution_ids"]),
      assertion("telemetry_substitutes_overlap", "prohibited", "equals", ["stage_executions", "stage_results", "telemetry"], ["root_ids", "execution_ids"]),
    ],
  }),
  caseDefinition({
    caseId: "same_conductor_preemption",
    roots: [
      root({
        rootKey: "inflight-root",
        conductorRef: "conductor-a",
        repositoryRef: "preemption-inflight-repository",
        title: "Add an in-flight marker helper",
        description: "Implement a small marker helper with focused tests.",
        acceptanceCriteria: ["The helper is delivered with a passing Verify result."],
      }),
      root({
        rootKey: "touched-root",
        conductorRef: "conductor-a",
        repositoryRef: "preemption-touched-repository",
        title: "Add a touched marker helper",
        description: "Implement a small marker helper with focused tests.",
        acceptanceCriteria: ["The helper is delivered with a passing Verify result."],
      }),
      root({
        rootKey: "remaining-root",
        conductorRef: "conductor-a",
        repositoryRef: "preemption-remaining-repository",
        title: "Add a remaining marker helper",
        description: "Implement a small marker helper with focused tests.",
        acceptanceCriteria: ["The helper is delivered with a passing Verify result."],
      }),
    ],
    interactions: [
      { kind: "wait_for_stage_inflight", rootKey: "inflight-root" },
      { kind: "update_root_description", rootKey: "touched-root", description: "Implement a small marker helper with focused tests. Scheduling note: this request remains semantically unchanged." },
    ],
    verificationBoundary: "all_roots_delivered",
    assertions: [
      assertion("inflight_stage_completes", "required", "ordered", ["stage_executions", "stage_results"], ["root_id", "inflight_execution_id"]),
      assertion("latest_ready_root_runs_next", "required", "ordered", ["activity", "root_updated_at", "stage_executions"], ["root_ids", "conductor_id", "touched_root_id", "execution_ids"]),
      assertion("remaining_ready_root_progresses", "required", "ordered", ["stage_executions", "stage_results"], ["root_ids", "conductor_id", "execution_ids"]),
      assertion("boundary_all_roots_delivered", "boundary", "aggregate", ["root_status", "verify_results", "deliveries", "git"], ["root_ids", "verify_result_ids", "delivery_ids", "git_revisions"]),
      assertion("inflight_turn_interrupted", "prohibited", "equals", ["stage_executions", "stage_results"], ["root_id", "inflight_execution_id"]),
      assertion("test_selects_next_root", "prohibited", "equals", ["scheduler", "activity", "stage_executions"], ["root_ids", "conductor_id", "execution_ids"]),
      assertion("semantic_requirement_touch", "prohibited", "equals", ["root_description", "activity"], ["root_id", "requirement_hash", "activity_id"]),
    ],
  }),
  caseDefinition({
    caseId: "conductor_restart_recovery",
    roots: [
      root({
        rootKey: "affected-root",
        conductorRef: "conductor-a",
        repositoryRef: "recovery-affected-repository",
        title: "Add a recovery marker helper",
        description: "Implement a small marker helper with focused tests.",
        acceptanceCriteria: ["The helper is delivered after a Conductor restart."],
      }),
      root({
        rootKey: "continuous-root",
        conductorRef: "conductor-b",
        repositoryRef: "recovery-continuous-repository",
        title: "Add a continuous marker helper",
        description: "Implement a small marker helper with focused tests.",
        acceptanceCriteria: ["The helper remains continuously deliverable while another Conductor restarts."],
      }),
    ],
    interactions: [
      { kind: "wait_for_stage_inflight", rootKey: "affected-root" },
      waitForAction("affected-root", "plan_review"),
      terminalAction("affected-root", "Approved"),
      waitForAction("continuous-root", "plan_review"),
      terminalAction("continuous-root", "Approved"),
    ],
    processFaults: ["kill_and_restart_owning_conductor"],
    verificationBoundary: "recovered_and_continuous_delivered",
    assertions: [
      assertion("old_execution_terminal_once", "required", "unique", ["stage_execution", "stage_result"], ["affected_root_id", "old_execution_id"]),
      assertion("recovery_uses_fresh_execution", "required", "linked", ["stage_execution", "stage_result", "delivery"], ["affected_root_id", "old_execution_id", "new_execution_id", "role_session_ids"]),
      assertion("ownership_persists", "required", "equals", ["root_ownership", "routing", "activity"], ["affected_root_id", "conductor_id"]),
      assertion("unaffected_root_continues", "required", "linked", ["stage_execution", "stage_result", "delivery"], ["continuous_root_id", "continuous_conductor_id", "execution_ids"]),
      assertion("boundary_recovered_and_continuous_delivered", "boundary", "aggregate", ["root_status", "verify_results", "deliveries", "git"], ["affected_root_id", "continuous_root_id", "delivery_ids", "git_revisions"]),
      assertion("late_old_session_success", "prohibited", "unique", ["stage_execution", "stage_result", "delivery"], ["affected_root_id", "old_execution_id", "old_role_session_id"]),
      assertion("checkpoint_or_linear_rewrite", "prohibited", "equals", ["checkpoint", "linear_activity", "workflow_facts"], ["affected_root_id", "writer_actor_ids"]),
      assertion("unaffected_conductor_reconfigured", "prohibited", "equals", ["root_ownership", "conductor_configuration", "activity"], ["continuous_root_id", "continuous_conductor_id"]),
    ],
  }),
]);

function caseDefinition({ caseId, roots, interactions, processFaults = [], verificationBoundary, assertions }) {
  return {
    caseId,
    rootTopology: roots.map(({ rootKey, conductorRef, repositoryRef }) => ({
      rootKey,
      conductorRef,
      repositoryRef,
      routing: "conductor_ref",
      worktree: "root_dedicated",
    })),
    initialRequirements: roots.map(({ rootKey, title, description, acceptanceCriteria }) => requirement({
      rootKey,
      title,
      description,
      acceptanceCriteria,
    })),
    rootCreationInputs: roots.map(({ rootKey, conductorRef, title, description, acceptanceCriteria }) => ({
      rootKey,
      title,
      description: rootCreationDescription(description, acceptanceCriteria),
      priority: "high",
      conductorRef,
    })),
    declaredUserInteractions: interactions,
    allowedProcessFaults: processFaults,
    verificationBoundary,
    assertions: [...COMMON_ASSERTIONS.map(([assertionId, kind, predicate, factScope, correlation]) =>
      assertion(assertionId, kind, predicate, factScope, correlation)), ...assertions].map((record) => ({
      ...record,
      reasonCode: `e2e.${caseId}.${record.assertionId}`,
    })),
  };
}

function root({ rootKey, conductorRef, repositoryRef, title, description, acceptanceCriteria }) {
  return { rootKey, conductorRef, repositoryRef, title, description, acceptanceCriteria };
}

function requirement({ rootKey, title, description, acceptanceCriteria }) {
  const immutable = { rootKey, title, description, acceptanceCriteria };
  return { ...immutable, hash: createHash("sha256").update(JSON.stringify(immutable)).digest("hex") };
}

function rootCreationDescription(description, acceptanceCriteria) {
  return `${description}\n\n## Acceptance Criteria\n${acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`;
}

function waitForAction(rootKey, actionKind) {
  return { kind: "wait_for_human_action", rootKey, actionKind };
}

function terminalAction(rootKey, terminalStatus) {
  return { kind: "set_human_action_status", rootKey, terminalStatus };
}

function comment(rootKey, body) {
  return { kind: "create_comment", rootKey, body };
}

function assertion(assertionId, kind, predicate, factScope, correlation) {
  return { assertionId, kind, factScope, correlation, predicate };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
