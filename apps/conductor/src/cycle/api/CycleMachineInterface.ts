import type {
  CycleAdvanceRequest,
  CycleAdvanceResult,
} from "../../contracts/cycle.js";

export interface CycleMachineInterface {
  advance(request: CycleAdvanceRequest): Promise<CycleAdvanceResult>;
}
