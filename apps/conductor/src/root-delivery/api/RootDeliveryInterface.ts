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
  performer_id: string;
  terminal: boolean;
  blocker_issue_ids: string[];
  tree_digest: string;
  tree_complete: boolean;
  git_head: string;
  checks_digest: string;
  checks_passed: boolean;
  existing_delivery?: ExistingRootDelivery;
}

export interface RootDeliveryCommand {
  rootIssueId: string;
  workspace: GitWorkspace;
  baseBranch: string;
  title: string;
  body: string;
  expected: {
    root_version: string;
    performer_id: string;
    tree_digest: string;
    git_head: string;
    checks_digest: string;
  };
}

export interface RootDeliveryFactsReader {
  readFreshFacts(command: RootDeliveryCommand): Promise<RootDeliveryFacts>;
}

export interface RootDeliveryInterface {
  deliver(command: RootDeliveryCommand): Promise<RootDeliveryResult>;
}
