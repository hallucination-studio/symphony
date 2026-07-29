export interface RootStateRequirement {
  objective: string;
  requestedScope: string;
  constraints: readonly string[];
  acceptanceCriteria: readonly string[];
}
