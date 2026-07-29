import assert from "node:assert/strict";
import test from "node:test";

import type {
  PlanHandoff,
  PlanRequest,
  VerifyHandoff,
  VerifyRequest,
  WorkHandoff,
  WorkRequest,
} from "../../contracts/stage-interaction.js";
import type { StagePerformerInterface } from "./StagePerformerInterface.js";

const performer = {
  executePlan(request: PlanRequest): Promise<PlanHandoff> {
    return Promise.resolve({
      ...request,
      plan_issue_id: "LIN-3" as PlanHandoff["plan_issue_id"],
      work_issue_ids: [],
      verify_issue_id: "LIN-4" as PlanHandoff["verify_issue_id"],
      outcome: "canceled",
    });
  },
  executeWork(request: WorkRequest): Promise<WorkHandoff> {
    return Promise.resolve({ ...request, outcome: "canceled", workspace_changed: false });
  },
  executeVerify(request: VerifyRequest): Promise<VerifyHandoff> {
    return Promise.resolve({ ...request, conclusion: "inconclusive" });
  },
  closeCycle(): Promise<void> { return Promise.resolve(); },
} satisfies StagePerformerInterface;

test("Stage Performer methods preserve compile-time role isolation", () => {
  assert.equal(typeof performer.executePlan, "function");
  assert.equal(typeof performer.executeWork, "function");
  assert.equal(typeof performer.executeVerify, "function");
  assert.deepEqual(Object.keys(performer).sort(), ["closeCycle", "executePlan", "executeVerify", "executeWork"]);
});
