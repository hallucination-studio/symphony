import { bindSameConductorPreemptionRoles, FOREGROUND_E2E_CASES } from "./cases.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const CORE_ROOT_KEYS = Object.freeze(["inflight-root", "touched-root", "remaining-root"]);
const LOW_PRIORITY_ROOT_KEY = "low-priority-root";

export async function runSameConductorPreemptionCase({ definition, human, rootCreationsByRootKey, signal } = {}) {
  assertDefinition(definition);
  const rootCreations = assertInput({ definition, human, rootCreationsByRootKey, signal });

  const roots = definition.rootTopology.map((topology) => {
    const creation = rootCreations.get(topology.rootKey);
    const root = { rootIssueId: creation.rootIssueId, identifier: creation.identifier };
    if (!identifier(root?.rootIssueId) || !identifier(root?.identifier)) {
      throw stableError("foreground_e2e_preemption_root_create_invalid");
    }
    return Object.freeze({ topology, root });
  });

  const rootIssueIdsByKey = Object.freeze(Object.fromEntries(roots.map(({ topology, root }) => [topology.rootKey, root.rootIssueId])));
  const admission = assertAdmission(
    await human.waitForSameConductorPreemptionAdmission(waitInput({ rootIssueIds: CORE_ROOT_KEYS.map((rootKey) => rootIssueIdsByKey[rootKey]), signal })),
    Object.fromEntries(CORE_ROOT_KEYS.map((rootKey) => [rootKey, rootIssueIdsByKey[rootKey]])),
  );
  const roles = bindSameConductorPreemptionRoles({
    inflightRootKeys: [rootKeyFor(rootIssueIdsByKey, admission.inflightRootIssueId)],
    readyRootKeys: admission.readyRootIssueIds.map((rootIssueId) => rootKeyFor(rootIssueIdsByKey, rootIssueId)),
  });
  const touch = await human.updateRootDescription({
    rootIssueId: rootIssueIdsByKey[roles.touchedRootKey],
    description: roles.touchDescription,
    ...(signal ? { signal } : {}),
  });
  assertTouch(touch);

  const candidate = assertCandidate(
    await human.waitForSameConductorPreemptionCandidate(waitInput({
      inflightStageIssueId: admission.inflightStageIssueId,
      touchedRootIssueId: rootIssueIdsByKey[roles.touchedRootKey],
      remainingRootIssueId: rootIssueIdsByKey[roles.remainingRootKey],
      signal,
    })),
    rootIssueIdsByKey[roles.touchedRootKey],
  );

  const requests = await Promise.all(roots.map(async ({ root }) => {
    const request = await human.waitForPlanApprovalRequest({
      rootIssueId: root.rootIssueId,
      ...(signal ? { signal } : {}),
    });
    if (!identifier(request?.requestCommentId) || !identifier(request?.planIssueId)) {
      throw stableError("foreground_e2e_preemption_plan_review_invalid");
    }
    return Object.freeze({ ...request, rootIssueId: root.rootIssueId });
  }));
  if (new Set(requests.map(({ requestCommentId }) => requestCommentId)).size !== requests.length) {
    throw stableError("foreground_e2e_preemption_plan_review_invalid");
  }
  await Promise.all(requests.map((request) => human.replyToHumanAction({
    rootIssueId: request.rootIssueId,
    requestCommentId: request.requestCommentId,
    body: "Approved.",
    ...(signal ? { signal } : {}),
  })));

  return deepFreeze({
    context: {
      humanActorId: human.actorId,
      rootIssueIdsByKey,
      preemption: {
        inflightRootId: admission.inflightRootIssueId,
        touchedRootId: rootIssueIdsByKey[roles.touchedRootKey],
        remainingRootId: rootIssueIdsByKey[roles.remainingRootKey],
        inflightStageIssueId: admission.inflightStageIssueId,
        touchedStageIssueId: candidate.stageIssueId,
        touchedRootKey: roles.touchedRootKey,
        touchActivityId: candidate.touchActivityId,
        conductorId: rootCreations.get(roles.inflightRootKey).conductorId,
        lowPriorityRootId: rootIssueIdsByKey[LOW_PRIORITY_ROOT_KEY],
      },
    },
  });
}

function assertDefinition(definition) {
  const canonical = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "same_conductor_preemption");
  if (definition !== canonical || definition.rootTopology.length !== 4 ||
      new Set(definition.rootTopology.map(({ conductorRef }) => conductorRef)).size !== 1 ||
      new Set(definition.rootTopology.map(({ repositoryRef }) => repositoryRef)).size !== definition.rootTopology.length ||
      !CORE_ROOT_KEYS.every((rootKey) => definition.rootCreationInputs.find((input) => input.rootKey === rootKey)?.priority === "high") ||
      definition.rootCreationInputs.find((input) => input.rootKey === LOW_PRIORITY_ROOT_KEY)?.priority !== "low") {
    throw stableError("foreground_e2e_preemption_case_definition_invalid");
  }
}

function assertInput({ definition, human, rootCreationsByRootKey, signal }) {
  if (!human || !identifier(human.actorId) || typeof human.waitForSameConductorPreemptionAdmission !== "function" ||
      typeof human.updateRootDescription !== "function" ||
      typeof human.waitForSameConductorPreemptionCandidate !== "function" || typeof human.waitForPlanApprovalRequest !== "function" ||
      typeof human.replyToHumanAction !== "function" || !rootCreationsByRootKey ||
      typeof rootCreationsByRootKey !== "object" || Array.isArray(rootCreationsByRootKey) ||
      signal !== undefined && (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function")) {
    throw stableError("foreground_e2e_preemption_case_input_invalid");
  }
  const rootKeys = definition.rootTopology.map(({ rootKey }) => rootKey);
  if (Object.keys(rootCreationsByRootKey).length !== rootKeys.length ||
      rootKeys.some((rootKey) => !Object.hasOwn(rootCreationsByRootKey, rootKey))) {
    throw stableError("foreground_e2e_preemption_case_input_invalid");
  }
  const creations = new Map(rootKeys.map((rootKey) => [rootKey, validRootCreation(rootCreationsByRootKey[rootKey]) ]));
  if ([...creations.values()].some((creation) => !creation)) {
    throw stableError("foreground_e2e_preemption_case_input_invalid");
  }
  const unique = (field) => new Set([...creations.values()].map((creation) => creation[field])).size === 1;
  if (!unique("teamId") || !unique("projectId") || !unique("routingLabelId") || !unique("rootStatusId") || !unique("conductorId")) {
    throw stableError("foreground_e2e_preemption_case_input_invalid");
  }
  return creations;
}

function validRootCreation(value) {
  if (!value || !identifier(value.teamId) || !identifier(value.projectId) || !identifier(value.rootLabelId) || !identifier(value.routingLabelId) ||
      !identifier(value.rootStatusId) || !identifier(value.conductorId) ||
      !identifier(value.rootIssueId) || !identifier(value.identifier)) {
    return undefined;
  }
  return Object.freeze({
    teamId: value.teamId,
    projectId: value.projectId,
    rootLabelId: value.rootLabelId,
    routingLabelId: value.routingLabelId,
    rootStatusId: value.rootStatusId,
    conductorId: value.conductorId,
    rootIssueId: value.rootIssueId,
    identifier: value.identifier,
  });
}

function assertAdmission(value, rootIssueIdsByKey) {
  if (!value || !identifier(value.inflightRootIssueId) || !identifier(value.inflightStageIssueId) ||
      !distinctIdentifiers(value.readyRootIssueIds) || value.readyRootIssueIds.length !== 2) {
    throw stableError("foreground_e2e_preemption_admission_invalid");
  }
  const knownRootIds = new Set(Object.values(rootIssueIdsByKey));
  const observedRootIds = new Set([value.inflightRootIssueId, ...value.readyRootIssueIds]);
  if (observedRootIds.size !== knownRootIds.size || [...observedRootIds].some((rootIssueId) => !knownRootIds.has(rootIssueId))) {
    throw stableError("foreground_e2e_preemption_admission_invalid");
  }
  return Object.freeze({
    inflightRootIssueId: value.inflightRootIssueId,
    inflightStageIssueId: value.inflightStageIssueId,
    readyRootIssueIds: Object.freeze([...value.readyRootIssueIds]),
  });
}

function assertTouch(value) {
  if (!value || value.kind !== "description" || !identifier(value.sourceId)) {
    throw stableError("foreground_e2e_preemption_touch_invalid");
  }
}

function assertCandidate(value, touchedRootIssueId) {
  if (!value || value.rootIssueId !== touchedRootIssueId || !identifier(value.stageIssueId) || !identifier(value.touchActivityId)) {
    throw stableError("foreground_e2e_preemption_candidate_invalid");
  }
  return Object.freeze({
    rootIssueId: value.rootIssueId,
    stageIssueId: value.stageIssueId,
    touchActivityId: value.touchActivityId,
  });
}

function rootKeyFor(rootIssueIdsByKey, rootIssueId) {
  const entry = Object.entries(rootIssueIdsByKey).find(([, issueId]) => issueId === rootIssueId);
  if (!entry) throw stableError("foreground_e2e_preemption_admission_invalid");
  return entry[0];
}

function waitInput({ signal, ...input }) {
  return { ...input, ...(signal ? { signal } : {}) };
}

function distinctIdentifiers(value) {
  return Array.isArray(value) && value.every(identifier) && new Set(value).size === value.length;
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
