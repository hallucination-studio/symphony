import { loadE2EConfig } from "./config.mjs";
import {
  assertParallelBlackBoxE2ECampaignCommand,
  assertParallelBlackBoxE2ECampaignResult,
  resolveHumanScript,
} from "./parallel-black-box-contract.mjs";
import { createFinalCaseVerdict } from "./final-evidence-verdict.mjs";

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
  const finalSettlements = await Promise.allSettled(campaign.cases.map((e2eCase, index) => finalizeCase({
    actionSettlement: actionSettlements[index],
    e2eCase,
    ports,
    observedAt,
  })));
  const results = await Promise.all(finalSettlements.map((settlement, index) => settlement.status === "fulfilled"
    ? settlement.value
    : unavailableCaseVerdict({ e2eCase: campaign.cases[index], observedAt })));

  return assertParallelBlackBoxE2ECampaignResult({
    version: 1,
    campaign_id: campaign.campaign_id,
    cases: results,
    durable_overlap_evidence_refs: [],
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
    () => ports.runHumanScript({ caseContext, e2eCase, root, human_script: resolveHumanScript(e2eCase.human_script_id) }),
    e2eCase.deadline_at,
    { now, setTimer, clearTimer },
  );
  return Object.freeze({ caseContext, root });
}

async function finalizeCase({ actionSettlement, e2eCase, ports, observedAt }) {
  if (actionSettlement.status !== "fulfilled" || actionSettlement.value === null) {
    return unavailableCaseVerdict({ e2eCase, observedAt });
  }
  const { caseContext, root } = actionSettlement.value;
  const snapshot = await readFinalEvidenceSnapshot({ ports, caseContext, e2eCase, root, observedAt });
  return createFinalCaseVerdict({
    e2eCase,
    root,
    snapshot,
    evaluateEvidencePredicate: ports.evaluateEvidencePredicate,
    observedAt,
  });
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

function unavailableCaseVerdict({ e2eCase, observedAt }) {
  return createFinalCaseVerdict({
    e2eCase,
    snapshot: {
      kind: "incomplete",
      observed_at: observedAt(),
      omissions: [{ source_id: e2eCase.case_id, reason_code: "case_root_unavailable" }],
    },
    observedAt,
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
