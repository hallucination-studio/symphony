import type { GitWorkspace, GitWorkspaceProvisionerInterface } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { DiscoveredRoot } from "../../root-workflow/api/Models.js";
import type { RootOwnershipRecord } from "../../root-workflow/api/ManagedRecords.js";

export type RootOwnershipClaimResult =
  | { kind: "claimed"; ownership: RootOwnershipRecord; workspace: GitWorkspace }
  | { kind: "already_owned"; ownership: RootOwnershipRecord; workspace: GitWorkspace }
  | { kind: "foreign_owner" }
  | { kind: "profile_not_ready"; profileId?: string };

export interface RootOwnershipClaimInterface {
  claim(input: { root: DiscoveredRoot }): Promise<RootOwnershipClaimResult>;
}

export interface RootOwnershipClaimDependencies {
  linear: Pick<LinearGatewayInterface, "readWorkflowIssueTree" | "mutateWorkflow">;
  git: GitWorkspaceProvisionerInterface;
  profileFor(input: { ownedProfileId?: string }): Promise<{ profileId: string; ready: boolean } | undefined>;
  workspaceFor(root: DiscoveredRoot): GitWorkspace;
  conductorId: string;
  ownerGeneration: string;
  baseBranch: string;
}
