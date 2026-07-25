import { loadE2EConfig } from "./config.mjs";
import {
  assertParallelBlackBoxE2ECampaignCommand,
  assertParallelBlackBoxE2ECampaignResult,
  resolveHumanScript,
} from "./parallel-black-box-contract.mjs";
import { createFinalCaseVerdict } from "./final-evidence-verdict.mjs";

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
    if (rootSettlement.outcome.kind !== "fulfilled") throw stableError("parallel_black_box_campaign_root_unavailable");
    const root = rootSettlement.outcome.value;
    await settleBeforeDeadline(
      () => ports.runHumanScript({ campaign, e2eCase, root, human_script: resolveHumanScript(e2eCase.human_script_id) }),
      e2eCase.deadline_at,
      { now, setTimer, clearTimer },
    );
    const snapshot = await readFinalEvidenceSnapshot({ ports, campaign, e2eCase, root, observedAt });
    return createFinalCaseVerdict({
      e2eCase,
      root,
      snapshot,
      evaluateEvidencePredicate: ports.evaluateEvidencePredicate,
      observedAt,
    });
  }));

  return assertParallelBlackBoxE2ECampaignResult({
    version: 1,
    campaign_id: campaign.campaign_id,
    cases: results,
    durable_overlap_evidence_refs: [],
  });
}

export async function runConfiguredParallelBlackBoxE2ECampaign({
  environment = process.env,
} = {}) {
  loadE2EConfig({ environment });
  throw stableError("parallel_black_box_campaign_runtime_unavailable");
}

async function readFinalEvidenceSnapshot({ ports, campaign, e2eCase, root, observedAt }) {
  try {
    return await ports.readFreshEvidenceSnapshot({ campaign, e2eCase, root });
  } catch {
    return {
      kind: "incomplete",
      observed_at: observedAt(),
      omissions: [{ source_id: root.root_issue_id, reason_code: "fresh_evidence_read_failed" }],
    };
  }
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
    "readFreshEvidenceSnapshot",
    "evaluateEvidencePredicate",
  ]) {
    if (typeof ports[method] !== "function") throw stableError("parallel_black_box_campaign_ports_invalid");
  }
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
