import type { CanonicalFactInput, CanonicalObservation } from "./CanonicalFact.js";

export type RootStateRecoveryFailureCategory = "linear" | "git" | "coverage" | "schema" | "transport";

export interface RootStateRecoveryFailure {
  code: string;
  category: RootStateRecoveryFailureCategory;
  retryable: boolean;
}

export type RootStateFactReadResult =
  | { kind: "complete"; facts: readonly CanonicalFactInput[] }
  | { kind: "incomplete"; omissions: readonly { sourceId: string; reason: string }[] }
  | { kind: "failed"; failure: RootStateRecoveryFailure };

export interface RootStateRecoverySourceInterface {
  readLinearRootFacts(rootIssueId: string): Promise<RootStateFactReadResult>;
  readGitRootFacts(rootIssueId: string): Promise<RootStateFactReadResult>;
}

export interface RecoveredRootState {
  rootIssueId: string;
  contentDigest: string;
  observation: CanonicalObservation;
}

export type RootStateRecoveryResult =
  | { kind: "recovered"; state: RecoveredRootState }
  | { kind: "failed"; failure: RootStateRecoveryFailure };

export interface RootStateRecoveryInterface {
  recover(rootIssueId: string): Promise<RootStateRecoveryResult>;
}
