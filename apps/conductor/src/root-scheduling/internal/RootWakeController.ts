import type { RootRuntimeDisposition } from "../../root-reconciliation/api/RootRuntimeLoop.js";

const IDLE_SAFETY_INTERVAL_MS = 30_000;
const TRANSIENT_BACKOFF_INITIAL_MS = 1_000;
const TRANSIENT_BACKOFF_MAX_MS = 30_000;

export class RootWakeController {
  #startupPending = true;
  #wakePending = false;
  #transientFailureCount = 0;
  #interruptWait: (() => void) | undefined;
  #wakeInterrupted = false;

  constructor(private readonly options: {
    now?: () => number;
    random?: () => number;
  } = {}) {}

  wake(): void {
    if (this.#interruptWait) {
      if (!this.#wakeInterrupted) {
        this.#wakeInterrupted = true;
        this.#interruptWait();
      }
      return;
    }
    this.#wakePending = true;
  }

  nextDelay(input: {
    disposition: RootRuntimeDisposition;
    deadlineAtMs?: number;
  }): number {
    if (this.#startupPending || this.#wakePending) {
      this.#startupPending = false;
      this.#wakePending = false;
      return 0;
    }
    if (input.disposition === "progress") {
      this.#transientFailureCount = 0;
      return 0;
    }
    if (input.disposition === "discovery-degraded") {
      this.#transientFailureCount += 1;
      return this.#jittered(Math.min(
        TRANSIENT_BACKOFF_MAX_MS,
        TRANSIENT_BACKOFF_INITIAL_MS * 2 ** (this.#transientFailureCount - 1),
      ));
    }
    this.#transientFailureCount = 0;
    const idleDelay = this.#jittered(IDLE_SAFETY_INTERVAL_MS);
    const deadlineDelay = input.deadlineAtMs === undefined
      ? undefined
      : input.deadlineAtMs - this.#now();
    return deadlineDelay !== undefined && Number.isFinite(deadlineDelay) && deadlineDelay > 0
      ? Math.min(idleDelay, Math.round(deadlineDelay))
      : idleDelay;
  }

  async wait(input: {
    disposition: RootRuntimeDisposition;
    deadlineAtMs?: number;
  }): Promise<void> {
    const delayMs = this.nextDelay(input);
    if (delayMs === 0) return;
    this.#wakeInterrupted = false;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.#interruptWait = undefined;
        resolve();
      }, delayMs);
      this.#interruptWait = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    if (this.#wakeInterrupted) this.#wakePending = false;
    this.#interruptWait = undefined;
  }

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  #jittered(value: number): number {
    const random = this.options.random?.() ?? Math.random();
    return Math.round(value * (0.9 + Math.max(0, Math.min(1, random)) * 0.2));
  }
}
