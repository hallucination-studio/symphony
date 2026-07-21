const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export async function runTargetSchedulingScenario({ readScheduling } = {}) {
  if (typeof readScheduling !== "function") throw new Error("target_scheduling_reader_invalid");
  const value = await readScheduling();
  const fields = new Set(["selectedRootIds", "waitingRootIds", "maxConcurrentRoots", "blockerRespected"]);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      [...Object.keys(value)].some((key) => !fields.has(key)) ||
      !Array.isArray(value.selectedRootIds) || value.selectedRootIds.length === 0 ||
      !value.selectedRootIds.every((id) => SAFE_ID.test(id)) ||
      new Set(value.selectedRootIds).size !== value.selectedRootIds.length ||
      !Array.isArray(value.waitingRootIds) || !value.waitingRootIds.every((id) => SAFE_ID.test(id)) ||
      new Set(value.waitingRootIds).size !== value.waitingRootIds.length ||
      value.selectedRootIds.some((id) => value.waitingRootIds.includes(id)) ||
      value.maxConcurrentRoots !== 1 || value.blockerRespected !== true) {
    throw new Error("target_scheduling_evidence_invalid");
  }
  return Object.freeze({
    selectedRootIds: Object.freeze([...value.selectedRootIds]),
    waitingRootIds: Object.freeze([...value.waitingRootIds]),
    maxConcurrentRoots: 1,
    blockerRespected: true,
  });
}
