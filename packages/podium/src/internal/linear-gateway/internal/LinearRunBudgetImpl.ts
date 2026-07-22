import type {
  LinearPhysicalRequestObservation,
  LinearRequestWindowObservation,
} from "./LinearSdkImpl.js";

const DEFAULT_MAX_REQUESTS = 400;
const DEFAULT_MAX_COMPLEXITY = 100_000;
const DEFAULT_PHYSICAL_REQUEST_COMPLEXITY = 10_000;
const DEFAULT_CONSUMPTION_FRACTION = 0.4;

export interface LinearRunBudgetSnapshot {
  logicalOperations: number;
  physicalRequests: number;
  reservedRequests: number;
  reservedComplexity: number;
  complexityConsumed: number;
  requestWindow?: LinearRequestWindowObservation;
  complexityWindow?: LinearRequestWindowObservation;
  rateLimited: boolean;
}

export interface LinearRunBudgetReservation {
  release(): void;
}

export class LinearRunBudgetImpl {
  readonly #maxRequests: number;
  readonly #maxComplexity: number;
  readonly #physicalRequestComplexity: number;
  readonly #consumptionFraction: number;
  readonly #now: () => number;
  #requestWindow: LinearRequestWindowObservation | undefined;
  #complexityWindow: LinearRequestWindowObservation | undefined;
  #complexityBaselineRemaining: number | undefined;
  #minimumComplexityRemaining: number | undefined;
  #logicalOperations = 0;
  #physicalRequests = 0;
  #reservedRequests = 0;
  #reservedComplexity = 0;
  #complexityConsumed = 0;
  #rateLimitedUntilMs = 0;
  readonly #physicalReservations: Array<LinearRunBudgetReservation> = [];

  constructor(options: {
    maxRequests?: number;
    maxComplexity?: number;
    physicalRequestComplexity?: number;
    consumptionFraction?: number;
    now?: () => number;
  } = {}) {
    this.#maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.#maxComplexity = options.maxComplexity ?? DEFAULT_MAX_COMPLEXITY;
    this.#physicalRequestComplexity = options.physicalRequestComplexity ?? DEFAULT_PHYSICAL_REQUEST_COMPLEXITY;
    this.#consumptionFraction = options.consumptionFraction ?? DEFAULT_CONSUMPTION_FRACTION;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#maxRequests) || this.#maxRequests < 1 ||
        this.#maxRequests > DEFAULT_MAX_REQUESTS ||
        !Number.isSafeInteger(this.#maxComplexity) || this.#maxComplexity < 1 ||
        !Number.isSafeInteger(this.#physicalRequestComplexity) || this.#physicalRequestComplexity < 0 ||
        this.#physicalRequestComplexity > this.#maxComplexity ||
        !isFraction(this.#consumptionFraction)) {
      throw new Error("linear_run_budget_invalid");
    }
  }

  observe(observation: Pick<LinearPhysicalRequestObservation, "status" | "requestWindow" | "complexityWindow">): void {
    this.#physicalRequests += 1;
    this.#physicalReservations.shift()?.release();
    if (observation.requestWindow) this.#requestWindow = { ...observation.requestWindow };
    if (observation.complexityWindow) {
      const remaining = observation.complexityWindow.remaining;
      if (remaining !== undefined) {
        if (observation.complexityWindow.limit === remaining) {
          this.#complexityBaselineRemaining = remaining;
          this.#minimumComplexityRemaining = remaining;
          this.#complexityConsumed = 0;
        } else if (this.#complexityBaselineRemaining === undefined) {
          this.#complexityBaselineRemaining = remaining;
          this.#minimumComplexityRemaining = remaining;
        } else {
          this.#minimumComplexityRemaining = Math.min(this.#minimumComplexityRemaining ?? remaining, remaining);
          this.#complexityConsumed = Math.max(
            this.#complexityConsumed,
            this.#complexityBaselineRemaining - this.#minimumComplexityRemaining,
          );
        }
      }
      this.#complexityWindow = { ...observation.complexityWindow };
    }
    if (observation.status === 429) {
      const reset = observation.requestWindow?.reset ?? observation.complexityWindow?.reset;
      this.#rateLimitedUntilMs = rateLimitDeadlineMs(reset, this.#now());
    }
  }

  recordLogicalOperation(): void {
    this.#logicalOperations += 1;
  }

  reservePhysicalRequest(): LinearRunBudgetReservation {
    return this.reserve({ requests: 1, complexity: this.#physicalRequestComplexity });
  }

  permitPhysicalRequest(): void {
    this.#physicalReservations.push(this.reservePhysicalRequest());
  }

  reserve(cost: { requests: number; complexity: number }): LinearRunBudgetReservation {
    if (!Number.isSafeInteger(cost.requests) || cost.requests < 1 ||
        !Number.isSafeInteger(cost.complexity) || cost.complexity < 0) {
      throw new Error("linear_run_budget_cost_invalid");
    }
    if (this.#now() < this.#rateLimitedUntilMs) throw new Error("linear_run_rate_limited");
    if (cost.requests > this.#requestCapacity() || cost.complexity > this.#complexityCapacity()) {
      throw new Error("linear_run_budget_exhausted");
    }
    this.#reservedRequests += cost.requests;
    this.#reservedComplexity += cost.complexity;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#reservedRequests -= cost.requests;
        this.#reservedComplexity -= cost.complexity;
      },
    };
  }

  snapshot(): LinearRunBudgetSnapshot {
    return {
      logicalOperations: this.#logicalOperations,
      physicalRequests: this.#physicalRequests,
      reservedRequests: this.#reservedRequests,
      reservedComplexity: this.#reservedComplexity,
      complexityConsumed: this.#complexityConsumed,
      ...(this.#requestWindow ? { requestWindow: { ...this.#requestWindow } } : {}),
      ...(this.#complexityWindow ? { complexityWindow: { ...this.#complexityWindow } } : {}),
      rateLimited: this.#now() < this.#rateLimitedUntilMs,
    };
  }

  #requestCapacity(): number {
    const configured = Math.min(this.#maxRequests, this.#observedConsumptionCapacity(this.#requestWindow, this.#maxRequests));
    const remaining = this.#requestWindow?.remaining;
    const runCapacity = configured - this.#physicalRequests - this.#reservedRequests;
    const windowCapacity = remaining === undefined
      ? runCapacity
      : remaining - this.#reservedRequests;
    return Math.max(0, Math.min(runCapacity, windowCapacity));
  }

  #complexityCapacity(): number {
    const configured = this.#observedConsumptionCapacity(this.#complexityWindow, this.#maxComplexity);
    const remaining = this.#complexityWindow?.remaining;
    const runCapacity = configured - this.#complexityConsumed - this.#reservedComplexity;
    const windowCapacity = remaining === undefined
      ? runCapacity
      : remaining - this.#reservedComplexity;
    return Math.max(0, Math.min(runCapacity, windowCapacity));
  }

  #observedConsumptionCapacity(window: LinearRequestWindowObservation | undefined, fallback: number): number {
    if (window?.limit === undefined) return fallback;
    return Math.floor(window.limit * this.#consumptionFraction);
  }

}

function rateLimitDeadlineMs(reset: number | undefined, nowMs: number): number {
  if (!Number.isSafeInteger(reset) || reset === undefined) return nowMs;
  if (reset >= 1_000_000_000_000) return reset;
  if (reset >= 1_000_000_000) return reset * 1000;
  return nowMs + reset * 1000;
}

function isFraction(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < 1;
}
