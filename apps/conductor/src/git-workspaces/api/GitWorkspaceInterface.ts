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

export interface GitWorkspaceInterface {
  inspect(workspace: GitWorkspace): Promise<GitWorkspaceSnapshot>;
  diff(workspace: GitWorkspace, options?: { staged?: boolean; path?: string }): Promise<{ text: string; bytes: number; cap: number; partial: boolean }>;
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
