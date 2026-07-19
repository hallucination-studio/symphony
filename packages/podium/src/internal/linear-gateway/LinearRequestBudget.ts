export type LinearRequestClass =
  | "control"
  | "mutation"
  | "workflow-read"
  | "observation";

interface QueuedRequest<T> {
  requestClass: LinearRequestClass;
  deadlineAtMs?: number;
  run(): Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason: unknown): void;
}

export class LinearRequestBudget {
  readonly #queues: Record<LinearRequestClass, QueuedRequest<unknown>[]> = {
    control: [], mutation: [], "workflow-read": [], observation: [],
  };
  readonly #maxConcurrent: number;
  readonly #maxHighPriorityBurst: number;
  readonly #now: () => number;
  #active = 0;
  #highPriorityBurst = 0;

  constructor(options: {
    maxConcurrent: number;
    maxHighPriorityBurst: number;
    now?: () => number;
  }) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1
      || options.maxConcurrent > 32 || !Number.isInteger(options.maxHighPriorityBurst)
      || options.maxHighPriorityBurst < 1 || options.maxHighPriorityBurst > 32) {
      throw new Error("linear_request_budget_invalid");
    }
    this.#maxConcurrent = options.maxConcurrent;
    this.#maxHighPriorityBurst = options.maxHighPriorityBurst;
    this.#now = options.now ?? Date.now;
  }

  run<T>(requestClass: LinearRequestClass, run: () => Promise<T>, options: {
    deadlineAtMs?: number;
  } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#queues[requestClass].push(({
        requestClass, run, resolve, reject,
        ...(options.deadlineAtMs === undefined ? {} : { deadlineAtMs: options.deadlineAtMs }),
      }) as QueuedRequest<unknown>);
      this.#drain();
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
      void next.run().then(next.resolve, next.reject).finally(() => {
        this.#active -= 1;
        this.#drain();
      });
    }
  }

  #next(): QueuedRequest<unknown> | undefined {
    const workflowWaiting = this.#queues["workflow-read"].length > 0;
    if (workflowWaiting && this.#highPriorityBurst >= this.#maxHighPriorityBurst) {
      this.#highPriorityBurst = 0;
      return this.#queues["workflow-read"].shift();
    }
    for (const requestClass of ["control", "mutation"] as const) {
      const request = this.#queues[requestClass].shift();
      if (request) {
        this.#highPriorityBurst += 1;
        return request;
      }
    }
    const workflow = this.#queues["workflow-read"].shift();
    if (workflow) {
      this.#highPriorityBurst = 0;
      return workflow;
    }
    this.#highPriorityBurst = 0;
    return this.#queues.observation.shift();
  }
}
