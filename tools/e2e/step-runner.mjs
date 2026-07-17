export class StepTimeoutError extends Error {
  constructor(stepId, deadlineMs) {
    super("step_timeout");
    this.name = "StepTimeoutError";
    this.stepId = stepId;
    this.deadlineMs = deadlineMs;
  }
}

export class StepRunner {
  #stopped = false;

  constructor({ evidence, now = () => new Date().toISOString() }) {
    this.evidence = evidence;
    this.now = now;
  }

  async run(step) {
    if (this.#stopped) throw new Error("step_runner_stopped");
    const startedAt = this.now();
    try {
      const observation = await withDeadline(step.invoke(), step.id, step.deadlineMs);
      if (step.expect && !step.expect(observation)) throw new Error("step_expectation_failed");
      this.evidence.push({
        id: step.id,
        status: "passed",
        startedAt,
        finishedAt: this.now(),
        expected: step.expectedObservation,
        observation: sanitizeObservation(observation),
      });
      return observation;
    } catch (error) {
      this.#stopped = true;
      this.evidence.push({
        id: step.id,
        status: "failed",
        startedAt,
        finishedAt: this.now(),
        expected: step.expectedObservation,
        reason: sanitizedReason(error),
      });
      throw error;
    }
  }
}

async function withDeadline(promise, stepId, deadlineMs) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    throw new Error("step_deadline_invalid");
  }
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new StepTimeoutError(stepId, deadlineMs)),
          deadlineMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeObservation(value) {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeObservation);
  if (typeof value !== "object") return "unserializable_observation";
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /secret|token|password|api.?key|credential/i.test(key) ? "redacted" : sanitizeObservation(item)]));
}

function sanitizedReason(error) {
  if (error instanceof StepTimeoutError) return "step_timeout";
  if (error instanceof Error && /^[a-z][a-z0-9_]{1,120}$/u.test(error.message)) return error.message;
  return "step_failed";
}
