import type {
  LinearPhysicalRequestObservation,
  LinearRequestWindowObservation,
} from "./LinearSdkImpl.js";

const DEFAULT_MAX_REQUESTS = 400;
const DEFAULT_CONSUMPTION_FRACTION = 0.4;
const DEFAULT_PROTECTED_FRACTION = 0.25;

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
  readonly #consumptionFraction: number;
  readonly #protectedFraction: number;
  readonly #now: () => number;
  #requestWindow: LinearRequestWindowObservation | undefined;
  #complexityWindow: LinearRequestWindowObservation | undefined;
  #previousComplexityRemaining: number | undefined;
  #logicalOperations = 0;
  #physicalRequests = 0;
  #reservedRequests = 0;
  #reservedComplexity = 0;
  #complexityConsumed = 0;
  #rateLimitedUntilMs = 0;

  constructor(options: {
    maxRequests?: number;
    consumptionFraction?: number;
    protectedFraction?: number;
    now?: () => number;
  } = {}) {
    this.#maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.#consumptionFraction = options.consumptionFraction ?? DEFAULT_CONSUMPTION_FRACTION;
    this.#protectedFraction = options.protectedFraction ?? DEFAULT_PROTECTED_FRACTION;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#maxRequests) || this.#maxRequests < 1 ||
        this.#maxRequests > DEFAULT_MAX_REQUESTS ||
        !isFraction(this.#consumptionFraction) || !isFraction(this.#protectedFraction) ||
        this.#consumptionFraction + this.#protectedFraction > 1) {
      throw new Error("linear_run_budget_invalid");
    }
  }

  observe(observation: Pick<LinearPhysicalRequestObservation, "status" | "requestWindow" | "complexityWindow">): void {
    this.#physicalRequests += 1;
    if (observation.requestWindow) this.#requestWindow = { ...observation.requestWindow };
    if (observation.complexityWindow) {
      const remaining = observation.complexityWindow.remaining;
      if (remaining !== undefined && this.#previousComplexityRemaining !== undefined &&
          remaining <= this.#previousComplexityRemaining) {
        this.#complexityConsumed += this.#previousComplexityRemaining - remaining;
      }
      this.#previousComplexityRemaining = remaining ?? this.#previousComplexityRemaining;
      this.#complexityWindow = { ...observation.complexityWindow };
    }
    if (observation.status === 429) {
      const resetSeconds = observation.requestWindow?.reset ?? observation.complexityWindow?.reset ?? 0;
      this.#rateLimitedUntilMs = this.#now() + resetSeconds * 1000;
    }
  }

  recordLogicalOperation(): void {
    this.#logicalOperations += 1;
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
    const configured = Math.min(this.#maxRequests, this.#observedConsumptionCapacity(this.#requestWindow));
    const remaining = this.#requestWindow?.remaining;
    const protectedCapacity = this.#protectedCapacity(this.#requestWindow);
    const observed = remaining === undefined ? configured : Math.max(0, remaining - protectedCapacity);
    return Math.max(0, Math.min(configured, observed) - this.#physicalRequests - this.#reservedRequests);
  }

  #complexityCapacity(): number {
    const configured = this.#observedConsumptionCapacity(this.#complexityWindow);
    const remaining = this.#complexityWindow?.remaining;
    const protectedCapacity = this.#protectedCapacity(this.#complexityWindow);
    const observed = remaining === undefined ? configured : Math.max(0, remaining - protectedCapacity);
    return Math.max(0, observed - this.#complexityConsumed - this.#reservedComplexity);
  }

  #observedConsumptionCapacity(window: LinearRequestWindowObservation | undefined): number {
    if (window?.limit === undefined) return this.#maxRequests;
    return Math.floor(window.limit * this.#consumptionFraction);
  }

  #protectedCapacity(window: LinearRequestWindowObservation | undefined): number {
    if (window?.limit === undefined) return 0;
    return Math.ceil(window.limit * this.#protectedFraction);
  }
}

function isFraction(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < 1;
}
