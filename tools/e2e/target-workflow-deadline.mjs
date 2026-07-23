export const TARGET_E2E_TIMEOUT_MS = 5 * 60_000;
export const ROOT_WORKFLOW_DEADLINE_RESERVE_MS = 5_000;

export function createTargetWorkflowDeadline(timeoutMs, now = Date.now) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TARGET_E2E_TIMEOUT_MS ||
      typeof now !== "function") {
    throw stableError("target_live_timeout_invalid");
  }
  return now() + timeoutMs;
}

export function remainingTargetWorkflowTimeout(deadlineAtMs, now = Date.now) {
  if (!Number.isSafeInteger(deadlineAtMs) || typeof now !== "function") {
    throw stableError("target_live_timeout_invalid");
  }
  const remaining = Math.min(TARGET_E2E_TIMEOUT_MS, deadlineAtMs - now());
  if (remaining <= 0) throw stableError("target_live_timeout");
  return remaining;
}

export function createTargetWorkflowRequestSignal(parentSignal, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TARGET_E2E_TIMEOUT_MS) {
    throw stableError("target_live_request_timeout_invalid");
  }
  const requestSignal = AbortSignal.timeout(timeoutMs);
  return parentSignal ? AbortSignal.any([parentSignal, requestSignal]) : requestSignal;
}

export function rootWorkflowDeadlineAt(deadlineAtMs, now = Date.now) {
  if (!Number.isSafeInteger(deadlineAtMs) || typeof now !== "function") {
    throw stableError("target_live_deadline_invalid");
  }
  const reservedDeadline = deadlineAtMs - ROOT_WORKFLOW_DEADLINE_RESERVE_MS;
  if (!Number.isFinite(reservedDeadline)) throw stableError("target_live_deadline_invalid");
  return new Date(reservedDeadline).toISOString();
}

export async function withTargetWorkflowDeadline(operation, deadlineAtMs, options = {}) {
  if (typeof operation !== "function") throw stableError("target_live_deadline_operation_invalid");
  const now = options.now ?? Date.now;
  const errorCode = options.errorCode ?? "target_live_timeout";
  const onTimeout = options.onTimeout;
  if (onTimeout !== undefined && typeof onTimeout !== "function") {
    throw stableError("target_live_deadline_callback_invalid");
  }
  const remaining = remainingTargetWorkflowTimeout(deadlineAtMs, now);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = stableError(errorCode);
          if (onTimeout) Promise.resolve().then(() => onTimeout(error)).catch(() => {});
          reject(error);
        }, remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
