export function createTargetWorkflowRunner({
  externalInputs,
  snapshotTransport,
  projectFacts,
} = {}) {
  if (typeof externalInputs?.createRoot !== "function" ||
      typeof externalInputs?.appendHumanResponse !== "function" ||
      typeof snapshotTransport?.readSnapshot !== "function" ||
      typeof projectFacts !== "function") {
    throw new Error("target_runner_boundary_invalid");
  }

  return Object.freeze({
    createRoot(input) {
      return externalInputs.createRoot(input);
    },
    appendHumanResponse(input) {
      return externalInputs.appendHumanResponse(input);
    },
    async observeRoot(input) {
      const snapshot = await snapshotTransport.readSnapshot(input);
      const facts = projectFacts(snapshot);
      if (!isTargetWorkflowFacts(facts)) {
        throw new Error("target_runner_facts_invalid");
      }
      return Object.freeze({ facts });
    },
  });
}

function isTargetWorkflowFacts(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => ["root", "plan", "stageExecutions", "progress", "delivery"].includes(key)) &&
    value.root && typeof value.root === "object" && !Array.isArray(value.root) &&
    typeof value.root.projectId === "string" && typeof value.root.rootIssueId === "string" &&
    value.plan && typeof value.plan === "object" && !Array.isArray(value.plan) &&
    Array.isArray(value.stageExecutions) &&
    value.progress && typeof value.progress === "object" && !Array.isArray(value.progress);
}
