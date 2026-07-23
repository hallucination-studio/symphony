import { startTargetProductionBoundary } from "./target-workflow-production.mjs";
import { runTargetRestartRecoveryScenario } from "./target-workflow-restart.mjs";
import {
  createTargetWorkflowDeadline,
  remainingTargetWorkflowTimeout,
  TARGET_E2E_TIMEOUT_MS,
  withTargetWorkflowDeadline,
} from "./target-workflow-deadline.mjs";

export async function runTargetRestartBoundary({
  startBoundary = startTargetProductionBoundary,
  runRestart = runTargetRestartRecoveryScenario,
  boundaryInput,
  restartInput,
  now = Date.now,
} = {}) {
  if (typeof startBoundary !== "function" || typeof runRestart !== "function") {
    throw new Error("target_restart_boundary_dependency_invalid");
  }
  const deadlineAtMs = restartInput?.deadlineAtMs ?? boundaryInput?.deadlineAtMs ??
    createTargetWorkflowDeadline(TARGET_E2E_TIMEOUT_MS, now);
  const boundary = await withTargetWorkflowDeadline(
    () => startBoundary({ ...boundaryInput, deadlineAtMs }), deadlineAtMs, { now },
  );
  if (typeof boundary?.runner === "undefined" || typeof boundary?.restart !== "function" ||
      typeof boundary?.close !== "function") {
    throw new Error("target_restart_boundary_invalid");
  }
  let result;
  let failure;
  let closePromise;
  const closeBoundary = (options) => closePromise ??= Promise.resolve().then(() => boundary.close(options));
  try {
    const run = () => runRestart({
      ...restartInput,
      timeoutMs: remainingTargetWorkflowTimeout(deadlineAtMs, now),
      runner: boundary.runner,
      boundary,
    });
    result = await withTargetWorkflowDeadline(run, deadlineAtMs, {
      now, onTimeout: () => closeBoundary({ force: true }),
    });
  } catch (error) {
    failure = error;
  }
  try {
    await closeBoundary();
  } catch {
    if (!failure) throw new Error("target_restart_cleanup_failed");
  }
  if (failure) throw failure;
  return result;
}
