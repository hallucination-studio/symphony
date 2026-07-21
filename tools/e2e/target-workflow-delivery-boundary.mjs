import { startTargetProductionBoundary } from "./target-workflow-production.mjs";
import { runTargetDeliveryScenario } from "./target-workflow-delivery.mjs";
import { runTargetSuccessScenario } from "./target-workflow-success.mjs";

export async function runTargetDeliveryBoundary({
  startBoundary = startTargetProductionBoundary,
  runSuccess = runTargetSuccessScenario,
  runDelivery = runTargetDeliveryScenario,
  boundaryInput,
  successInput,
  deliveryInput,
} = {}) {
  if (typeof startBoundary !== "function" || typeof runSuccess !== "function" || typeof runDelivery !== "function") {
    throw new Error("target_delivery_boundary_dependency_invalid");
  }
  const boundary = await startBoundary(boundaryInput);
  if (typeof boundary?.runner === "undefined" || typeof boundary?.close !== "function") {
    throw new Error("target_delivery_boundary_invalid");
  }
  let result;
  let failure;
  try {
    const success = await runSuccess({ ...successInput, runner: boundary.runner });
    const resolvedDeliveryInput = typeof deliveryInput === "function"
      ? await deliveryInput({ success, runner: boundary.runner })
      : deliveryInput;
    const delivery = await runDelivery({ ...resolvedDeliveryInput, runner: boundary.runner });
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
