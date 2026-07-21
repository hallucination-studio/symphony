import type {
  GitWorkspaceSnapshot,
} from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type {
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  CycleMarker,
  ManagedRecord,
  NodeMarker,
  PlanContract,
  RootOwnershipRecord,
} from "./ManagedRecords.js";

export type RootWorkflowState = "Todo" | "In Progress" | "Needs Approval" | "Needs Info" | "In Review" | "Done" | "Canceled";
export type CycleState = "Draft" | "Planning" | "Sealed" | "Executing" | "Verifying" | "Succeeded" | "Changes Required" | "Inconclusive" | "Escalated" | "Canceled";
export type StageNodeState = "Todo" | "In Progress" | "In Review" | "Done" | "Failed" | "Canceled";
export type StageKind = "plan" | "work" | "verify";

export interface RootDispatchAssessment {
  rootIssueId: string;
  readiness: "runnable" | "waiting_human" | "needs_attention" | "terminal";
  sanitizedReason?: string;
}

export interface RootDagNodeView {
  issue: LinearWorkflowTreeSnapshot["issues"][number];
  marker: NodeMarker;
  records: ManagedRecord[];
  blockedByIssueIds: string[];
}

export interface RootCycleView {
  issue: LinearWorkflowTreeSnapshot["issues"][number];
  marker: CycleMarker;
  records: ManagedRecord[];
  nodes: RootDagNodeView[];
  planContract?: PlanContract;
}

export interface RootDagView {
  root: {
    issue: LinearWorkflowTreeSnapshot["issues"][number];
    records: ManagedRecord[];
    ownership?: RootOwnershipRecord;
  };
  statusCatalog: LinearWorkflowTreeSnapshot["status_catalog"];
  cycles: RootCycleView[];
  relations: LinearWorkflowTreeSnapshot["relations"];
  git: GitWorkspaceSnapshot;
  observedAt: string;
}

export interface RootWorkflowPolicyInterface {
  assess(view: RootDagView): RootDispatchAssessment;
}
