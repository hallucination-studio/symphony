interface Correlation {
  turnId: string;
  rootIssueId: string;
  workIssueId?: string;
  performerProfileId: string;
  turnInputHash: string;
}

export async function applyCorrelatedTurnResult(input: {
  command: Correlation;
  result: Correlation;
  latest: {
    rootState: "Todo" | "In Progress" | "In Review" | "Done" | "Canceled";
    conductorIdMatches: boolean;
    projectStillResolved: boolean;
    turnInputHash: string;
  };
  applyLinear: () => Promise<
    | { kind: "applied" | "already_applied" }
    | { kind: "conflict" }
    | { kind: "failed"; sanitizedReason: string }
  >;
}) {
  const correlationError = compareCorrelation(input.command, input.result);
  if (correlationError) return { kind: "stale", reason: correlationError } as const;
  if (input.latest.rootState === "Done" || input.latest.rootState === "Canceled") {
    return { kind: "stale", reason: "root_terminal" } as const;
  }
  if (!input.latest.conductorIdMatches) {
    return { kind: "stale", reason: "root_ownership_changed" } as const;
  }
  if (!input.latest.projectStillResolved) {
    return { kind: "stale", reason: "project_resolution_changed" } as const;
  }
  if (input.latest.turnInputHash !== input.command.turnInputHash) {
    return { kind: "stale", reason: "turn_input_changed" } as const;
  }
  let applied;
  try {
    applied = await input.applyLinear();
  } catch (error) {
    return { kind: "blocked", reason: sanitize(error) } as const;
  }
  if (applied.kind === "applied" || applied.kind === "already_applied") {
    return { kind: "applied" } as const;
  }
  if (applied.kind === "conflict") {
    return { kind: "stale", reason: "linear_precondition_conflict" } as const;
  }
  if (applied.kind === "failed") {
    return { kind: "blocked", reason: applied.sanitizedReason } as const;
  }
  throw new Error("linear_result_unreachable");
}

export interface UsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  lastUsageTurnId?: string;
}

export function accumulateUsage(
  current: UsageTotals,
  turnId: string,
  observed: Omit<UsageTotals, "lastUsageTurnId">,
): UsageTotals {
  if (current.lastUsageTurnId === turnId) return current;
  return {
    inputTokens: current.inputTokens + observed.inputTokens,
    cachedInputTokens: current.cachedInputTokens + observed.cachedInputTokens,
    outputTokens: current.outputTokens + observed.outputTokens,
    reasoningOutputTokens:
      current.reasoningOutputTokens + observed.reasoningOutputTokens,
    totalTokens: current.totalTokens + observed.totalTokens,
    lastUsageTurnId: turnId,
  };
}

function compareCorrelation(command: Correlation, result: Correlation) {
  if (command.turnId !== result.turnId) return "turn_id_mismatch";
  if (command.rootIssueId !== result.rootIssueId) return "root_issue_mismatch";
  if (command.workIssueId !== result.workIssueId) return "work_issue_mismatch";
  if (command.performerProfileId !== result.performerProfileId) {
    return "performer_profile_mismatch";
  }
  if (command.turnInputHash !== result.turnInputHash) return "turn_input_mismatch";
  return undefined;
}

function sanitize(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\s+/g, " ")
    .slice(0, 2048);
}
