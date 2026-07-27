export interface ClassifiedLinearFailure {
  code: string;
  sanitizedReason: string;
  retryable: boolean;
  ambiguous: boolean;
}

const OFFICIAL_LINEAR_FAILURES = new Map<string, ClassifiedLinearFailure>([
  [
    "RatelimitedLinearError",
    {
      code: "linear_rate_limited",
      sanitizedReason: "Linear rate limit exceeded.",
      retryable: true,
      ambiguous: false,
    },
  ],
  [
    "NetworkLinearError",
    {
      code: "linear_network_failed",
      sanitizedReason: "Linear network request failed.",
      retryable: true,
      ambiguous: true,
    },
  ],
  [
    "InternalLinearError",
    {
      code: "linear_internal_failed",
      sanitizedReason: "Linear internal request failed.",
      retryable: true,
      ambiguous: true,
    },
  ],
  [
    "UnknownLinearError",
    {
      code: "linear_unknown_failed",
      sanitizedReason: "Linear request failed.",
      retryable: true,
      ambiguous: true,
    },
  ],
]);

export function classifyLinearFailure(error: unknown): ClassifiedLinearFailure | undefined {
  return error instanceof Error ? OFFICIAL_LINEAR_FAILURES.get(error.constructor.name) : undefined;
}
