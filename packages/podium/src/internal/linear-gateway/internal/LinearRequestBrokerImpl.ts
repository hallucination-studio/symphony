import type { LinearRequestObserverImpl } from "./LinearRequestObserverImpl.js";

export type InstallationRequestClass =
  | "control"
  | "workflow"
  | "mutation"
  | "read-back"
  | "background";

const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60_000;

interface QueuedRequest<T> {
  requestClass: InstallationRequestClass;
  deadlineAtMs: number;
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
  readonly #observer: LinearRequestObserverImpl | undefined;
  readonly #requestTimeoutMs: number;
  #active = 0;
  #highPriorityBurst = 0;
  #generation = 0;

  constructor(options: {
    maxConcurrent: number;
    maxHighPriorityBurst: number;
    observer?: LinearRequestObserverImpl;
    requestTimeoutMs?: number;
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
    this.#observer = options.observer;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1 || this.#requestTimeoutMs > DEFAULT_REQUEST_TIMEOUT_MS) {
      throw new Error("linear_request_timeout_invalid");
    }
  }

  observe(observation: {
    status?: number;
    requestWindow?: { limit?: number; remaining?: number; reset?: number };
    complexityWindow?: { limit?: number; remaining?: number; reset?: number };
  }): void {
    this.#observer?.observe(observation);
  }

  run<T>(
    requestClass: InstallationRequestClass,
    run: () => Promise<T>,
    options: { deadlineAtMs?: number; coalesceKey?: string } = {},
  ): Promise<T> {
    this.#observer?.recordLogicalOperation();
    const now = this.#now();
    const maximumDeadlineAtMs = now + this.#requestTimeoutMs;
    if (options.deadlineAtMs !== undefined && !Number.isSafeInteger(options.deadlineAtMs)) {
      throw new Error("linear_request_deadline_invalid");
    }
    const deadlineAtMs = Math.min(options.deadlineAtMs ?? maximumDeadlineAtMs, maximumDeadlineAtMs);
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
        deadlineAtMs,
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

  #drain(): void {
    while (this.#active < this.#maxConcurrent) {
      const next = this.#next();
      if (!next) return;
      if (next.deadlineAtMs !== undefined && this.#now() >= next.deadlineAtMs) {
        next.reject(new Error("linear_request_deadline_exceeded"));
        continue;
      }
      this.#active += 1;
      const remainingMs = next.deadlineAtMs - this.#now();
      let released = false;
      const timeout = { current: undefined as NodeJS.Timeout | undefined };
      const release = () => {
        if (released) return;
        released = true;
        if (timeout.current) clearTimeout(timeout.current);
        this.#active -= 1;
        this.#drain();
      };
      timeout.current = setTimeout(() => {
        next.reject(new Error("linear_request_deadline_exceeded"));
        release();
      }, remainingMs);
      void next.run().then(next.resolve, next.reject).finally(release);
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
    return this.#queues.background.shift();
  }
}
