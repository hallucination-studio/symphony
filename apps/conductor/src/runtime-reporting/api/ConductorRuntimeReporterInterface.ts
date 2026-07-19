export type RuntimeProblemScope =
  | "application" | "binding" | "root" | "turn" | "profile" | "workspace";

export interface RuntimeProblemInput {
  code: string;
  scope: RuntimeProblemScope;
  severity: "warning" | "error";
  reason: string;
  actionRequired?: string;
  rootIssueId?: string;
  turnId?: string;
  performerProfileId?: string;
}

export interface ConductorRuntimeReporterInterface {
  problem(input: RuntimeProblemInput): Promise<void>;
}
