const REQUIRED = Object.freeze([
  ["runner_external_root_input", "runner", /externalInputs\.createRoot/u],
  ["runner_external_human_input", "runner", /externalInputs\.appendHumanResponse/u],
  ["runner_snapshot_read", "runner", /snapshotTransport\.readSnapshot/u],
  ["runner_durable_projection", "runner", /projectFacts\(snapshot\)/u],
  ["runner_pending_human_projection", "runner", /projectTargetWorkflowPendingHuman\(snapshot\)/u],
  ["runner_closed_observation", "runner", /Object\.freeze\(\{ facts \}\)/u],
  ["inputs_root_mutation", "inputs", /issueCreate/u],
  ["inputs_human_mutation", "inputs", /commentCreate/u],
  ["transport_project_read", "transport", /project\.issues/u],
  ["transport_issue_read", "transport", /inverseRelations/u],
]);

const FORBIDDEN_WORKFLOW_MUTATION = /\b(?:createCycle|createNode|createFinding|createRelation|createWorkflowRelation|createDelivery|seed(?:Cycle|Plan|Node|Finding)|appendManagedRecord)\b|git\.commit\s*\(|root\.deliver\s*\(/u;
const LEGACY_RUNNER_VOCABULARY = /Root Gate|root[-_ ]turn|performer[-_ ]turn|conversation|agent command/iu;
const SECRET_BOUNDARY = /SYMPHONY_E2E_LINEAR_DEV_TOKEN|SYMPHONY_E2E_CODEX_API_KEY|process\.env\.(?:LINEAR|CODEX).*?(?:TOKEN|KEY)/u;
const RAW_SNAPSHOT_EXPOSURE = /return\s*\{\s*snapshot\b/u;

export function auditTargetWorkflowSources(sources = {}) {
  const failures = [];
  for (const [code, sourceName, pattern] of REQUIRED) {
    if (typeof sources[sourceName] !== "string" || !pattern.test(sources[sourceName])) {
      failures.push(code);
    }
  }

  const runner = typeof sources.runner === "string" ? sources.runner : "";
  const inputs = typeof sources.inputs === "string" ? sources.inputs : "";
  const combined = `${runner}\n${inputs}`;
  if (FORBIDDEN_WORKFLOW_MUTATION.test(combined)) failures.push("forbidden_workflow_mutation");
  if (LEGACY_RUNNER_VOCABULARY.test(combined)) failures.push("legacy_runner_vocabulary");
  if (SECRET_BOUNDARY.test(combined)) failures.push("secret_boundary");
  if (RAW_SNAPSHOT_EXPOSURE.test(runner)) failures.push("raw_snapshot_exposure");
  return Object.freeze({ passed: failures.length === 0, failures: Object.freeze(failures) });
}
