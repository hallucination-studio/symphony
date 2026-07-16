import type {
  GitWorkspace,
  NativeGitWorkspaceImpl,
} from "./NativeGitWorkspaceImpl.js";

export interface WorkCompletionLinearInterface {
  writeCompletedInputHash(input: {
    workIssueId: string;
    completedInputHash: string;
  }): Promise<MutationResult>;
  moveWorkToInReview(workIssueId: string): Promise<MutationResult>;
}

type MutationResult = {
  kind: "applied" | "already_applied" | "conflict" | "failed";
  sanitizedReason?: string;
};

export class WorkCompletionUseCase {
  constructor(
    private readonly git: Pick<NativeGitWorkspaceImpl, "commitWork">,
    private readonly linear: WorkCompletionLinearInterface,
  ) {}

  async execute(input: {
    workspace: GitWorkspace;
    workIssueId: string;
    commitMessage: string;
    completedInputHash: string;
    latestCompletedInputHash?: string;
  }) {
    try {
      if (input.latestCompletedInputHash !== input.completedInputHash) {
        await this.git.commitWork(input.workspace, input.commitMessage);
        const metadata = await this.linear.writeCompletedInputHash({
          workIssueId: input.workIssueId,
          completedInputHash: input.completedInputHash,
        });
        const failure = failedMutation(metadata);
        if (failure) return failure;
      }
      const state = await this.linear.moveWorkToInReview(input.workIssueId);
      const failure = failedMutation(state);
      return failure ?? ({ kind: "completed" } as const);
    } catch (error) {
      return { kind: "blocked", reason: sanitize(error) } as const;
    }
  }
}

function sanitize(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\s+/g, " ")
    .slice(0, 2048);
}

function failedMutation(result: MutationResult) {
  if (result.kind === "applied" || result.kind === "already_applied") {
    return undefined;
  }
  return {
    kind: result.kind === "conflict" ? "stale" : "blocked",
    reason:
      result.sanitizedReason ??
      (result.kind === "conflict"
        ? "linear_precondition_conflict"
        : "linear_mutation_failed"),
  } as const;
}
