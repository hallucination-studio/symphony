import { FOREGROUND_E2E_CASES } from "./cases.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const REVISION = /^[0-9a-f]{40,64}$/u;

export async function runMissingWorktreeRecoveryCase({ definition, human, runtime, rootCreationsByRootKey, signal } = {}) {
  assertDefinition(definition);
  const creations = assertInput({ human, runtime, rootCreationsByRootKey, signal });
  const roots = await Promise.all(definition.rootTopology.map(async ({ rootKey }) => {
    const root = await human.createRootIssue({
      caseId: definition.caseId,
      rootKey,
      ...rootCreationInput(creations.get(rootKey)),
      ...(signal ? { signal } : {}),
    });
    if (!identifier(root?.rootIssueId) || !rootIdentifier(root?.identifier)) {
      throw stableError("foreground_e2e_missing_worktree_root_create_invalid");
    }
    return Object.freeze({ rootKey, root });
  }));
  await Promise.all(roots.map(({ root }) => human.assertRootUndelegatedAndInactive({
    rootIssueId: root.rootIssueId,
    ...(signal ? { signal } : {}),
  })));
  await Promise.all(roots.map(({ root }) => human.delegateRootIssue({
    rootIssueId: root.rootIssueId,
    ...(signal ? { signal } : {}),
  })));

  const initialApprovals = await Promise.all(roots.map(async ({ rootKey, root }) => {
    const request = assertPlanGate(await human.waitForPlanApprovalRequest({
      rootIssueId: root.rootIssueId,
      ...(signal ? { signal } : {}),
    }), "foreground_e2e_missing_worktree_initial_approval_invalid");
    const reply = await human.replyToHumanAction({
      rootIssueId: root.rootIssueId,
      requestCommentId: request.requestCommentId,
      body: "Approved.",
      ...(signal ? { signal } : {}),
    });
    if (!identifier(reply?.commentId) || reply.requestCommentId !== request.requestCommentId) {
      throw stableError("foreground_e2e_missing_worktree_initial_approval_invalid");
    }
    return Object.freeze({ rootKey, root, request, reply });
  }));
  if (new Set(initialApprovals.flatMap(({ request, reply }) => [request.requestCommentId, reply.commentId])).size !== roots.length * 2) {
    throw stableError("foreground_e2e_missing_worktree_initial_approval_invalid");
  }

  const rootIssueIds = roots.map(({ root }) => root.rootIssueId);
  const admission = assertAdmission(await human.waitForMissingWorktreeRecoveryAdmission({
    rootIssueIds,
    ...(signal ? { signal } : {}),
  }), rootIssueIds);
  const faults = roots.map(({ rootKey, root }) => Object.freeze({
    conductorId: creations.get(rootKey).conductorId,
    rootIssueId: root.rootIssueId,
    rootIdentifier: root.identifier,
    invalidateExecutionBranch: rootKey === "invalid-generation-root",
  }));
  const faultResult = assertFaultResult(await runtime.removeRootWorktreesAndRestart({ faults }), faults);

  const invalidApproval = initialApprovals.find(({ rootKey }) => rootKey === "invalid-generation-root");
  const freshPlan = assertPlanGate(await human.waitForSuccessorPlanApprovalGate({
    rootIssueId: invalidApproval.root.rootIssueId,
    priorCycleIssueId: invalidApproval.request.cycleIssueId,
    priorRequestCommentId: invalidApproval.request.requestCommentId,
    ...(signal ? { signal } : {}),
  }), "foreground_e2e_missing_worktree_fresh_approval_invalid");
  const oldInvalidIds = new Set(admission.nativeIssueIdsByRootId[invalidApproval.root.rootIssueId]);
  if (oldInvalidIds.has(freshPlan.cycleIssueId) || oldInvalidIds.has(freshPlan.planIssueId) ||
      freshPlan.requestCommentId === invalidApproval.request.requestCommentId) {
    throw stableError("foreground_e2e_missing_worktree_fresh_approval_invalid");
  }
  const freshReply = await human.replyToHumanAction({
    rootIssueId: invalidApproval.root.rootIssueId,
    requestCommentId: freshPlan.requestCommentId,
    body: "Approved.",
    ...(signal ? { signal } : {}),
  });
  if (!identifier(freshReply?.commentId) || freshReply.requestCommentId !== freshPlan.requestCommentId ||
      freshReply.commentId === invalidApproval.reply.commentId) {
    throw stableError("foreground_e2e_missing_worktree_fresh_approval_invalid");
  }

  const recoverable = initialApprovals.find(({ rootKey }) => rootKey === "recoverable-worktree-root");
  const recoverableFault = faultResult.get(recoverable.root.rootIssueId);
  const invalidFault = faultResult.get(invalidApproval.root.rootIssueId);
  return deepFreeze({
    context: {
      humanActorId: human.actorId,
      rootIssueIdsByKey: Object.fromEntries(roots.map(({ rootKey, root }) => [rootKey, root.rootIssueId])),
      missingWorktree: {
        recoverableRootId: recoverable.root.rootIssueId,
        invalidRootId: invalidApproval.root.rootIssueId,
        oldCycleId: invalidApproval.request.cycleIssueId,
        oldNativeIssueIds: admission.nativeIssueIdsByRootId[invalidApproval.root.rootIssueId]
          .filter((issueId) => issueId !== invalidApproval.root.rootIssueId),
        freshCycleIssueId: freshPlan.cycleIssueId,
        freshPlanIssueId: freshPlan.planIssueId,
        oldApprovalCommentId: invalidApproval.reply.commentId,
        freshApprovalCommentId: freshReply.commentId,
        missingDetectedAt: recoverableFault.removedAt,
        firstPostRecoveryDispatchAt: freshPlan.planRemoteVersion,
        originalBranch: recoverableFault.branch,
        beforeRevision: recoverableFault.headRevision,
        invalidBranch: invalidFault.branch,
        invalidRevision: invalidFault.headRevision,
        oldVerifyIssueIdsByRootId: admission.verifyIssueIdsByRootId,
      },
    },
  });
}

function assertDefinition(definition) {
  const canonical = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "missing_worktree_recovery");
  if (definition !== canonical || definition.rootTopology.length !== 2 ||
      new Set(definition.rootTopology.map(({ conductorRef }) => conductorRef)).size !== 2 ||
      new Set(definition.rootTopology.map(({ repositoryRef }) => repositoryRef)).size !== 2) {
    throw stableError("foreground_e2e_missing_worktree_case_definition_invalid");
  }
}

function assertInput({ human, runtime, rootCreationsByRootKey, signal }) {
  if (!human || !identifier(human.actorId) || typeof human.createRootIssue !== "function" ||
      typeof human.assertRootUndelegatedAndInactive !== "function" || typeof human.delegateRootIssue !== "function" ||
      typeof human.waitForPlanApprovalRequest !== "function" || typeof human.replyToHumanAction !== "function" ||
      typeof human.waitForMissingWorktreeRecoveryAdmission !== "function" ||
      typeof human.waitForSuccessorPlanApprovalGate !== "function" || !runtime ||
      typeof runtime.removeRootWorktreesAndRestart !== "function" || !rootCreationsByRootKey ||
      typeof rootCreationsByRootKey !== "object" || Array.isArray(rootCreationsByRootKey) ||
      signal !== undefined && (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function")) {
    throw stableError("foreground_e2e_missing_worktree_case_input_invalid");
  }
  const keys = ["recoverable-worktree-root", "invalid-generation-root"];
  if (Object.keys(rootCreationsByRootKey).length !== keys.length || keys.some((key) => !Object.hasOwn(rootCreationsByRootKey, key))) {
    throw stableError("foreground_e2e_missing_worktree_case_input_invalid");
  }
  const creations = new Map(keys.map((key) => [key, validRootCreation(rootCreationsByRootKey[key])]));
  if ([...creations.values()].some((value) => !value) ||
      new Set([...creations.values()].map(({ conductorId }) => conductorId)).size !== keys.length ||
      new Set([...creations.values()].map(({ worktreeDirectory }) => worktreeDirectory)).size !== keys.length) {
    throw stableError("foreground_e2e_missing_worktree_case_input_invalid");
  }
  return creations;
}

function assertPlanGate(value, code) {
  if (!value || !identifier(value.cycleIssueId) || !identifier(value.planIssueId) || !identifier(value.requestCommentId) ||
      !timestamp(value.planRemoteVersion)) {
    throw stableError(code);
  }
  return value;
}

function assertAdmission(value, rootIssueIds) {
  if (!value || !exactIdentityMap(value.verifyIssueIdsByRootId, rootIssueIds) ||
      !value.nativeIssueIdsByRootId || Object.keys(value.nativeIssueIdsByRootId).length !== rootIssueIds.length ||
      rootIssueIds.some((rootIssueId) => !Array.isArray(value.nativeIssueIdsByRootId[rootIssueId]) ||
        value.nativeIssueIdsByRootId[rootIssueId].length < 4 ||
        !value.nativeIssueIdsByRootId[rootIssueId].every(identifier))) {
    throw stableError("foreground_e2e_missing_worktree_admission_invalid");
  }
  return value;
}

function assertFaultResult(value, faults) {
  if (!value || !Array.isArray(value.faults) || value.faults.length !== faults.length) {
    throw stableError("foreground_e2e_missing_worktree_fault_invalid");
  }
  const byRoot = new Map(value.faults.map((fault) => [fault?.rootIssueId, fault]));
  for (const expected of faults) {
    const actual = byRoot.get(expected.rootIssueId);
    if (!actual || actual.conductorId !== expected.conductorId || actual.rootIdentifier !== expected.rootIdentifier ||
        actual.invalidateExecutionBranch !== expected.invalidateExecutionBranch ||
        actual.invalidated !== expected.invalidateExecutionBranch || !branch(actual.branch) ||
        !REVISION.test(actual.headRevision) || !timestamp(actual.removedAt)) {
      throw stableError("foreground_e2e_missing_worktree_fault_invalid");
    }
  }
  return byRoot;
}

function exactIdentityMap(value, rootIssueIds) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === rootIssueIds.length &&
    rootIssueIds.every((rootIssueId) => identifier(value[rootIssueId]));
}

function validRootCreation(value) {
  return value && identifier(value.teamId) && identifier(value.projectId) && identifier(value.routingLabelId) &&
    identifier(value.rootStatusId) && identifier(value.conductorId) && identifier(value.performerProfileId) &&
    directory(value.worktreeDirectory) ? Object.freeze({ ...value }) : undefined;
}

function rootCreationInput({ teamId, projectId, routingLabelId, rootStatusId }) {
  return { teamId, projectId, routingLabelId, rootStatusId };
}

function identifier(value) { return typeof value === "string" && IDENTIFIER.test(value); }
function rootIdentifier(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value); }
function branch(value) { return typeof value === "string" && /^symphony\/runs\/[a-z0-9][a-z0-9._-]{0,127}$/u.test(value); }
function directory(value) { return typeof value === "string" && value.startsWith("/") && value.length <= 4_096; }
function timestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.values(value).forEach(deepFreeze); return Object.freeze(value); }
function stableError(code) { const error = new Error(code); error.code = code; return error; }
