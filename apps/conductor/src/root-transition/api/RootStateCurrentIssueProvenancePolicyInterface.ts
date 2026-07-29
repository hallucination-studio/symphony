import type {
  RootStateActivity,
  RootStateIssue,
  RootStateView,
} from "./RootStateViewPolicyInterface.js";

export type RootStateCurrentIssueProof = { kind: "manifest" } | { kind: "activity"; actorId: string };

export interface RootStateCurrentIssueProvenancePolicyInterface {
  prove(input: {
    view: RootStateView;
    issue: RootStateIssue;
    requiredActivityKinds: readonly RootStateActivity["activityKinds"][number][];
    expectedActorId?: string;
  }): RootStateCurrentIssueProof | undefined;

  currentStatusActor(input: {
    view: RootStateView;
    issue: RootStateIssue;
  }): string | undefined;
}
