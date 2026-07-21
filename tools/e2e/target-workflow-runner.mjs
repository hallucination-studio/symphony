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
      if (!facts || typeof facts !== "object" || Array.isArray(facts)) {
        throw new Error("target_runner_facts_invalid");
      }
      return Object.freeze({ facts });
    },
  });
}
