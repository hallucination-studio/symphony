import { startTargetProductionBoundary } from "./target-workflow-production.mjs";
import { runTargetDeliveryScenario } from "./target-workflow-delivery.mjs";
import { runTargetSuccessScenario } from "./target-workflow-success.mjs";

const TARGET_E2E_TIMEOUT_MS = 5 * 60_000;

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
  const effectiveDeadlineAtMs = deadlineAtMs ?? now() + TARGET_E2E_TIMEOUT_MS;
  if (!Number.isSafeInteger(effectiveDeadlineAtMs)) throw new Error("target_delivery_deadline_invalid");
  const boundary = await startBoundary(boundaryInput);
  if (typeof boundary?.runner === "undefined" || typeof boundary?.close !== "function") {
    throw new Error("target_delivery_boundary_invalid");
  }
  let result;
  let failure;
  try {
    const success = await runSuccess({
      ...successInput,
      timeoutMs: remainingTimeout(effectiveDeadlineAtMs, now),
      runner: boundary.runner,
    });
    const resolvedDeliveryInput = typeof deliveryInput === "function"
      ? await deliveryInput({ success, runner: boundary.runner })
      : deliveryInput;
    const delivery = await runDelivery({
      ...resolvedDeliveryInput,
      timeoutMs: remainingTimeout(effectiveDeadlineAtMs, now),
      runner: boundary.runner,
    });
    result = { success, delivery };
  } catch (error) {
    failure = error;
  }
  try {
    await boundary.close();
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
