import { createHash } from "node:crypto";

export const FOREGROUND_E2E_CASE_IDS = Object.freeze([
  "approved_happy_path",
  "plan_rejected_and_replanned",
  "information_requested_and_answered",
  "root_revision_and_comment",
  "parallel_multi_conductor",
  "same_conductor_preemption",
  "conductor_restart_recovery",
  "missing_worktree_recovery",
]);

export const FOREGROUND_E2E_COMMON_ASSERTION_IDS = Object.freeze([
  "case_scope_isolated",
  "complete_native_coverage",
  "native_identity_consistent",
  "requirement_preserved",
  "human_provenance_preserved",
  "native_result_evidence",
  "delivery_consistent",
  "terminal_nodes_not_dispatched",
  "human_content_only",
  "no_test_control_facts",
]);

const COMMON_ASSERTIONS = Object.freeze([
  ["case_scope_isolated", "required", "equals", ["case_topology", "repositories", "routing", "native_graph"], ["case_id", "root_ids", "repository_ids", "conductor_ids"]],
  ["complete_native_coverage", "required", "aggregate", ["active_tree", "archived_tree", "labels", "statuses", "relations", "comments", "threads", "reactions", "attachments", "activity", "git"], ["root_ids", "pagination_coverage", "repository_ids"]],
  ["native_identity_consistent", "required", "linked", ["issues", "primary_kind_labels", "parents", "relations"], ["root_ids", "native_issue_ids"]],
  ["requirement_preserved", "required", "equals", ["root_descriptions", "human_inputs", "native_activity"], ["case_id", "root_ids", "input_hashes", "comment_ids"]],
  ["human_provenance_preserved", "required", "linked", ["comments", "replies", "reactions", "activity"], ["root_ids", "human_actor_id", "comment_ids"]],
  ["native_result_evidence", "required", "linked", ["issue_statuses", "labels", "findings", "git", "checks"], ["root_ids", "cycle_ids", "native_issue_ids", "git_revisions"]],
  ["delivery_consistent", "required", "linked", ["root_status", "cycle_status", "verify_issue", "git", "scm_links"], ["root_ids", "verify_issue_ids", "git_revisions"]],
  ["terminal_nodes_not_dispatched", "required", "ordered", ["issue_statuses", "activity"], ["root_ids", "native_issue_ids", "activity_ids"]],
  ["human_content_only", "required", "equals", ["descriptions", "comments"], ["root_ids", "symphony_actor_ids", "comment_ids"]],
  ["no_test_control_facts", "prohibited", "equals", ["issues", "comments", "activity", "git"], ["root_ids", "human_actor_id"]],
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
      priority: "urgent",
      acceptanceCriteria: [
        "The helper has focused tests for its supported input.",
        "The repository checks pass.",
        "The completed change is ready for review.",
      ],
    })],
    interactions: [
      waitForAction("approved-root", "plan_review", "approved_plan_review"),
      terminalAction("approved-root", "approved_plan_review", "Approved"),
    ],
    verificationBoundary: "in_review_delivery",
    assertions: [
      assertion("plan_approval_precedes_work", "required", "ordered", ["plan_review", "work"], ["root_id", "plan_issue_id", "approval_reply_comment_id"]),
      assertion("cycle_plan_work_verify_tree_materialized", "required", "linked", ["issue_tree", "workflow_issues", "human_action", "stage_issue_status"], ["root_id", "cycle_id", "plan_issue_id", "work_issue_ids", "verify_issue_id", "approval_request_comment_id"]),
      assertion("stage_chain_delivered", "required", "linked", ["plan", "work", "verify", "scm_links", "git"], ["root_id", "cycle_id", "stage_issue_ids", "git_revision"]),
      assertion("boundary_in_review_delivery", "boundary", "linked", ["root_status", "verify_issue", "scm_links", "git"], ["root_id", "verify_issue_id", "pr_attachment_id", "git_revision"]),
      assertion("work_before_approval", "prohibited", "ordered", ["plan_review", "work"], ["root_id", "plan_issue_id", "approval_reply_comment_id"]),
      assertion("duplicate_or_synthetic_completion", "prohibited", "unique", ["native_completion", "activity", "git"], ["root_id", "native_issue_ids", "writer_actor_ids"]),
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
      priority: "normal",
      acceptanceCriteria: [
        "The initial Plan is available for review.",
        "A rejected Plan produces a fresh replacement Plan rather than in-place mutation.",
      ],
    })],
    interactions: [
      waitForAction("rejected-plan-root", "plan_review", "rejected_plan_review"),
      actionComment("rejected-plan-root", "rejected_plan_review", "The plan should preserve the existing utility contract before adding the new behavior.", "rejection_reason", "rejection_reason"),
    ],
    verificationBoundary: "fresh_plan_review",
    assertions: [
      assertion("rejection_consumed_and_replied", "required", "linked", ["human_action", "comments", "reconciler_reply"], ["root_id", "request_comment_id", "source_comment_id", "reply_id"]),
      assertion("rejected_lineage_retained", "required", "archived", ["plan_issue_description", "plan_result", "human_action", "stage_issue_activity"], ["root_id", "old_plan_issue_id", "old_stage_issue_id", "old_request_comment_id"]),
      assertion("rejected_contract_superseded", "required", "linked", ["plan_issue_description", "archive", "plan_issue_activity", "human_action"], ["root_id", "old_plan_issue_id", "new_plan_issue_id", "new_stage_issue_id", "new_request_comment_id"]),
      assertion("boundary_fresh_plan_review", "boundary", "linked", ["plan_issue_description", "plan_issue_activity", "human_action"], ["root_id", "new_plan_issue_id", "new_stage_issue_id", "new_request_comment_id"]),
      assertion("work_against_rejected_contract", "prohibited", "linked", ["work", "plan_issue_description", "human_reply_consequence"], ["root_id", "old_plan_issue_id", "work_stage_issue_ids"]),
      assertion("contract_overwritten_or_history_deleted", "prohibited", "archived", ["plan_issue_description", "plan_result", "human_action"], ["root_id", "old_plan_issue_id", "old_stage_issue_id", "old_request_comment_id"]),
      assertion("test_created_replacement", "prohibited", "equals", ["plan_issue_description", "human_action", "writer_actor"], ["root_id", "new_plan_issue_id", "new_request_comment_id", "writer_actor_ids"]),
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
      priority: "low",
      acceptanceCriteria: [
        "The missing separator is requested through a Human Action.",
        "The answer leads to a fresh Plan that records the selected separator.",
      ],
    })],
    interactions: [
      waitForAction("information-root", "clarification", "separator_clarification"),
      actionComment("information-root", "separator_clarification", "Use a colon as the identifier separator.", "separator_answer", "separator_answer"),
    ],
    verificationBoundary: "fresh_plan_review",
    assertions: [
      assertion("information_action_actionable", "required", "linked", ["human_action", "action_description"], ["root_id", "request_comment_id", "action_kind"]),
      assertion("answer_consumed_and_receipted", "required", "linked", ["human_action", "comments", "reconciler_reply", "reaction"], ["root_id", "request_comment_id", "source_comment_id", "reply_id"]),
      assertion("answer_drives_fresh_plan", "required", "linked", ["human_reply_consequence", "plan_issue_activity", "plan_issue_description", "human_action"], ["root_id", "request_comment_id", "answer_comment_id", "new_stage_issue_id", "new_plan_issue_id"]),
      assertion("boundary_fresh_plan_review", "boundary", "linked", ["plan_issue_activity", "plan_issue_description", "human_action"], ["root_id", "new_stage_issue_id", "new_plan_issue_id", "new_request_comment_id"]),
      assertion("missing_answer_assumed", "prohibited", "equals", ["human_action", "plan_issue_description", "comments"], ["root_id", "request_comment_id", "plan_issue_id"]),
      assertion("test_unblocks_or_mutates_stage", "prohibited", "equals", ["plan", "work", "verify", "activity"], ["root_id", "writer_actor_ids"]),
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
      priority: "high",
      acceptanceCriteria: [
        "The initial requirement is planned before the revision.",
        "The revised requirement starts a successor Cycle with a fresh Plan review.",
      ],
    })],
    interactions: [
      waitForPlanContractAndAction("revision-root", "plan_review", "initial_plan_review"),
      rootDescription("revision-root", "Replace the uppercase helper with a lowercase identifier helper and focused tests.", "revision_description"),
      waitForReceipt("revision-root", "revision_description", ["native_activity", "cycle_status", "successor_cycle"]),
      comment("revision-root", "The original helper name no longer matches the requirement.", "revision_comment", "revision_comment_create"),
      waitForReceipt("revision-root", "revision_comment_create", ["reply", "reaction"]),
      editComment("revision-root", "revision_comment", "The original helper name no longer matches the revised requirement.", "revision_comment_edit"),
      waitForReceipt("revision-root", "revision_comment_edit", ["reply", "reaction"]),
      threadTransition("resolve_comment_thread", "revision-root", "revision_comment", "revision_thread_resolve"),
      waitForReceipt("revision-root", "revision_thread_resolve", ["reply", "reaction", "thread_state"]),
      threadTransition("reopen_comment_thread", "revision-root", "revision_comment", "revision_thread_reopen"),
      waitForReceipt("revision-root", "revision_thread_reopen", ["reply", "reaction", "thread_state"]),
    ],
    verificationBoundary: "successor_plan_review",
    assertions: [
      assertion("ordinary_inputs_consumed_once", "required", "unique", ["root_description", "comments", "root_native_consequence", "native_activity", "replies", "reactions"], ["root_id", "input_ids", "reply_ids"]),
      assertion("thread_transitions_receipted", "required", "thread-state", ["comments", "thread_state", "replies", "reactions"], ["root_id", "thread_root_comment_id", "reply_ids"]),
      assertion("revision_supersedes_cycle", "required", "archived", ["cycle", "plan_issue_activity", "plan_issue_description", "human_action"], ["root_id", "old_cycle_id", "new_cycle_id", "new_stage_issue_id", "new_plan_issue_id"]),
      assertion("boundary_successor_plan_review", "boundary", "linked", ["cycle", "plan_issue_activity", "plan_issue_description", "human_action"], ["root_id", "new_cycle_id", "new_stage_issue_id", "new_plan_issue_id", "new_request_comment_id"]),
      assertion("system_comment_treated_as_input", "prohibited", "equals", ["comments", "native_activity"], ["root_id", "system_comment_ids", "input_ids"]),
      assertion("thread_history_lost", "prohibited", "thread-state", ["comments", "thread_state", "activity"], ["root_id", "thread_root_comment_id", "comment_versions"]),
      assertion("undeclared_revision_or_conductor_interpretation", "prohibited", "equals", ["root_description", "comments", "native_activity"], ["root_id", "declared_input_hashes", "input_ids"]),
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
        priority: "high",
        acceptanceCriteria: ["The helper is delivered with a passing Verify result."],
      }),
      root({
        rootKey: "parallel-b-root",
        conductorRef: "conductor-b",
        repositoryRef: "parallel-b-repository",
        title: "Add a suffix helper",
        description: "Implement a small suffix helper with focused tests.",
        priority: "normal",
        acceptanceCriteria: ["The helper is delivered with a passing Verify result."],
      }),
    ],
    interactions: [
      waitForAction("parallel-a-root", "plan_review", "parallel_a_plan_review"),
      terminalAction("parallel-a-root", "parallel_a_plan_review", "Approved"),
      waitForAction("parallel-b-root", "plan_review", "parallel_b_plan_review"),
      terminalAction("parallel-b-root", "parallel_b_plan_review", "Approved"),
    ],
    verificationBoundary: "all_roots_delivered",
    assertions: [
      assertion("root_routing_and_workspace_isolated", "required", "unique", ["routing", "process_generations", "native_mutation_actors", "workspaces", "repositories"], ["root_ids", "conductor_ids", "repository_ids"]),
      assertion("independent_delivery_chains", "required", "linked", ["plan", "work", "verify", "scm_links", "git"], ["root_ids", "cycle_ids", "stage_issue_ids", "git_revisions"]),
      assertion("cross_conductor_stage_overlap", "required", "interval-overlap", ["stage_issue_activity", "stage_issue_status"], ["root_ids", "conductor_ids", "stage_issue_ids"]),
      assertion("boundary_all_roots_delivered", "boundary", "aggregate", ["root_status", "verify_issues", "scm_links", "git"], ["root_ids", "verify_issue_ids", "pr_attachment_ids", "git_revisions"]),
      assertion("cross_conductor_routing_violation", "prohibited", "equals", ["routing", "process_generations", "native_mutation_actors", "activity"], ["root_ids", "conductor_ids"]),
      assertion("shared_workspace_writer", "prohibited", "unique", ["workspaces", "stage_issue_activity"], ["root_ids", "workspace_ids", "stage_issue_ids"]),
      assertion("telemetry_substitutes_overlap", "prohibited", "equals", ["stage_issue_activity", "stage_issue_status", "telemetry"], ["root_ids", "stage_issue_ids"]),
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
        priority: "high",
        acceptanceCriteria: ["The helper is delivered with a passing Verify result."],
      }),
      root({
        rootKey: "touched-root",
        conductorRef: "conductor-a",
        repositoryRef: "preemption-touched-repository",
        title: "Add a touched marker helper",
        description: "Implement a small marker helper with focused tests.",
        priority: "high",
        acceptanceCriteria: ["The helper is delivered with a passing Verify result."],
      }),
      root({
        rootKey: "remaining-root",
        conductorRef: "conductor-a",
        repositoryRef: "preemption-remaining-repository",
        title: "Add a remaining marker helper",
        description: "Implement a small marker helper with focused tests.",
        priority: "high",
        acceptanceCriteria: ["The helper is delivered with a passing Verify result."],
      }),
      root({
        rootKey: "low-priority-root",
        conductorRef: "conductor-a",
        repositoryRef: "preemption-low-priority-repository",
        title: "Add a low priority marker helper",
        description: "Implement a small low priority marker helper with focused tests.",
        priority: "low",
        acceptanceCriteria: ["The helper is delivered with a passing Verify result."],
      }),
    ],
    interactions: [
      bindPreemptionRoles(["inflight-root", "touched-root", "remaining-root"]),
      touchBoundRootDescription({
        "inflight-root": "Implement a small marker helper with focused tests. Scheduling note: this request remains semantically unchanged.",
        "touched-root": "Implement a small marker helper with focused tests. Scheduling note: this request remains semantically unchanged.",
        "remaining-root": "Implement a small marker helper with focused tests. Scheduling note: this request remains semantically unchanged.",
      }),
      waitForBoundRootStage("preemption_touched_root", "preemption_inflight_terminal"),
      terminalActionForEachRoot(["inflight-root", "touched-root", "remaining-root", "low-priority-root"], "plan_review", "Approved", "preemption_ordering_proven"),
    ],
    verificationBoundary: "all_roots_delivered",
    assertions: [
      assertion("inflight_stage_completes", "required", "ordered", ["stage_issue_activity", "stage_issue_status"], ["root_id", "inflight_stage_issue_id"]),
      assertion("latest_ready_root_runs_next", "required", "ordered", ["root_headers", "routing", "process_generation", "activity"], ["root_ids", "conductor_id", "touched_root_id", "native_issue_ids"]),
      assertion("higher_priority_roots_run_before_lower_priority_root", "required", "ordered", ["root_headers", "routing", "process_generation", "activity"], ["root_ids", "conductor_id", "higher_priority_root_ids", "lower_priority_root_id", "native_issue_ids"]),
      assertion("remaining_ready_root_progresses", "required", "ordered", ["stage_issue_activity", "stage_issue_status"], ["root_ids", "conductor_id", "stage_issue_ids"]),
      assertion("boundary_all_roots_delivered", "boundary", "aggregate", ["root_status", "verify_issues", "scm_links", "git"], ["root_ids", "verify_issue_ids", "pr_attachment_ids", "git_revisions"]),
      assertion("inflight_turn_interrupted", "prohibited", "equals", ["stage_issue_activity", "stage_issue_status"], ["root_id", "inflight_stage_issue_id"]),
      assertion("test_selects_next_root", "prohibited", "equals", ["scheduler", "activity", "stage_issue_activity"], ["root_ids", "conductor_id", "stage_issue_ids"]),
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
        priority: "urgent",
        acceptanceCriteria: ["The helper is delivered after a Conductor restart."],
      }),
      root({
        rootKey: "continuous-root",
        conductorRef: "conductor-b",
        repositoryRef: "recovery-continuous-repository",
        title: "Add a continuous marker helper",
        description: "Implement a small marker helper with focused tests.",
        priority: "low",
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
      assertion("old_execution_terminal_once", "required", "unique", ["stage_issue_activity", "stage_issue_status"], ["affected_root_id", "old_stage_issue_id"]),
      assertion("recovery_uses_fresh_execution", "required", "linked", ["stage_issue_activity", "stage_issue_status", "scm_links"], ["affected_root_id", "old_stage_issue_id", "new_stage_issue_id", "role_session_ids"]),
      assertion("routing_persists", "required", "equals", ["routing", "process_generation", "native_mutation_actors", "activity"], ["affected_root_id", "conductor_id"]),
      assertion("unaffected_root_continues", "required", "linked", ["stage_issue_activity", "stage_issue_status", "scm_links"], ["continuous_root_id", "continuous_conductor_id", "stage_issue_ids"]),
      assertion("boundary_recovered_and_continuous_delivered", "boundary", "aggregate", ["root_status", "verify_issues", "scm_links", "git"], ["affected_root_id", "continuous_root_id", "pr_attachment_ids", "git_revisions"]),
      assertion("late_old_session_success", "prohibited", "unique", ["stage_issue_activity", "stage_issue_status", "scm_links"], ["affected_root_id", "old_stage_issue_id", "old_role_session_id"]),
      assertion("checkpoint_or_linear_rewrite", "prohibited", "equals", ["checkpoint", "linear_activity", "workflow_facts"], ["affected_root_id", "writer_actor_ids"]),
      assertion("unaffected_conductor_reconfigured", "prohibited", "equals", ["routing", "process_generation", "conductor_configuration", "activity"], ["continuous_root_id", "continuous_conductor_id"]),
    ],
  }),
  caseDefinition({
    caseId: "missing_worktree_recovery",
    roots: [
      root({
        rootKey: "recoverable-worktree-root",
        conductorRef: "conductor-a",
        repositoryRef: "recoverable-worktree-repository",
        title: "Preserve work across worktree rematerialization",
        description: "Implement a small recovery helper with focused tests and preserve valid committed work when the worktree is removed.",
        priority: "high",
        acceptanceCriteria: ["Valid branch commits survive exact worktree removal and the Root is delivered from the same execution tree."],
      }),
      root({
        rootKey: "invalid-generation-root",
        conductorRef: "conductor-b",
        repositoryRef: "invalid-generation-repository",
        title: "Rebuild an unrecoverable execution generation",
        description: "Implement a small generation helper with focused tests and rebuild from repository base when execution Git facts are unrecoverable.",
        priority: "high",
        acceptanceCriteria: ["The invalid generation is canceled and archived before a fresh approved generation is delivered."],
      }),
    ],
    interactions: [
      { kind: "wait_for_stage_inflight", rootKey: "recoverable-worktree-root" },
      { kind: "wait_for_stage_inflight", rootKey: "invalid-generation-root" },
      waitForAction("recoverable-worktree-root", "plan_review", "recoverable_plan_review"),
      terminalAction("recoverable-worktree-root", "recoverable_plan_review", "Approved"),
      waitForAction("invalid-generation-root", "plan_review", "invalid_generation_plan_review"),
      terminalAction("invalid-generation-root", "invalid_generation_plan_review", "Approved"),
    ],
    processFaults: [
      "stop_owner_and_remove_exact_recoverable_worktree",
      "stop_owner_remove_exact_worktree_and_execution_branch",
    ],
    verificationBoundary: "recoverable_and_fresh_generations_delivered",
    assertions: [
      assertion("worktree_missing_detected_before_dispatch", "required", "ordered", ["worktrees", "branches", "issue_activity"], ["root_ids", "native_issue_ids", "git_revisions"]),
      assertion("valid_branch_rematerialized", "required", "linked", ["worktrees", "branches", "commits", "native_graph"], ["recoverable_root_id", "branch", "git_revision", "native_issue_ids"]),
      assertion("invalid_generation_canceled_and_archived", "required", "linked", ["cycle_status", "archived_descendants", "relations", "activity"], ["invalid_root_id", "old_cycle_id", "old_native_issue_ids"]),
      assertion("fresh_generation_uses_new_native_ids", "required", "unique", ["cycles", "plans", "work", "verify", "relations"], ["invalid_root_id", "old_native_issue_ids", "new_native_issue_ids"]),
      assertion("fresh_generation_requires_fresh_approval", "required", "ordered", ["root_threads", "plan_issue", "work_activity"], ["invalid_root_id", "new_plan_issue_id", "approval_reply_comment_id"]),
      assertion("boundary_recoverable_and_fresh_generations_delivered", "boundary", "aggregate", ["root_status", "verify_issues", "git", "scm_links"], ["root_ids", "verify_issue_ids", "git_revisions"]),
      assertion("invalid_branch_remounted", "prohibited", "equals", ["worktrees", "branches", "commits"], ["invalid_root_id", "old_branch", "old_git_revision"]),
      assertion("old_generation_authorizes_fresh_work", "prohibited", "linked", ["old_approval_thread", "new_plan_issue", "work_activity"], ["invalid_root_id", "old_plan_issue_id", "new_plan_issue_id"]),
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
    rootCreationInputs: roots.map(({ rootKey, conductorRef, title, description, acceptanceCriteria, priority }) => ({
      rootKey,
      title,
      description: rootCreationDescription(description, acceptanceCriteria),
      priority,
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

function root({ rootKey, conductorRef, repositoryRef, title, description, acceptanceCriteria, priority }) {
  if (!validPriority(priority)) throw new Error(`invalid foreground E2E priority for ${rootKey}`);
  return { rootKey, conductorRef, repositoryRef, title, description, acceptanceCriteria, priority };
}

function validPriority(value) {
  return ["urgent", "high", "normal", "low", "no_priority"].includes(value);
}

function requirement({ rootKey, title, description, acceptanceCriteria }) {
  const immutable = { rootKey, title, description, acceptanceCriteria };
  return { ...immutable, hash: createHash("sha256").update(JSON.stringify(immutable)).digest("hex") };
}

function rootCreationDescription(description, acceptanceCriteria) {
  return `${description}\n\n## Acceptance Criteria\n\n${acceptanceCriteria.map((criterion) => `* ${criterion}`).join("\n")}`;
}

function waitForAction(rootKey, actionKind, actionBinding) {
  return { kind: "wait_for_human_action", rootKey, actionKind, actionBinding };
}

function terminalAction(rootKey, actionBinding, terminalStatus) {
  return { kind: "reply_to_human_action", rootKey, actionBinding, body: `${terminalStatus}.` };
}

function waitForPlanContractAndAction(rootKey, actionKind, actionBinding) {
  return { kind: "wait_for_plan_approval_gate", rootKey, actionKind, actionBinding };
}

function rootDescription(rootKey, description, inputBinding) {
  return { kind: "update_root_description", rootKey, description, inputBinding };
}

function waitForReceipt(rootKey, sourceBinding, requiredFacts) {
  return { kind: "wait_for_input_receipt", rootKey, sourceBinding, requiredFacts };
}

function comment(rootKey, body, commentBinding, inputBinding) {
  return {
    kind: "create_comment",
    rootKey,
    body,
    ...(commentBinding === undefined ? {} : { commentBinding }),
    ...(inputBinding === undefined ? {} : { inputBinding }),
  };
}

function actionComment(rootKey, actionBinding, body, commentBinding, inputBinding) {
  return {
    kind: "reply_to_human_action",
    rootKey,
    actionBinding,
    body,
    commentBinding,
    inputBinding,
  };
}

function editComment(rootKey, commentBinding, body, inputBinding) {
  return { kind: "edit_comment", rootKey, commentBinding, body, inputBinding };
}

function threadTransition(kind, rootKey, commentBinding, inputBinding) {
  return { kind, rootKey, commentBinding, inputBinding };
}

function bindPreemptionRoles(rootKeys) {
  return {
    kind: "bind_preemption_roles",
    rootKeys,
    inflightBinding: "preemption_inflight_root",
    touchedBinding: "preemption_touched_root",
    remainingBinding: "preemption_remaining_root",
    candidateOrder: "root_key_ascending",
  };
}

function touchBoundRootDescription(descriptionsByRootKey) {
  return {
    kind: "touch_bound_root_description",
    rootBinding: "preemption_touched_root",
    descriptionsByRootKey,
  };
}

function waitForBoundRootStage(rootBinding, after) {
  return { kind: "wait_for_bound_root_stage", rootBinding, after };
}

function terminalActionForEachRoot(rootKeys, actionKind, terminalStatus, after) {
  return { kind: "reply_to_each_matching_human_action", rootKeys, actionKind, body: `${terminalStatus}.`, oncePerRoot: true, after };
}

function assertion(assertionId, kind, predicate, factScope, correlation) {
  return { assertionId, kind, factScope, correlation, predicate };
}

export function bindSameConductorPreemptionRoles({ inflightRootKeys, readyRootKeys } = {}) {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "same_conductor_preemption");
  const binding = definition?.declaredUserInteractions.find(({ kind }) => kind === "bind_preemption_roles");
  const touch = definition?.declaredUserInteractions.find(({ kind }) => kind === "touch_bound_root_description");
  if (!binding || !touch || !isDistinctIdentifiers(inflightRootKeys) || !isDistinctIdentifiers(readyRootKeys)) {
    throw preemptionBindingError();
  }

  const expected = new Set(binding.rootKeys);
  const observed = new Set([...inflightRootKeys, ...readyRootKeys]);
  if (inflightRootKeys.length !== 1 || readyRootKeys.length !== 2 || observed.size !== expected.size ||
      [...observed].some((rootKey) => !expected.has(rootKey))) {
    throw preemptionBindingError();
  }

  const [inflightRootKey] = inflightRootKeys;
  const [touchedRootKey, remainingRootKey] = [...readyRootKeys].sort();
  const touchDescription = touch.descriptionsByRootKey[touchedRootKey];
  if (typeof touchDescription !== "string" || touchDescription.length === 0) throw preemptionBindingError();
  return Object.freeze({ inflightRootKey, touchedRootKey, remainingRootKey, touchDescription });
}

function isDistinctIdentifiers(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0) &&
    new Set(value).size === value.length;
}

function preemptionBindingError() {
  const error = new Error("foreground_e2e_preemption_binding_incomplete");
  error.code = "foreground_e2e_preemption_binding_incomplete";
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
