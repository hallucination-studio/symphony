import type {
  CorrelationId,
  CycleIssueId,
  RepositoryId,
  RootIssueId,
  StageIssueId,
} from "../../contracts/identity.js";
import type { MutationResult } from "../../contracts/mutation.js";
import type {
  CycleStatus,
  LinearObservation,
  RootStatus,
  StageKind,
  StageStatus,
} from "../../contracts/observation.js";

export interface RootCandidate {
  readonly root_id: RootIssueId;
  readonly status: RootStatus;
  readonly priority: number;
  readonly created_at: string;
  readonly repository_id: RepositoryId;
  readonly base_branch: string;
}

export type LinearMutation =
  | {
    readonly kind: "create_cycle";
    readonly root_id: RootIssueId;
    readonly correlation_id: CorrelationId;
    readonly expected_root_status: "Todo" | "In Progress";
    readonly expected_no_active_cycle: true;
  }
  | {
    readonly kind: "set_root_status";
    readonly root_id: RootIssueId;
    readonly correlation_id: CorrelationId;
    readonly expected_status: RootStatus;
    readonly desired_status: RootStatus;
  }
  | {
    readonly kind: "set_cycle_status";
    readonly root_id: RootIssueId;
    readonly cycle_issue_id: CycleIssueId;
    readonly correlation_id: CorrelationId;
    readonly expected_status: CycleStatus;
    readonly desired_status: CycleStatus;
  }
  | {
    readonly kind: "set_stage_status";
    readonly root_id: RootIssueId;
    readonly cycle_issue_id: CycleIssueId;
    readonly stage_issue_id: StageIssueId;
    readonly expected_kind: StageKind;
    readonly correlation_id: CorrelationId;
    readonly expected_status: StageStatus;
    readonly desired_status: StageStatus;
  };

export interface LinearGatewayInterface {
  discoverRoots(): Promise<readonly RootCandidate[]>;
  readRoot(rootId: RootIssueId): Promise<LinearObservation>;
  mutate(command: LinearMutation): Promise<MutationResult>;
}

export async function mutateAndReadBack(
  gateway: LinearGatewayInterface,
  command: LinearMutation,
  accepts: (observation: LinearObservation) => boolean,
): Promise<{ readonly result: MutationResult; readonly observation: LinearObservation }> {
  const result = await gateway.mutate(command);
  const observation = await gateway.readRoot(command.root_id);
  if (!accepts(observation)) throw new Error("linear_readback_mismatch");
  return Object.freeze({ result, observation });
}
