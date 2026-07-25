import { loadE2EConfig } from "./config.mjs";
import {
  assertParallelBlackBoxE2ECampaignCommand,
  assertParallelBlackBoxE2ECampaignResult,
} from "./parallel-black-box-contract.mjs";

export const TARGET_E2E_DEADLINE_MS = 300_000;

export async function runParallelBlackBoxE2ECampaign({
  command,
  ports,
  observedAt = () => new Date().toISOString(),
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const campaign = assertParallelBlackBoxE2ECampaignCommand(command);
  assertPorts(ports);

  await Promise.all(campaign.conductors.map((conductor) => ports.startConductor({ conductor })));
  await Promise.all(campaign.conductors.map((conductor) => ports.provisionProfile({ conductor })));
  await Promise.all(campaign.conductors.map((conductor) => ports.waitForProfileReady({ conductor })));

  const rootSettlements = await Promise.all(campaign.cases.map(async (e2eCase) => ({
    e2eCase,
    outcome: await settleBeforeDeadline(
      () => ports.createCaseRoot({ campaign, e2eCase }),
      e2eCase.deadline_at,
      { now, setTimer, clearTimer },
    ),
  })));
  const results = await Promise.all(campaign.cases.map(async (e2eCase, index) => {
    const rootSettlement = rootSettlements[index];
    if (rootSettlement.outcome.kind === "timed_out") {
      return caseResult(e2eCase.case_id, "incomplete", "case_deadline_exceeded", [], observedAt);
    }
    if (rootSettlement.outcome.kind === "rejected") {
      return caseResult(e2eCase.case_id, "failed", "root_creation_failed", [], observedAt);
    }
    const root = rootSettlement.outcome.value;
    const humanOutcome = await settleBeforeDeadline(
      () => ports.runHumanScript({ campaign, e2eCase, root }),
      e2eCase.deadline_at,
      { now, setTimer, clearTimer },
    );
    const evidenceSettlement = await Promise.allSettled([
      readFinalEvidence({ ports, campaign, e2eCase, root }),
    ]);
    const evidence = evidenceSettlement[0].status === "fulfilled"
      ? evidenceSettlement[0].value
      : { status: "incomplete", reason_code: "final_evidence_read_failed", evidence_refs: [] };
    if (humanOutcome.kind === "timed_out") {
      return caseResult(e2eCase.case_id, "incomplete", "case_deadline_exceeded", evidence.evidence_refs, observedAt);
    }
    if (humanOutcome.kind === "rejected") {
      return caseResult(e2eCase.case_id, "failed", "human_script_failed", evidence.evidence_refs, observedAt);
    }
    return caseResult(e2eCase.case_id, evidence.status, evidence.reason_code, evidence.evidence_refs, observedAt);
  }));

  const overlapSettlement = await Promise.allSettled([ports.readDurableOverlapEvidence({ campaign })]);
  const durableOverlapEvidenceRefs = overlapSettlement[0].status === "fulfilled"
    ? overlapSettlement[0].value
    : [];
  return assertParallelBlackBoxE2ECampaignResult({
    version: 1,
    campaign_id: campaign.campaign_id,
    cases: results,
    durable_overlap_evidence_refs: durableOverlapEvidenceRefs,
  });
}

export async function runConfiguredParallelBlackBoxE2ECampaign({
  environment = process.env,
} = {}) {
  loadE2EConfig({ environment });
  throw stableError("parallel_black_box_campaign_runtime_unavailable");
}

async function readFinalEvidence({ ports, campaign, e2eCase, root }) {
  const reader = await ports.createFreshEvidenceReader({ campaign, e2eCase, root });
  if (!reader || typeof reader.readFinalEvidence !== "function") {
    throw stableError("parallel_black_box_campaign_evidence_reader_invalid");
  }
  const evidence = await reader.readFinalEvidence({ campaign, e2eCase, root });
  if (!evidence || !["passed", "failed", "incomplete"].includes(evidence.status) ||
      typeof evidence.reason_code !== "string" || !Array.isArray(evidence.evidence_refs)) {
    throw stableError("parallel_black_box_campaign_evidence_invalid");
  }
  return evidence;
}

function caseResult(caseId, status, reasonCode, evidenceRefs, observedAt) {
  return {
    case_id: caseId,
    status,
    reason_code: reasonCode,
    evidence_refs: evidenceRefs,
    observed_at: observedAt(),
  };
}

function settleBeforeDeadline(operation, deadlineAt, { now, setTimer, clearTimer }) {
  const remainingMs = Date.parse(deadlineAt) - now();
  if (remainingMs <= 0) return Promise.resolve({ kind: "timed_out" });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      resolve(outcome);
    };
    const timer = setTimer(() => finish({ kind: "timed_out" }), remainingMs);
    Promise.resolve()
      .then(operation)
      .then((value) => finish({ kind: "fulfilled", value }), () => finish({ kind: "rejected" }));
  });
}

function assertPorts(ports) {
  if (!ports || typeof ports !== "object") throw stableError("parallel_black_box_campaign_ports_invalid");
  for (const method of [
    "startConductor",
    "provisionProfile",
    "waitForProfileReady",
    "createCaseRoot",
    "runHumanScript",
    "createFreshEvidenceReader",
    "readDurableOverlapEvidence",
  ]) {
    if (typeof ports[method] !== "function") throw stableError("parallel_black_box_campaign_ports_invalid");
  }
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
