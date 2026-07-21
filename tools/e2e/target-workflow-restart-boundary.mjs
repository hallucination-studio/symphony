import { startTargetProductionBoundary } from "./target-workflow-production.mjs";
import { runTargetRestartRecoveryScenario } from "./target-workflow-restart.mjs";

export async function runTargetRestartBoundary({
  startBoundary = startTargetProductionBoundary,
  runRestart = runTargetRestartRecoveryScenario,
  boundaryInput,
  restartInput,
} = {}) {
  if (typeof startBoundary !== "function" || typeof runRestart !== "function") {
    throw new Error("target_restart_boundary_dependency_invalid");
  }
  const boundary = await startBoundary(boundaryInput);
  if (typeof boundary?.runner === "undefined" || typeof boundary?.restart !== "function" ||
      typeof boundary?.close !== "function") {
    throw new Error("target_restart_boundary_invalid");
  }
  let result;
  let failure;
  try {
    result = await runRestart({ ...restartInput, runner: boundary.runner, boundary });
  } catch (error) {
    failure = error;
  }
  try {
    await boundary.close();
  } catch {
    if (!failure) throw new Error("target_restart_cleanup_failed");
  }
  if (failure) throw failure;
  return result;
}
