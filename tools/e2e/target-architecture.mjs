import { loadE2EConfig } from "./config.mjs";
import {
  assertParallelBlackBoxE2ECampaignCommand,
  assertParallelBlackBoxE2ECampaignResult,
  resolveHumanScript,
} from "./parallel-black-box-contract.mjs";
import { analyzeHappyPathCampaignEvidence } from "./approved-happy-path-evidence.mjs";
import { createFinalCaseVerdict } from "./final-evidence-verdict.mjs";
import { executeHumanScript } from "./human-scripts.mjs";

export const TARGET_E2E_DEADLINE_MS = 300_000;
const ROOT_ISSUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

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

  const actionSettlements = await Promise.allSettled(campaign.cases.map((e2eCase) => runCaseAction({
    campaign,
    e2eCase,
    ports,
    observedAt,
    now,
    setTimer,
    clearTimer,
  })));
  const evidenceSettlements = await Promise.allSettled(campaign.cases.map((e2eCase, index) => finalizeCaseEvidence({
    actionSettlement: actionSettlements[index],
    e2eCase,
    campaign,
    ports,
    observedAt,
  })));
  const evidence = evidenceSettlements.map((settlement, index) => settlement.status === "fulfilled"
    ? settlement.value
    : unavailableCaseEvidence({ campaign, e2eCase: campaign.cases[index], observedAt }));
  const campaignEvidence = analyzeHappyPathCampaignEvidence({ rows: evidence });
  const outcomesByCaseId = new Map(campaignEvidence.case_outcomes.map((entry) => [entry.case_id, entry.outcome]));
  const results = await Promise.all(evidence.map(({ e2eCase, root, snapshot }) => createFinalCaseVerdict({
    e2eCase,
    root,
    snapshot,
    evaluateEvidencePredicate: async ({ e2e_case: currentCase }) => outcomesByCaseId.get(currentCase.case_id) ?? {
      kind: "inconclusive",
      reason_code: "evidence_predicate_unavailable",
    },
    observedAt,
  })));

  return assertParallelBlackBoxE2ECampaignResult({
    version: 1,
    campaign_id: campaign.campaign_id,
    cases: results,
    durable_overlap_evidence_refs: campaignEvidence.durable_overlap_evidence_refs,
  });
}

async function runCaseAction({ campaign, e2eCase, ports, now, setTimer, clearTimer }) {
  const caseContext = createCaseContext(campaign, e2eCase);
  const rootSettlement = await settleBeforeDeadline(
    () => ports.createCaseRoot({ caseContext, e2eCase }),
    e2eCase.deadline_at,
    { now, setTimer, clearTimer },
  );
  const root = rootSettlement.kind === "fulfilled" ? normalizeRoot(rootSettlement.value) : null;
  if (root === null) {
    return null;
  }
  await settleBeforeDeadline(
    () => executeHumanScript({
      humanScript: resolveHumanScript(e2eCase.human_script_id),
      root,
      human: ports.human,
      waitForHumanAction: (input) => ports.waitForHumanAction({ caseContext, e2eCase, ...input }),
    }),
    e2eCase.deadline_at,
    { now, setTimer, clearTimer },
  );
  return Object.freeze({ caseContext, root });
}

async function finalizeCaseEvidence({ actionSettlement, e2eCase, campaign, ports, observedAt }) {
  if (actionSettlement.status !== "fulfilled" || actionSettlement.value === null) {
    return unavailableCaseEvidence({ campaign, e2eCase, observedAt });
  }
  const { caseContext, root } = actionSettlement.value;
  const snapshot = await readFinalEvidenceSnapshot({ ports, caseContext, e2eCase, root, observedAt });
  return Object.freeze({ e2eCase, caseContext, root, snapshot });
}

function createCaseContext(campaign, e2eCase) {
  const routedConductorIds = new Set(e2eCase.routed_conductor_ids);
  return Object.freeze({
    campaign_id: campaign.campaign_id,
    project_id: campaign.project_id,
    conductors: Object.freeze(campaign.conductors
      .filter(({ conductor_id: conductorId }) => routedConductorIds.has(conductorId))
      .map((conductor) => Object.freeze({ ...conductor }))),
  });
}

function unavailableCaseEvidence({ campaign, e2eCase, observedAt }) {
  return Object.freeze({
    e2eCase,
    caseContext: createCaseContext(campaign, e2eCase),
    snapshot: {
      kind: "incomplete",
      observed_at: observedAt(),
      omissions: [{ source_id: e2eCase.case_id, reason_code: "case_root_unavailable" }],
    },
  });
}

function normalizeRoot(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !Object.hasOwn(value, "root_issue_id") || !ROOT_ISSUE_ID.test(value.root_issue_id)) {
    return null;
  }
  return Object.freeze({ root_issue_id: value.root_issue_id });
}

export async function runConfiguredParallelBlackBoxE2ECampaign({
  environment = process.env,
} = {}) {
  loadE2EConfig({ environment });
  throw stableError("parallel_black_box_campaign_runtime_unavailable");
}

async function readFinalEvidenceSnapshot({ ports, caseContext, e2eCase, root, observedAt }) {
  try {
    return await ports.readFreshEvidenceSnapshot({ caseContext, e2eCase, root });
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
    "createCaseRoot",
    "waitForHumanAction",
    "readFreshEvidenceSnapshot",
  ]) {
    if (typeof ports[method] !== "function") throw stableError("parallel_black_box_campaign_ports_invalid");
  }
  if (!ports.human || typeof ports.human.resolveHumanAction !== "function") {
    throw stableError("parallel_black_box_campaign_ports_invalid");
  }
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
