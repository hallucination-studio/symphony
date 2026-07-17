export async function executeLinearMutation({
  maxAttempts,
  baseDelayMs,
  maxDelayMs = baseDelayMs * 16,
  sleep,
  mutate,
  readBack,
  matches,
  refresh = async () => {},
  writeSanitizedComment = async () => {},
  stop = async () => {},
}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error("linear_attempts_invalid");
  let lastReason = "linear_mutation_failed";
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      await mutate();
      const value = await readBack();
      if (matches(value)) return { status: "succeeded", attempts: attempt, value };
      lastReason = "linear_mutation_read_back_failed";
    } catch (error) {
      lastReason = retryReason(error);
      if (!isRetryableLinearError(error)) break;
      if (error?.code === "linear_precondition_conflict") await refresh();
    }
    if (attempt < maxAttempts) await sleep(Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1))));
  }
  const reason = "linear_mutation_attempts_exhausted";
  await writeSanitizedComment({
    marker: "[E2E Diagnostic]",
    reason,
    attempts,
    lastReason,
    nextAction: "Resolve the Linear mutation problem and rerun the scenario.",
  });
  await stop(reason);
  return { status: "blocked", attempts, reason };
}

export function isRetryableLinearError(error) {
  return error?.code === "linear_precondition_conflict" || [408, 425, 429, 500, 502, 503, 504].includes(error?.status);
}

function retryReason(error) {
  if (error?.code === "linear_precondition_conflict") return error.code;
  if (isRetryableLinearError(error)) return "linear_transient_failure";
  return "linear_mutation_failed";
}
