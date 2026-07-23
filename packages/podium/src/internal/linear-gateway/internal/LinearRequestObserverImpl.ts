import type {
  LinearPhysicalRequestObservation,
  LinearRequestWindowObservation,
} from "./LinearSdkImpl.js";

export interface LinearRequestObservationSnapshot {
  logicalOperations: number;
  physicalRequests: number;
  complexityConsumed: number;
  requestWindow?: LinearRequestWindowObservation;
  complexityWindow?: LinearRequestWindowObservation;
  rateLimited: boolean;
}

export type LinearRateLimitListener = () => void;

/** Records upstream facts for evidence; it never decides whether a request may run. */
export class LinearRequestObserverImpl {
  #requestWindow: LinearRequestWindowObservation | undefined;
  #complexityWindow: LinearRequestWindowObservation | undefined;
  #complexityBaselineRemaining: number | undefined;
  #minimumComplexityRemaining: number | undefined;
  #logicalOperations = 0;
  #physicalRequests = 0;
  #complexityConsumed = 0;
  #rateLimited = false;
  #rateLimitListeners = new Set<LinearRateLimitListener>();

  onRateLimited(listener: LinearRateLimitListener): () => void {
    if (this.#rateLimited) {
      listener();
      return () => {};
    }
    this.#rateLimitListeners.add(listener);
    return () => this.#rateLimitListeners.delete(listener);
  }

  observe(observation: Pick<LinearPhysicalRequestObservation, "status" | "requestWindow" | "complexityWindow">): void {
    this.#physicalRequests += 1;
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
    if (observation.status === 429 && !this.#rateLimited) {
      this.#rateLimited = true;
      const listeners = [...this.#rateLimitListeners];
      this.#rateLimitListeners.clear();
      for (const listener of listeners) listener();
    }
  }

  recordLogicalOperation(): void {
    this.#logicalOperations += 1;
  }

  snapshot(): LinearRequestObservationSnapshot {
    return {
      logicalOperations: this.#logicalOperations,
      physicalRequests: this.#physicalRequests,
      complexityConsumed: this.#complexityConsumed,
      ...(this.#requestWindow ? { requestWindow: { ...this.#requestWindow } } : {}),
      ...(this.#complexityWindow ? { complexityWindow: { ...this.#complexityWindow } } : {}),
      rateLimited: this.#rateLimited,
    };
  }
}
