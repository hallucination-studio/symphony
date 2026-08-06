export const DETERMINISTIC_SCENARIOS = Object.freeze([
  "single-cycle",
  "multi-cycle",
  "single-cycle-human-action",
  "cycle-human-action-cycle",
  "human-action-rejected-supplement",
  "human-action-unanswered",
]);

export const GOLDEN_SCENARIOS = Object.freeze([
  "single-cycle",
  "multi-cycle",
  "single-cycle-human-action",
  "cycle-human-action-cycle",
  "human-action-rejected-supplement",
  "human-action-unanswered",
]);

export function assertScenario(value) {
  if (!DETERMINISTIC_SCENARIOS.includes(value)) throw new Error("e2e_scenario_invalid");
  return value;
}

export function selectedScenarios(value) {
  if (value === undefined || value === null) return DETERMINISTIC_SCENARIOS;
  return Object.freeze([assertScenario(value)]);
}

export function scenarioRootIdentity(scenario) {
  assertScenario(scenario);
  const suffix = scenario;
  return Object.freeze({
    id: `root-${suffix}`,
    identifier: `E2E-${scenario.toUpperCase()}`,
    branch: `root/e2e-${suffix}`,
  });
}
