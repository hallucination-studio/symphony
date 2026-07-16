import type { ProtocolError } from "../errors.js";

export type LinearIssueState =
  | "Todo"
  | "In Progress"
  | "In Review"
  | "Done"
  | "Canceled";

export interface ProjectPrecondition {
  conductorShortHash: string;
  expectedProjectId: string;
  expectedProjectUpdatedAt: string;
}

export interface RemotePrecondition {
  expectedIssueId: string;
  expectedUpdatedAt: string;
  expectedState?: LinearIssueState;
  expectedParentIssueId?: string;
  expectedManagedMarker?: string;
}

interface MutationBase {
  project: ProjectPrecondition;
}

type ManagedNodeDescriptor =
  | {
      nodeKind: "work";
      humanKind?: never;
      targetIssueId?: never;
    }
  | {
      nodeKind: "human";
      humanKind: "plan_approval";
      targetIssueId?: never;
    }
  | {
      nodeKind: "human";
      humanKind: "planned_input" | "runtime_input";
      targetIssueId: string;
    };

export type LinearMutationCommand =
  | (MutationBase & ManagedNodeDescriptor & {
      kind: "create_managed_node";
      parentIssueId: string;
      managedMarker: string;
      order: number;
      title: string;
      description: string;
    })
  | (MutationBase & ManagedNodeDescriptor & {
      kind: "update_managed_node";
      precondition: RemotePrecondition;
      title: string;
      description: string;
    })
  | (MutationBase & {
      kind: "update_issue_state";
      precondition: RemotePrecondition;
      state: LinearIssueState;
    })
  | (MutationBase & {
      kind: "reorder_issue_node";
      precondition: RemotePrecondition;
      parentIssueId: string;
      order: number;
    })
  | (MutationBase & {
      kind: "replace_root_phase_label";
      precondition: RemotePrecondition;
      phase:
        | "planning"
        | "awaiting-human"
        | "working"
        | "gating"
        | "delivering"
        | "in-review"
        | "blocked"
        | "failed";
    })
  | (MutationBase & {
      kind: "upsert_root_managed_comment";
      rootPrecondition: RemotePrecondition;
      commentPrecondition?: RemotePrecondition;
      managedMarker: string;
      body: string;
    });

export interface LinearIssueValue {
  issueId: string;
  identifier?: string;
  projectId?: string;
  parentIssueId?: string;
  state?: LinearIssueState;
  order?: number;
  depth?: number;
  title?: string;
  description?: string;
  managedMarker?: string;
  nodeKind?: "work" | "human";
  humanKind?: "plan_approval" | "planned_input" | "runtime_input";
  origin?: "user" | "symphony";
  completedInputHash?: string;
  targetIssueId?: string;
  updatedAt: string;
}

export interface RootIssueValue {
  issue: LinearIssueValue;
  isDelegatedToSymphony: boolean;
}

export interface RootUsageValue {
  rootIssueId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  observedAt: string;
}

export type LinearMutationResult =
  | { kind: "applied"; issue?: LinearIssueValue }
  | { kind: "already_applied"; issue?: LinearIssueValue }
  | { kind: "linear_precondition_conflict" }
  | { kind: "conductor_project_resolution_changed" }
  | { kind: "failed"; error: ProtocolError };
