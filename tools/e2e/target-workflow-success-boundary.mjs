import { startTargetProductionBoundary } from "./target-workflow-production.mjs";
import { runTargetSuccessScenario } from "./target-workflow-success.mjs";
import {
  createTargetWorkflowDeadline,
  remainingTargetWorkflowTimeout,
  TARGET_E2E_TIMEOUT_MS,
  withTargetWorkflowDeadline,
} from "./target-workflow-deadline.mjs";

export async function runTargetSuccessBoundary({
  startBoundary = startTargetProductionBoundary,
  runSuccess = runTargetSuccessScenario,
  boundaryInput,
  successInput,
  now = Date.now,
} = {}) {
  if (typeof startBoundary !== "function" || typeof runSuccess !== "function") {
    throw new Error("target_success_boundary_dependency_invalid");
  }
  const deadlineAtMs = successInput?.deadlineAtMs ?? boundaryInput?.deadlineAtMs ??
    createTargetWorkflowDeadline(TARGET_E2E_TIMEOUT_MS, now);
  const boundary = await withTargetWorkflowDeadline(
    () => startBoundary({ ...boundaryInput, deadlineAtMs }), deadlineAtMs, { now },
  );
  if (typeof boundary?.close !== "function") throw new Error("target_success_boundary_invalid");
  let result;
  let failure;
  let closePromise;
  const closeBoundary = (options) => closePromise ??= Promise.resolve().then(() => boundary.close(options));
  try {
    const run = () => runSuccess({
      ...successInput,
      timeoutMs: remainingTargetWorkflowTimeout(deadlineAtMs, now),
      runner: boundary.runner,
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
    if (!failure) throw new Error("target_success_cleanup_failed");
  }
  if (failure) throw failure;
  return result;
}
