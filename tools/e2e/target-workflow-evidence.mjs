import { evaluateTargetWorkflowEvidence, TARGET_WORKFLOW_SCENARIOS } from "./target-workflow-verdict.mjs";

const SCENARIO_SET = new Set(TARGET_WORKFLOW_SCENARIOS);

export function assembleTargetWorkflowEvidence({ results, cleanupCompleted = false } = {}) {
  if (!Array.isArray(results) || results.length !== TARGET_WORKFLOW_SCENARIOS.length) {
    throw new Error("target_evidence_scenarios_invalid");
  }
  const byScenario = new Map();
  for (const result of results) {
    if (!result || typeof result !== "object" || !SCENARIO_SET.has(result.scenario) || byScenario.has(result.scenario)) {
      throw new Error("target_evidence_scenario_invalid");
    }
    byScenario.set(result.scenario, result);
  }
  if (byScenario.size !== TARGET_WORKFLOW_SCENARIOS.length) throw new Error("target_evidence_scenarios_invalid");

  const baseFacts = factsOf(byScenario.get("success"));
  const repairFacts = factsOf(byScenario.get("repair_escalation"));
  const restart = byScenario.get("restart_recovery");
  const delivery = byScenario.get("delivery");
  const scheduling = byScenario.get("scheduling");
  return Object.freeze({
    status: "failed",
    scenarioEvidence: Object.freeze({
      success: Object.freeze({ ...baseFacts, status: byScenario.get("success")?.status }),
      repair_escalation: Object.freeze({ ...repairFacts, status: byScenario.get("repair_escalation")?.status }),
      restart_recovery: Object.freeze({ ...factsOf(restart), recovery: restart?.recovery, status: restart?.status }),
      delivery: Object.freeze({ ...factsOf(delivery), delivery: delivery?.delivery, status: delivery?.status }),
      scheduling: Object.freeze({ scheduling: scheduling?.scheduling, status: scheduling?.status }),
    }),
    scenarios: Object.freeze(TARGET_WORKFLOW_SCENARIOS.map((scenario) => Object.freeze({
      scenario,
      status: byScenario.get(scenario)?.status === "passed" ? "passed" : "failed",
    }))),
    cleanup: Object.freeze({ completed: cleanupCompleted === true }),
  });
}

export function evaluateTargetWorkflowResults(input, options = {}) {
  const evidence = assembleTargetWorkflowEvidence(input);
  return Object.freeze({ evidence, verdict: evaluateTargetWorkflowEvidence(evidence, options) });
}

function factsOf(result) {
  return result?.facts && typeof result.facts === "object" && !Array.isArray(result.facts)
    ? result.facts
    : undefined;
}
