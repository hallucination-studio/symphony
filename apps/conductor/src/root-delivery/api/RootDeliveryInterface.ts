import type { GitWorkspace } from "../../git-workspaces/api/GitWorkspaceInterface.js";

export type RootDeliveryResult =
  | { kind: "pull_request"; url: string }
  | { kind: "remote_branch"; branch: string }
  | { kind: "local_branch"; branch: string };

export interface ExistingRootDelivery {
  kind: "pull_request" | "remote_branch" | "local_branch";
  branch: string;
  head: string;
  url?: string;
}

export interface RootDeliveryFacts {
  root_issue_id: string;
  root_version: string;
  terminal: boolean;
  blocker_issue_ids: string[];
  tree_digest: string;
  tree_complete: boolean;
  git_head: string;
  checks_digest: string;
  checks_passed: boolean;
  latest_succeeded_cycle?: {
    issue_id: string;
    verify_result_id: string;
    verified_revision: string;
  };
  owner_generation?: string;
  existing_delivery?: ExistingRootDelivery;
}

export interface RootDeliveryCommand {
  rootIssueId: string;
  projectId?: string;
  workspace: GitWorkspace;
  baseBranch: string;
  title: string;
  body: string;
  expected: {
    root_version: string;
    tree_digest: string;
    git_head: string;
    checks_digest: string;
    latest_succeeded_cycle?: {
      issue_id: string;
      verify_result_id: string;
      verified_revision: string;
    };
    owner_generation?: string;
  };
}

export interface RootDeliveryFactsReader {
  readFreshFacts(command: RootDeliveryCommand): Promise<RootDeliveryFacts>;
}

export interface RootDeliveryInterface {
  deliver(command: RootDeliveryCommand): Promise<RootDeliveryResult>;
}

export interface RootDeliveryCompletion {
  command: RootDeliveryCommand;
  result: RootDeliveryResult;
}

export interface RootDeliveryCompletionWriter {
  persist(completion: RootDeliveryCompletion): Promise<void>;
}
