import type { RootWorktreeGateResult } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { RootBootstrap, RootSemanticGateCommand } from "../../root-reconciliation/api/RootReconciliationContracts.js";

export type RootSemanticGate =
  | "requirement_and_comment"
  | "plan_human_decision"
  | "recovery_strategy"
  | "terminal_review";

export type RootMechanicalTarget =
  | {
      kind: "create_root_workspace";
      expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "fresh_missing" }>;
    }
  | {
      kind: "rematerialize_root_workspace";
      expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "recoverable_missing" }>;
    }
  | {
      kind: "converge_invalid_execution_generation";
      cycleIssueId: string;
      expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "execution_generation_invalid" }>;
    }
  | {
      kind: "converge_successor_cycle_plan";
      predecessorCycleIssueId: string;
      expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "valid" }>;
    }
  | {
      kind: "converge_authorized_successor";
      authorizationKind: "delivery_recovery" | "terminal_review" | "stage_recovery";
      predecessorCycleIssueId: string;
      successorCycleIssueId: string;
      expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "valid" }>;
    }
  | {
      kind: "converge_initial_cycle_plan";
      expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "valid" }>;
    }
  | {
      kind: "converge_interrupted_plan_successor";
      cycleIssueId: string;
      predecessorPlanIssueId: string;
      successorPlanIssueId: string;
      expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "valid" }>;
    }
  | {
      kind: "converge_cycle_replan";
      cycleIssueId: string;
      successorPlanIssueId: string;
      expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "valid" }>;
    }
  | {
      kind: "converge_cycle_repair";
      cycleIssueId: string;
      interruptedStageIssueId: string;
      repairWorkIssueId: string;
      expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "valid" }>;
    }
  | {
      kind: "converge_finding_waiver";
      cycleIssueId: string;
      requestCommentId: string;
      humanReplyCommentId: string;
      adoptionCommentId: string;
      findingIssueIds: string[];
      expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "valid" }>;
    }
  | {
      kind: "converge_approved_plan_dag";
      cycleIssueId: string;
      planIssueId: string;
      planContentDigest: string;
      expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "valid" }>;
    }
  | {
      kind: "dispatch_stage";
      role: "plan" | "work" | "verify";
      cycleIssueId: string;
      stageIssueId: string;
      expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "valid" }>;
    }
  | {
      kind: "prepare_verify_target";
      cycleIssueId: string;
      verifyIssueId: string;
      expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "valid" }>;
    }
  | {
      kind: "resume_verify_findings";
      cycleIssueId: string;
      verifyIssueId: string;
      expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "valid" }>;
    }
  | {
      kind: "advance_cycle_phase";
      cycleIssueId: string;
      desiredStatus: "Executing" | "Verifying";
      expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "valid" }>;
    }
  | {
      kind: "conclude_successful_cycle";
      cycleIssueId: string;
      verifyIssueId: string;
      expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "valid" }>;
    }
  | {
      kind: "conclude_repair_exhausted_cycle";
      cycleIssueId: string;
      expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "valid" }>;
    }
  | {
      kind: "conclude_repeated_finding_exhausted_cycle";
      cycleIssueId: string;
      findingIssueIds: string[];
    }
  | {
      kind: "conclude_deadline_exceeded_cycle";
      cycleIssueId: string;
    }
  | {
      kind: "conclude_deadline_exceeded_root";
    }
  | {
      kind: "interrupt_stage";
      role: "plan" | "work" | "verify";
      cycleIssueId: string;
      stageIssueId: string;
      expectedWorktreeGate: Extract<RootWorktreeGateResult, { kind: "valid" }>;
    };

export type RootTransitionResult =
  | {
      kind: "mechanical_target";
      rootIssueId: string;
      rootDigest: string;
      target: RootMechanicalTarget;
    }
  | {
      kind: "semantic_gate";
      rootIssueId: string;
      rootDigest: string;
      command: RootSemanticGateCommand;
    }
  | {
      kind: "external_wait";
      rootIssueId: string;
      rootDigest: string;
      reason: "human_action_pending" | "stage_in_progress" | "mutation_acceptance_unknown" | "runtime_fence_pending";
      sourceIds: string[];
    }
  | {
      kind: "terminal";
      rootIssueId: string;
      rootDigest: string;
      rootStatus: "Done" | "Canceled";
    }
  | {
      kind: "invalid_facts";
      rootIssueId: string;
      rootDigest: string;
      reason:
        | "incomplete_coverage"
        | "coverage_inconsistent"
        | "root_identity_invalid"
        | "mechanical_violation"
        | "convergence_policy_violation"
        | "worktree_generation_mismatch"
        | "pending_input_unresolved"
        | "transition_row_not_implemented";
      sourceIds: string[];
    };

export interface RootTransitionPolicyInterface {
  evaluate(facts: RootBootstrap): RootTransitionResult;
}
