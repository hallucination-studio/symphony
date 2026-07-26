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
      waitForAction("approved-root", "plan_review", "approved_plan_review"),
      terminalAction("approved-root", "approved_plan_review", "Approved"),
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
      waitForAction("rejected-plan-root", "plan_review", "rejected_plan_review"),
      actionComment("rejected-plan-root", "rejected_plan_review", "The plan should preserve the existing utility contract before adding the new behavior.", "rejection_reason", "rejection_reason"),
      terminalAction("rejected-plan-root", "rejected_plan_review", "Rejected"),
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
      waitForAction("information-root", "clarification", "separator_clarification"),
      actionComment("information-root", "separator_clarification", "Use a colon as the identifier separator.", "separator_answer", "separator_answer"),
      terminalAction("information-root", "separator_clarification", "Answered"),
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
      waitForPlanContractAndAction("revision-root", "plan_review", "initial_plan_review"),
      rootDescription("revision-root", "Replace the uppercase helper with a lowercase identifier helper and focused tests.", "revision_description"),
      waitForReceipt("revision-root", "revision_description", ["root_directive"]),
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
      assertion("ordinary_inputs_consumed_once", "required", "unique", ["root_description", "comments", "root_directive", "reconciler_inputs", "replies", "reactions"], ["root_id", "input_ids", "reply_ids"]),
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
      waitForAction("parallel-a-root", "plan_review", "parallel_a_plan_review"),
      terminalAction("parallel-a-root", "parallel_a_plan_review", "Approved"),
      waitForAction("parallel-b-root", "plan_review", "parallel_b_plan_review"),
      terminalAction("parallel-b-root", "parallel_b_plan_review", "Approved"),
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
      bindPreemptionRoles(["inflight-root", "touched-root", "remaining-root"]),
      touchBoundRootDescription({
        "inflight-root": "Implement a small marker helper with focused tests. Scheduling note: this request remains semantically unchanged.",
        "touched-root": "Implement a small marker helper with focused tests. Scheduling note: this request remains semantically unchanged.",
        "remaining-root": "Implement a small marker helper with focused tests. Scheduling note: this request remains semantically unchanged.",
      }),
      waitForBoundRootStage("preemption_touched_root", "preemption_inflight_terminal"),
      terminalActionForEachRoot(["inflight-root", "touched-root", "remaining-root"], "plan_review", "Approved", "preemption_ordering_proven"),
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

function waitForAction(rootKey, actionKind, actionBinding) {
  return { kind: "wait_for_human_action", rootKey, actionKind, actionBinding };
}

function terminalAction(rootKey, actionBinding, terminalStatus) {
  return { kind: "set_human_action_status", rootKey, actionBinding, terminalStatus };
}

function waitForPlanContractAndAction(rootKey, actionKind, actionBinding) {
  return { kind: "wait_for_plan_contract_and_human_action", rootKey, actionKind, actionBinding };
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
    kind: "create_action_comment",
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
  return { kind: "set_each_matching_human_action_status", rootKeys, actionKind, terminalStatus, oncePerRoot: true, after };
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
