export type ConvergenceTriggerInput =
  | "none"
  | "root_canceled"
  | "deadline_exceeded"
  | "max_cycles_per_root"
  | "max_same_open_finding_cycles"
  | "max_cycle_repair_attempts";

export interface RootConvergencePolicyValues {
  maxCyclesPerRoot: number;
  maxSameOpenFindingCycles: number;
  maxCycleRepairAttempts: number;
}

export interface RootConvergencePolicySnapshot extends RootConvergencePolicyValues {
  deadlineAt: string;
}

export interface RootConvergenceView {
  cycleCount: number;
  openFindingPersistence: Array<{ findingId: string; openCycleCount: number }>;
  activeCycleIssueId?: string;
  activeCycleRepairAttempts: number;
  isDeadlineExceeded: boolean;
  rootIsCanceled: boolean;
}
