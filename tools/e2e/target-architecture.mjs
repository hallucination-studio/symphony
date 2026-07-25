import { loadE2EConfig } from "./config.mjs";
import {
  assertParallelBlackBoxE2ECampaignCommand,
  assertParallelBlackBoxE2ECampaignResult,
  resolveHumanScript,
} from "./parallel-black-box-contract.mjs";
import { analyzeHappyPathCampaignEvidence } from "./approved-happy-path-evidence.mjs";
import { analyzeCycleSuccessorCampaignEvidence } from "./cycle-successor-evidence.mjs";
import { createFinalCaseVerdict } from "./final-evidence-verdict.mjs";
import { executeHumanScript } from "./human-scripts.mjs";
import { analyzePlanRejectionSupersessionCampaignEvidence } from "./plan-rejection-supersession-evidence.mjs";
import { analyzeRootRevisionCommentCampaignEvidence } from "./root-revision-comment-evidence.mjs";
import { analyzeRestartIsolationCampaignEvidence } from "./restart-isolation-evidence.mjs";
import { analyzeSameConductorPreemptionCampaignEvidence } from "./same-conductor-preemption-evidence.mjs";

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
  assertPorts(ports, campaign);
  const actorIds = await readActorIds(ports.human);

  const actionSettlements = await Promise.allSettled(campaign.cases.map((e2eCase) => runCaseAction({
    campaign,
    e2eCase,
    ports,
    actorIds,
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
  const happyPathEvidence = analyzeHappyPathCampaignEvidence({ rows: evidence });
  const planRejectionEvidence = analyzePlanRejectionSupersessionCampaignEvidence({ rows: evidence });
  const rootRevisionEvidence = analyzeRootRevisionCommentCampaignEvidence({ rows: evidence });
  const restartIsolationEvidence = analyzeRestartIsolationCampaignEvidence({ rows: evidence });
  const preemptionEvidence = analyzeSameConductorPreemptionCampaignEvidence({ rows: evidence });
  const cycleSuccessorEvidence = analyzeCycleSuccessorCampaignEvidence({ rows: evidence });
  const outcomesByCaseId = new Map([
    ...happyPathEvidence.case_outcomes,
    ...planRejectionEvidence.case_outcomes,
    ...rootRevisionEvidence.case_outcomes,
    ...restartIsolationEvidence.case_outcomes,
    ...preemptionEvidence.case_outcomes,
    ...cycleSuccessorEvidence.case_outcomes,
  ].map((entry) => [entry.case_id, entry.outcome]));
  const results = await Promise.all(evidence.map(({ e2eCase, caseRoots, snapshot }) => createFinalCaseVerdict({
    e2eCase,
    caseRoots,
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
    durable_overlap_evidence_refs: happyPathEvidence.durable_overlap_evidence_refs,
  });
}

async function runCaseAction({ campaign, e2eCase, ports, actorIds, now, setTimer, clearTimer }) {
  const caseContext = createCaseContext(campaign, e2eCase, actorIds);
  const rootsSettlement = await settleBeforeDeadline(
    () => ports.createCaseRoots({ caseContext, e2eCase }),
    e2eCase.deadline_at,
    { now, setTimer, clearTimer },
  );
  const caseRoots = rootsSettlement.kind === "fulfilled" ? normalizeCaseRoots(rootsSettlement.value) : null;
  if (caseRoots === null) {
    return null;
  }
  await settleBeforeDeadline(
    () => executeHumanScript({
      humanScript: resolveHumanScript(e2eCase.human_script_id),
      caseRoots,
      human: ports.human,
      waitForHumanAction: (input) => ports.waitForHumanAction({ caseContext, e2eCase, ...input }),
      waitForInFlightStage: (input) => ports.waitForInFlightStage({ caseContext, e2eCase, ...input }),
      waitForRootReconcilerReply: (input) => ports.waitForRootReconcilerReply({ caseContext, e2eCase, ...input }),
      restartConductor: (input) => ports.restartConductor({ caseContext, e2eCase, ...input }),
    }),
    e2eCase.deadline_at,
    { now, setTimer, clearTimer },
  );
  return Object.freeze({ caseContext, caseRoots });
}

async function finalizeCaseEvidence({ actionSettlement, e2eCase, campaign, ports, observedAt }) {
  if (actionSettlement.status !== "fulfilled" || actionSettlement.value === null) {
    return unavailableCaseEvidence({ campaign, e2eCase, observedAt });
  }
  const { caseContext, caseRoots } = actionSettlement.value;
  const snapshot = await readFinalEvidenceSnapshot({ ports, caseContext, e2eCase, caseRoots, observedAt });
  return Object.freeze({ e2eCase, caseContext, caseRoots, snapshot });
}

function createCaseContext(campaign, e2eCase, actorIds = {}) {
  const conductorsById = new Map(campaign.conductors.map((conductor) => [conductor.conductor_id, conductor]));
  return Object.freeze({
    campaign_id: campaign.campaign_id,
    project_id: campaign.project_id,
    human_actor_id: actorIds.humanActorId,
    symphony_actor_id: actorIds.symphonyActorId,
    conductors: Object.freeze(e2eCase.routed_conductor_ids
      .map((conductorId) => Object.freeze({ ...conductorsById.get(conductorId) }))),
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

function normalizeCaseRoots(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 ||
      !Array.isArray(value.root_issue_ids) || value.root_issue_ids.length === 0 || value.root_issue_ids.length > 8 ||
      !value.root_issue_ids.every((rootIssueId) => ROOT_ISSUE_ID.test(rootIssueId)) ||
      new Set(value.root_issue_ids).size !== value.root_issue_ids.length) {
    return null;
  }
  return Object.freeze({ root_issue_ids: Object.freeze([...value.root_issue_ids]) });
}

export async function runConfiguredParallelBlackBoxE2ECampaign({
  environment = process.env,
} = {}) {
  loadE2EConfig({ environment });
  throw stableError("parallel_black_box_campaign_runtime_unavailable");
}

async function readFinalEvidenceSnapshot({ ports, caseContext, e2eCase, caseRoots, observedAt }) {
  try {
    return await ports.readFreshEvidenceSnapshot({ caseContext, e2eCase, caseRoots });
  } catch {
    return {
      kind: "incomplete",
      observed_at: observedAt(),
      omissions: [{ source_id: caseRoots.root_issue_ids[0], reason_code: "fresh_evidence_read_failed" }],
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

function assertPorts(ports, campaign) {
  if (!ports || typeof ports !== "object") throw stableError("parallel_black_box_campaign_ports_invalid");
  for (const method of [
    "createCaseRoots",
    "waitForHumanAction",
    "waitForInFlightStage",
    "readFreshEvidenceSnapshot",
  ]) {
    if (typeof ports[method] !== "function") throw stableError("parallel_black_box_campaign_ports_invalid");
  }
  if (!ports.human || typeof ports.human.readActorId !== "function" || typeof ports.human.readSymphonyActorId !== "function" ||
      typeof ports.human.resolveHumanAction !== "function" || typeof ports.human.updateRoot !== "function") {
    throw stableError("parallel_black_box_campaign_ports_invalid");
  }
  if (campaign.cases.some((e2eCase) => e2eCase.human_script_id === "revise_root") && [
    "createComment", "editComment", "resolveCommentThread", "reopenCommentThread",
  ].some((method) => typeof ports.human[method] !== "function")) {
    throw stableError("parallel_black_box_campaign_ports_invalid");
  }
  if (campaign.cases.some((e2eCase) => e2eCase.human_script_id === "revise_root") &&
      typeof ports.waitForRootReconcilerReply !== "function") {
    throw stableError("parallel_black_box_campaign_ports_invalid");
  }
  if (campaign.cases.some((e2eCase) => e2eCase.human_script_id === "restart_conductor") &&
      typeof ports.restartConductor !== "function") {
    throw stableError("parallel_black_box_campaign_ports_invalid");
  }
}

async function readActorIds(human) {
  try {
    const [humanActorId, symphonyActorId] = await Promise.all([human.readActorId(), human.readSymphonyActorId()]);
    if (!ROOT_ISSUE_ID.test(humanActorId) || !ROOT_ISSUE_ID.test(symphonyActorId) || humanActorId === symphonyActorId) {
      throw new Error("invalid actors");
    }
    return Object.freeze({ humanActorId, symphonyActorId });
  } catch {
    throw stableError("parallel_black_box_human_actor_identity_invalid");
  }
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
