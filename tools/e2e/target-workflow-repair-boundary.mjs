import { startTargetProductionBoundary } from "./target-workflow-production.mjs";
import { runTargetRepairEscalationScenario } from "./target-workflow-repair.mjs";

export async function runTargetRepairBoundary({
  startBoundary = startTargetProductionBoundary,
  runRepair = runTargetRepairEscalationScenario,
  boundaryInput,
  repairInput,
} = {}) {
  if (typeof startBoundary !== "function" || typeof runRepair !== "function") {
    throw new Error("target_repair_boundary_dependency_invalid");
  }
  const boundary = await startBoundary(boundaryInput);
  if (typeof boundary?.close !== "function") throw new Error("target_repair_boundary_invalid");
  let result;
  let failure;
  try {
    result = await runRepair({ ...repairInput, runner: boundary.runner });
  } catch (error) {
    failure = error;
  }
  try {
    await boundary.close();
  } catch {
    if (!failure) throw new Error("target_repair_cleanup_failed");
  }
  if (failure) throw failure;
  return result;
}
