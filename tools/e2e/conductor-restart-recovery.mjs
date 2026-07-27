import path from "node:path";

import { FOREGROUND_E2E_CASES } from "./cases.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export async function runConductorRestartRecoveryCase({ definition, human, runtime, rootCreationsByRootKey, signal } = {}) {
  assertDefinition(definition);
  const rootCreations = assertInput({ human, runtime, rootCreationsByRootKey, signal });
  const roots = await Promise.all(definition.rootTopology.map(async (topology) => {
    const root = await human.createRootIssue({
      caseId: definition.caseId,
      rootKey: topology.rootKey,
      ...rootCreationInput(rootCreations.get(topology.rootKey)),
      ...(signal ? { signal } : {}),
    });
    if (!identifier(root?.rootIssueId) || !identifier(root?.identifier)) {
      throw stableError("foreground_e2e_recovery_root_create_invalid");
    }
    return Object.freeze({ topology, root });
  }));
  await Promise.all(roots.map(({ root }) => human.assertRootUndelegatedAndInactive({
    rootIssueId: root.rootIssueId,
    ...(signal ? { signal } : {}),
  })));
  await Promise.all(roots.map(({ root }) => human.delegateRootIssue({
    rootIssueId: root.rootIssueId,
    ...(signal ? { signal } : {}),
  })));
  const rootIssueIdsByKey = Object.freeze(Object.fromEntries(roots.map(({ topology, root }) => [topology.rootKey, root.rootIssueId])));
  const affected = rootForKey(roots, "affected-root");
  const continuous = rootForKey(roots, "continuous-root");
  const admission = assertAdmission(await human.waitForRestartRecoveryAdmission(waitInput({
    affectedRootIssueId: affected.root.rootIssueId,
    continuousRootIssueId: continuous.root.rootIssueId,
    signal,
  })), affected.root.rootIssueId);
  const restarted = await runtime.killAndRestartConductor({ conductorId: rootCreations.get("affected-root").conductorId });
  if (restarted?.conductorId !== rootCreations.get("affected-root").conductorId) {
    throw stableError("foreground_e2e_recovery_restart_invalid");
  }

  const requests = await Promise.all(roots.map(async ({ root }) => {
    const request = await human.waitForPlanApprovalRequest({
      rootIssueId: root.rootIssueId,
      ...(signal ? { signal } : {}),
    });
    if (!identifier(request?.requestCommentId) || !identifier(request?.planIssueId)) {
      throw stableError("foreground_e2e_recovery_plan_review_invalid");
    }
    return Object.freeze({ ...request, rootIssueId: root.rootIssueId });
  }));
  if (new Set(requests.map(({ requestCommentId }) => requestCommentId)).size !== requests.length) {
    throw stableError("foreground_e2e_recovery_plan_review_invalid");
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
      recovery: {
        affectedRootId: affected.root.rootIssueId,
        continuousRootId: continuous.root.rootIssueId,
        interruptedStageIssueId: admission.interruptedStageIssueId,
        affectedConductorId: rootCreations.get("affected-root").conductorId,
        continuousConductorId: rootCreations.get("continuous-root").conductorId,
        affectedRoutingLabelId: rootCreations.get("affected-root").routingLabelId,
        continuousRoutingLabelId: rootCreations.get("continuous-root").routingLabelId,
        affectedPerformerProfileId: rootCreations.get("affected-root").performerProfileId,
        continuousPerformerProfileId: rootCreations.get("continuous-root").performerProfileId,
        affectedRepositoryRoot: path.join(rootCreations.get("affected-root").worktreeDirectory, affected.root.rootIssueId),
        continuousRepositoryRoot: path.join(rootCreations.get("continuous-root").worktreeDirectory, continuous.root.rootIssueId),
      },
    },
  });
}

function assertDefinition(definition) {
  const canonical = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "conductor_restart_recovery");
  if (definition !== canonical || definition.rootTopology.length !== 2 ||
      new Set(definition.rootTopology.map(({ conductorRef }) => conductorRef)).size !== 2 ||
      new Set(definition.rootTopology.map(({ repositoryRef }) => repositoryRef)).size !== 2) {
    throw stableError("foreground_e2e_recovery_case_definition_invalid");
  }
}

function assertInput({ human, runtime, rootCreationsByRootKey, signal }) {
  if (!human || !identifier(human.actorId) || typeof human.createRootIssue !== "function" ||
      typeof human.assertRootUndelegatedAndInactive !== "function" || typeof human.delegateRootIssue !== "function" ||
      typeof human.waitForRestartRecoveryAdmission !== "function" || typeof human.waitForPlanApprovalRequest !== "function" ||
      typeof human.replyToHumanAction !== "function" || !runtime ||
      typeof runtime.killAndRestartConductor !== "function" || !rootCreationsByRootKey ||
      typeof rootCreationsByRootKey !== "object" || Array.isArray(rootCreationsByRootKey) ||
      signal !== undefined && (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function")) {
    throw stableError("foreground_e2e_recovery_case_input_invalid");
  }
  const expectedKeys = ["affected-root", "continuous-root"];
  if (Object.keys(rootCreationsByRootKey).length !== expectedKeys.length ||
      expectedKeys.some((rootKey) => !Object.hasOwn(rootCreationsByRootKey, rootKey))) {
    throw stableError("foreground_e2e_recovery_case_input_invalid");
  }
  const creations = new Map(expectedKeys.map((rootKey) => [rootKey, validRootCreation(rootCreationsByRootKey[rootKey]) ]));
  if ([...creations.values()].some((value) => !value) ||
      new Set([...creations.values()].map(({ conductorId }) => conductorId)).size !== 2 ||
      new Set([...creations.values()].map(({ performerProfileId }) => performerProfileId)).size !== 2 ||
      new Set([...creations.values()].map(({ worktreeDirectory }) => worktreeDirectory)).size !== 2) {
    throw stableError("foreground_e2e_recovery_case_input_invalid");
  }
  return creations;
}

function rootCreationInput({ teamId, projectId, rootLabelId, routingLabelId, rootStatusId }) {
  return { teamId, projectId, rootLabelId, routingLabelId, rootStatusId };
}

function validRootCreation(value) {
  if (!value || !identifier(value.teamId) || !identifier(value.projectId) || !identifier(value.rootLabelId) || !identifier(value.routingLabelId) ||
      !identifier(value.rootStatusId) || !identifier(value.conductorId) || !identifier(value.performerProfileId) ||
      !worktreeDirectory(value.worktreeDirectory)) {
    return undefined;
  }
  return Object.freeze({ ...value });
}

function assertAdmission(value, affectedRootIssueId) {
  if (!value || value.affectedRootIssueId !== affectedRootIssueId || !identifier(value.interruptedStageIssueId)) {
    throw stableError("foreground_e2e_recovery_admission_invalid");
  }
  return Object.freeze({ interruptedStageIssueId: value.interruptedStageIssueId });
}

function rootForKey(roots, rootKey) {
  const root = roots.find(({ topology }) => topology.rootKey === rootKey);
  if (!root) throw stableError("foreground_e2e_recovery_case_definition_invalid");
  return root;
}

function waitInput({ signal, ...input }) {
  return { ...input, ...(signal ? { signal } : {}) };
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function worktreeDirectory(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.includes("\u0000");
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
