import type {
  PlanHandoff,
  PlanRequest,
  VerifyHandoff,
  VerifyRequest,
  WorkHandoff,
  WorkRequest,
} from "../../contracts/stage-interaction.js";

export interface StagePerformerInterface {
  executePlan(request: PlanRequest): Promise<PlanHandoff>;
  executeWork(request: WorkRequest): Promise<WorkHandoff>;
  executeVerify(request: VerifyRequest): Promise<VerifyHandoff>;
  closeCycle(rootId: PlanRequest["root_id"], cycleId: PlanRequest["cycle_issue_id"]): Promise<void>;
}
