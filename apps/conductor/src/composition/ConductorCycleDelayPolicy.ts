export type ConductorCycleDisposition =
  | "progress"
  | "waiting-human"
  | "needs-attention"
  | "empty";

export function conductorCycleDelayMs(input: {
  disposition: ConductorCycleDisposition;
  baseDelayMs: number;
  random: () => number;
}): number {
  if (
    !Number.isSafeInteger(input.baseDelayMs) || input.baseDelayMs < 1 ||
    input.baseDelayMs > 300_000
  ) {
    throw new Error("conductor_cycle_delay_invalid");
  }
  if (input.disposition === "progress") return 0;
  const floor = input.disposition === "waiting-human" ? 15_000 : 60_000;
  const multiplier = input.disposition === "waiting-human" ? 15 : 60;
  const base = Math.min(300_000, Math.max(floor, input.baseDelayMs * multiplier));
  const random = input.random();
  if (!Number.isFinite(random) || random < 0 || random > 1) {
    throw new Error("conductor_cycle_delay_random_invalid");
  }
  return Math.min(300_000, Math.round(base * (1 + random * 0.2)));
}
