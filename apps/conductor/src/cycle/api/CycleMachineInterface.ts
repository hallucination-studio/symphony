import type {
  CycleAdvanceRequest,
  CycleAdvanceResult,
} from "../../contracts/cycle.js";

export interface CycleMachineExecution {
  readonly ownership: "live" | "lost";
  readonly closure?: "admission_lost";
}

export interface CycleMachineInterface {
  advance(
    request: CycleAdvanceRequest,
    execution: CycleMachineExecution,
  ): Promise<CycleAdvanceResult>;
}
