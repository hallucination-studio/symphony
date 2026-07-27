export interface GitWorkspace {
  branch: string;
  worktreePath: string;
  rootIssueId?: string;
}

export interface BoundedGitItems<T> {
  items: T[];
  returned: number;
  cap: number;
  has_more: boolean;
  partial: boolean;
}

export interface GitWorkspaceSnapshot {
  head: string;
  branch: string;
  status: BoundedGitItems<string>;
}

export type RootWorktreeGateResult =
  | {
    kind: "valid";
    repositoryIdentity: string;
    branch: string;
    headRevision: string;
    isClean: boolean;
    changedPaths: string[];
  }
  | {
    kind: "fresh_missing";
    repositoryIdentity: string;
    baseBranch: string;
    baseRevision: string;
  }
  | {
    kind: "recoverable_missing";
    repositoryIdentity: string;
    branch: string;
    headRevision: string;
  }
  | {
    kind: "execution_generation_invalid";
    repositoryIdentity: string;
    expectedBranch: string;
    reason: "worktree_identity_conflict" | "branch_missing" | "required_commit_unreachable" | "git_evidence_incomplete";
  };

export type RootWorktreeGateInspection =
  | {
    result: Extract<RootWorktreeGateResult, { kind: "valid" }>;
    workspace: GitWorkspace;
    snapshot: GitWorkspaceSnapshot;
  }
  | {
    result: Exclude<RootWorktreeGateResult, { kind: "valid" }>;
  };

export type ValidRootWorktreeGateInspection = Extract<RootWorktreeGateInspection, { workspace: GitWorkspace }>;

export interface GitWorkspaceInterface {
  inspect(workspace: GitWorkspace): Promise<GitWorkspaceSnapshot>;
  diff(workspace: GitWorkspace, options?: { staged?: boolean; path?: string; fromRevision?: string; toRevision?: string }): Promise<{ text: string; bytes: number; cap: number; partial: boolean }>;
  restoreWorktree(workspace: GitWorkspace, expectedHead: string): Promise<{ kind: "restored" }>;
  checks(workspace: GitWorkspace, names: string[]): Promise<BoundedGitItems<{ name: string; status: "passed" | "failed" }>>;
  commit(input: {
    workspace: GitWorkspace;
    rootIssueId: string;
    issueId: string;
    allowedIssueIds: string[];
    issueIdentifier: string;
    expectedHead: string;
  }): Promise<{ kind: "committed" | "no_changes"; commit: string }>;
}

export interface GitWorkspaceProvisionerInterface {
  inspectRootWorktreeGate(input: {
    repositoryIdentity: string;
    rootIssueId: string;
    rootIdentifier: string;
    baseBranch: string;
    executionKind: "fresh" | "existing";
    requiredRevisions: string[];
  }): Promise<RootWorktreeGateInspection>;
  materializeRootWorkspace(input: {
    repositoryIdentity: string;
    rootIssueId: string;
    rootIdentifier: string;
    baseBranch: string;
    expectedGate: Extract<RootWorktreeGateResult, { kind: "fresh_missing" | "recoverable_missing" }>;
  }): Promise<ValidRootWorktreeGateInspection>;
  readCommitUrl(input: {
    workspace: GitWorkspace;
    revision: string;
  }): Promise<string>;
}

export interface GitWorktreeCleanupInput {
  workspace: GitWorkspace;
  terminal: boolean;
  explicitlyAuthorized: boolean;
  hasLiveWriter: boolean;
  hasActivePermit: boolean;
  deliveryProven: boolean;
}

export interface GitWorktreeCleanupInterface {
  cleanup(input: GitWorktreeCleanupInput): Promise<{ kind: "removed" }>;
}
