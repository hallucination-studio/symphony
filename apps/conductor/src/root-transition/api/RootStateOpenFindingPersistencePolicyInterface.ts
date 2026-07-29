import type { RootStateView } from "./RootStateViewPolicyInterface.js";

export interface RootStateOpenFindingLineage {
  findingId: string;
  openCycleCount: number;
  findingIds: readonly string[];
}

export interface RootStateOpenFindingPersistencePolicyInterface {
  derive(input: {
    view: RootStateView;
    activeCycleIssueId?: string;
  }): readonly RootStateOpenFindingLineage[];
}
