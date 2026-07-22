import type { LinearRunBudgetImpl } from "./LinearRunBudgetImpl.js";

export type InstallationRequestClass =
  | "control"
  | "workflow"
  | "mutation"
  | "read-back"
  | "background";

interface WindowValue {
  limit?: number;
  remaining?: number;
  reset?: number;
}

interface QueuedRequest<T> {
  requestClass: InstallationRequestClass;
  deadlineAtMs?: number;
  run(): Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason: unknown): void;
}

export class LinearRequestBrokerImpl {
  readonly #queues: Record<InstallationRequestClass, QueuedRequest<unknown>[]> = {
    control: [], workflow: [], mutation: [], "read-back": [], background: [],
  };
  readonly #inFlight = new Map<string, { generation: number; promise: Promise<unknown> }>();
  readonly #maxConcurrent: number;
  readonly #maxHighPriorityBurst: number;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #budget: LinearRunBudgetImpl | undefined;
  readonly #physicalReservations: Array<{ release(): void }> = [];
  #active = 0;
  #highPriorityBurst = 0;
  #generation = 0;
  #requestWindow: WindowValue | undefined;
  #complexityWindow: WindowValue | undefined;

  constructor(options: {
    maxConcurrent: number;
    maxHighPriorityBurst: number;
    budget?: LinearRunBudgetImpl;
    now?: () => number;
    random?: () => number;
  }) {
    if (
      !Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1 ||
      options.maxConcurrent > 32 || !Number.isInteger(options.maxHighPriorityBurst) ||
      options.maxHighPriorityBurst < 1 || options.maxHighPriorityBurst > 32
    ) {
      throw new Error("linear_request_broker_invalid");
    }
    this.#maxConcurrent = options.maxConcurrent;
    this.#maxHighPriorityBurst = options.maxHighPriorityBurst;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#budget = options.budget;
  }

  observe(observation: {
    requestWindow?: WindowValue;
    complexityWindow?: WindowValue;
  }): void {
    this.#budget?.observe(observation);
    this.#physicalReservations.shift()?.release();
    if (observation.requestWindow) this.#requestWindow = { ...observation.requestWindow };
    if (observation.complexityWindow) this.#complexityWindow = { ...observation.complexityWindow };
    this.#drain();
  }

  assertPermit(requestClass: InstallationRequestClass): void {
    if (requestClass === "background" && !this.#backgroundCapacityAvailable()) {
      throw new Error("linear_request_capacity_reserved");
    }
    if (this.#budget) {
      this.#physicalReservations.push(this.#budget.reservePhysicalRequest());
    }
  }

  run<T>(
    requestClass: InstallationRequestClass,
    run: () => Promise<T>,
    options: { deadlineAtMs?: number; coalesceKey?: string } = {},
  ): Promise<T> {
    this.#budget?.recordLogicalOperation();
    if (requestClass === "background" && !this.#backgroundCapacityAvailable()) {
      return Promise.reject(new Error("linear_request_capacity_reserved"));
    }
    if (requestClass === "mutation") {
      this.#generation += 1;
      this.#inFlight.clear();
    }
    const generation = this.#generation;
    const coalesceKey = options.coalesceKey;
    if (coalesceKey && requestClass !== "mutation" && requestClass !== "read-back") {
      const current = this.#inFlight.get(coalesceKey);
      if (current?.generation === generation) return current.promise as Promise<T>;
    }
    const promise = new Promise<T>((resolve, reject) => {
      this.#queues[requestClass].push({
        requestClass, run, resolve, reject,
        ...(options.deadlineAtMs === undefined ? {} : { deadlineAtMs: options.deadlineAtMs }),
      } as QueuedRequest<unknown>);
      this.#drain();
    });
    if (coalesceKey && requestClass !== "mutation" && requestClass !== "read-back") {
      this.#inFlight.set(coalesceKey, { generation, promise });
      void promise.finally(() => {
        const current = this.#inFlight.get(coalesceKey);
        if (current?.promise === promise) this.#inFlight.delete(coalesceKey);
      }).catch(() => undefined);
    }
    return promise;
  }

  retryDelayMs(input: {
    attempt: number;
    retryAfterMs?: number;
    maxDelayMs: number;
  }): number {
    const exponential = Math.min(
      input.maxDelayMs,
      250 * 2 ** Math.max(0, input.attempt - 1),
    );
    const jittered = Math.round(exponential * (0.5 + this.#random() / 2));
    return Math.min(input.maxDelayMs, Math.max(jittered, input.retryAfterMs ?? 0));
  }

  #backgroundCapacityAvailable(): boolean {
    return [this.#requestWindow, this.#complexityWindow].every((window) => {
      if (window?.limit === undefined || window.remaining === undefined) return false;
      return window.remaining > window.limit * 0.75;
    });
  }

  #drain(): void {
    while (this.#active < this.#maxConcurrent) {
      const next = this.#next();
      if (!next) return;
      if (next.deadlineAtMs !== undefined && this.#now() > next.deadlineAtMs) {
        next.reject(new Error("linear_request_budget_exhausted"));
        continue;
      }
      this.#active += 1;
      const remainingMs = next.deadlineAtMs === undefined
        ? undefined : Math.max(0, next.deadlineAtMs - this.#now());
      const deadline = remainingMs === undefined ? undefined : setTimeout(() => {
        next.reject(new Error("linear_request_budget_exhausted"));
      }, remainingMs);
      void next.run().then(next.resolve, next.reject).finally(() => {
        if (deadline) clearTimeout(deadline);
        this.#active -= 1;
        this.#drain();
      });
    }
  }

  #next(): QueuedRequest<unknown> | undefined {
    const workflowWaiting = this.#queues.workflow.length > 0;
    if (workflowWaiting && this.#highPriorityBurst >= this.#maxHighPriorityBurst) {
      this.#highPriorityBurst = 0;
      return this.#queues.workflow.shift();
    }
    for (const requestClass of ["read-back", "mutation", "control"] as const) {
      const request = this.#queues[requestClass].shift();
      if (request) {
        this.#highPriorityBurst += 1;
        return request;
      }
    }
    const workflow = this.#queues.workflow.shift();
    if (workflow) {
      this.#highPriorityBurst = 0;
      return workflow;
    }
    this.#highPriorityBurst = 0;
    return this.#backgroundCapacityAvailable()
      ? this.#queues.background.shift()
      : undefined;
  }
}
