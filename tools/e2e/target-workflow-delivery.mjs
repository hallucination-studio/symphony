const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const OBSERVATION_FIELDS = new Set(["git"]);
const DELIVERY_FIELDS = new Set(["kind", "branch", "head", "verifiedAgainst", "readBack"]);
const DELIVERY_KINDS = new Set(["local_branch", "remote_branch", "pull_request"]);
import { createAdaptivePoller } from "./target-workflow-polling.mjs";

export async function runTargetDeliveryScenario({
  runner,
  rootIssueId,
  projectId,
  verifyIssueId,
  verifiedRevision,
  deliveryBranch,
  observationInput,
  timeoutMs = 30 * 60_000,
  pollIntervalMs = 1_000,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  now = Date.now,
  onProgress = () => {},
} = {}) {
  validateDependencies({ runner, rootIssueId, projectId, verifyIssueId, verifiedRevision, deliveryBranch, observationInput, timeoutMs, pollIntervalMs, sleep, now, onProgress });
  const deadline = now() + timeoutMs;
  const poller = createAdaptivePoller({ baseIntervalMs: pollIntervalMs });
  while (now() < deadline) {
    const observed = await runner.observeRoot({ rootIssueId, projectId, ...observationInput });
    const facts = observed?.facts;
    if (!facts || typeof facts !== "object" || Array.isArray(facts) ||
        facts.root?.rootIssueId !== rootIssueId || facts.root?.projectId !== projectId) {
      throw new Error("target_delivery_facts_invalid");
    }
    if (facts.delivery === undefined) {
      onProgress({ phase: "delivery", status: "awaiting_read_back" });
      await pause(deadline, now, sleep, poller, facts);
      continue;
    }
    const delivery = validateDelivery(facts.delivery);
    if (delivery.head !== verifiedRevision || delivery.verifiedAgainst !== verifyIssueId ||
      (deliveryBranch !== undefined && delivery.branch !== deliveryBranch)) {
      throw new Error("target_delivery_revision_mismatch");
    }
    onProgress({ phase: "delivery", status: "read_back" });
    return Object.freeze({ delivery });
  }
  throw new Error("target_delivery_timeout");
}

function validateDependencies({ runner, rootIssueId, projectId, verifyIssueId, verifiedRevision, deliveryBranch, observationInput, timeoutMs, pollIntervalMs, sleep, now, onProgress }) {
  if (typeof runner?.observeRoot !== "function" || !SAFE_ID.test(rootIssueId ?? "") ||
      !SAFE_ID.test(projectId ?? "") || !SAFE_ID.test(verifyIssueId ?? "") ||
      !SHA.test(verifiedRevision ?? "") || (deliveryBranch !== undefined && !SAFE_ID.test(deliveryBranch ?? ""))) {
    throw new Error("target_delivery_input_invalid");
  }
  if (!observationInput || typeof observationInput !== "object" || Array.isArray(observationInput) ||
      [...Object.keys(observationInput)].some((key) => !OBSERVATION_FIELDS.has(key)) ||
      !SHA.test(observationInput.git?.head ?? "") || !SAFE_ID.test(observationInput.git?.branch ?? "")) {
    throw new Error("target_delivery_observation_invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000 ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 300_000 ||
      typeof sleep !== "function" || typeof now !== "function" || typeof onProgress !== "function") {
    throw new Error("target_delivery_timing_invalid");
  }
}

function validateDelivery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      [...Object.keys(value)].some((key) => !DELIVERY_FIELDS.has(key)) ||
      !DELIVERY_KINDS.has(value.kind) || !SAFE_ID.test(value.branch ?? "") ||
      !SHA.test(value.head ?? "") || !SAFE_ID.test(value.verifiedAgainst ?? "") || value.readBack !== true) {
    throw new Error("target_delivery_evidence_invalid");
  }
  return Object.freeze({
    kind: value.kind, branch: value.branch, head: value.head,
    verifiedAgainst: value.verifiedAgainst, readBack: true,
  });
}

async function pause(deadline, now, sleep, poller, value) {
  const remaining = deadline - now();
  if (remaining > 0) await sleep(Math.min(poller.observe(value), remaining));
}
