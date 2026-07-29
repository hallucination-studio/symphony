export function deriveRootStateSuccessorPolicy(
  terminalCycleCount: number,
  maxCyclesPerRoot: number,
  observedAt: string,
  deadlineAt: string,
): "allowed" | "cycle_limit_reached" | "root_deadline_reached" | undefined {
  const observed = Date.parse(observedAt);
  const deadline = Date.parse(deadlineAt);
  if (!Number.isSafeInteger(maxCyclesPerRoot) || maxCyclesPerRoot < 1 ||
      !Number.isFinite(observed) || !Number.isFinite(deadline) ||
      terminalCycleCount > maxCyclesPerRoot) return undefined;
  if (observed >= deadline) return "root_deadline_reached";
  return terminalCycleCount >= maxCyclesPerRoot ? "cycle_limit_reached" : "allowed";
}
