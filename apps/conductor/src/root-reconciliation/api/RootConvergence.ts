export type ConvergenceTriggerInput =
  | "none"
  | "root_canceled"
  | "deadline_exceeded"
  | "max_cycles_per_root"
  | "max_same_open_finding_cycles"
  | "max_consecutive_no_progress"
  | "max_cycle_repair_attempts";

export interface RootConvergencePolicyValues {
  maxCyclesPerRoot: number;
  maxSameOpenFindingCycles: number;
  maxConsecutiveNoProgress: number;
  maxCycleRepairAttempts: number;
}

export interface RootConvergencePolicySnapshot extends RootConvergencePolicyValues {
  deadlineAt: string;
}

export interface RootConvergenceView {
  cycleCount: number;
  openFindingPersistence: Array<{ findingId: string; openCycleCount: number }>;
  consecutiveNoProgress: number;
  activeCycleIssueId?: string;
  activeCycleRepairAttempts: number;
  isDeadlineExceeded: boolean;
  rootIsCanceled: boolean;
}
