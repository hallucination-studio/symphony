export function createAdaptivePoller({ baseIntervalMs, maxIntervalMs = 30_000 }) {
  if (!Number.isSafeInteger(baseIntervalMs) || baseIntervalMs < 0 ||
      !Number.isSafeInteger(maxIntervalMs) || maxIntervalMs < baseIntervalMs) {
    throw new Error("target_polling_policy_invalid");
  }
  let previousDigest;
  let intervalMs = baseIntervalMs;

  return Object.freeze({
    observe(value) {
      const digest = value === undefined ? "undefined" : JSON.stringify(value);
      if (previousDigest !== undefined && digest === previousDigest && intervalMs > 0) {
        intervalMs = Math.min(maxIntervalMs, Math.max(baseIntervalMs, intervalMs * 2));
      } else {
        intervalMs = baseIntervalMs;
      }
      previousDigest = digest;
      return intervalMs;
    },
    reset() {
      previousDigest = undefined;
      intervalMs = baseIntervalMs;
    },
  });
}
