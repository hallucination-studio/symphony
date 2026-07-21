import { startTargetProductionBoundary } from "./target-workflow-production.mjs";
import { runTargetSuccessScenario } from "./target-workflow-success.mjs";

export async function runTargetSuccessBoundary({
  startBoundary = startTargetProductionBoundary,
  runSuccess = runTargetSuccessScenario,
  boundaryInput,
  successInput,
} = {}) {
  if (typeof startBoundary !== "function" || typeof runSuccess !== "function") {
    throw new Error("target_success_boundary_dependency_invalid");
  }
  const boundary = await startBoundary(boundaryInput);
  if (typeof boundary?.close !== "function") throw new Error("target_success_boundary_invalid");
  let result;
  let failure;
  try {
    result = await runSuccess({ ...successInput, runner: boundary.runner });
  } catch (error) {
    failure = error;
  }
  try {
    await boundary.close();
  } catch {
    if (!failure) throw new Error("target_success_cleanup_failed");
  }
  if (failure) throw failure;
  return result;
}
