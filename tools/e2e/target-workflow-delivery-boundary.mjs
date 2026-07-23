import { startTargetProductionBoundary } from "./target-workflow-production.mjs";
import { runTargetDeliveryScenario } from "./target-workflow-delivery.mjs";
import {
  createTargetWorkflowDeadline,
  remainingTargetWorkflowTimeout,
  TARGET_E2E_TIMEOUT_MS,
  withTargetWorkflowDeadline,
} from "./target-workflow-deadline.mjs";
import { runTargetSuccessScenario } from "./target-workflow-success.mjs";

export async function runTargetDeliveryBoundary({
  startBoundary = startTargetProductionBoundary,
  runSuccess = runTargetSuccessScenario,
  runDelivery = runTargetDeliveryScenario,
  boundaryInput,
  successInput,
  deliveryInput,
  deadlineAtMs,
  now = Date.now,
} = {}) {
  if (typeof startBoundary !== "function" || typeof runSuccess !== "function" || typeof runDelivery !== "function") {
    throw new Error("target_delivery_boundary_dependency_invalid");
  }
  if (typeof now !== "function") throw new Error("target_delivery_deadline_invalid");
  const effectiveDeadlineAtMs = deadlineAtMs ?? createTargetWorkflowDeadline(TARGET_E2E_TIMEOUT_MS, now);
  const boundary = await withTargetWorkflowDeadline(
    () => startBoundary({ ...boundaryInput, deadlineAtMs: effectiveDeadlineAtMs }),
    effectiveDeadlineAtMs,
    { now },
  );
  if (typeof boundary?.runner === "undefined" || typeof boundary?.close !== "function") {
    throw new Error("target_delivery_boundary_invalid");
  }
  let result;
  let failure;
  let closePromise;
  const closeBoundary = (options) => closePromise ??= Promise.resolve().then(() => boundary.close(options));
  try {
    const successTimeoutMs = remainingTimeout(effectiveDeadlineAtMs, now);
    const success = await withTargetWorkflowDeadline(() => runSuccess({
      ...successInput,
      timeoutMs: successTimeoutMs,
      runner: boundary.runner,
    }), effectiveDeadlineAtMs, { now, onTimeout: () => closeBoundary({ force: true }) });
    const resolvedDeliveryInput = typeof deliveryInput === "function"
      ? await deliveryInput({ success, runner: boundary.runner })
      : deliveryInput;
    const deliveryTimeoutMs = remainingTimeout(effectiveDeadlineAtMs, now);
    const delivery = await withTargetWorkflowDeadline(() => runDelivery({
      ...resolvedDeliveryInput,
      timeoutMs: deliveryTimeoutMs,
      runner: boundary.runner,
    }), effectiveDeadlineAtMs, { now, onTimeout: () => closeBoundary({ force: true }) });
    result = { success, delivery };
  } catch (error) {
    failure = error;
  }
  try {
    await closeBoundary();
  } catch {
    if (!failure) throw new Error("target_delivery_cleanup_failed");
  }
  if (failure) throw failure;
  return result;
}

function remainingTimeout(deadlineAtMs, now) {
  if (!Number.isSafeInteger(deadlineAtMs)) throw new Error("target_delivery_deadline_invalid");
  const remaining = deadlineAtMs - now();
  if (remaining <= 0) throw new Error("target_delivery_timeout");
  return remaining;
}
