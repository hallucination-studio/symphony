import { FOREGROUND_E2E_CASES } from "./cases.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export async function runParallelMultiConductorCase({ definition, human, rootCreationsByRootKey, signal } = {}) {
  assertDefinition(definition);
  const rootCreations = assertInput({ definition, human, rootCreationsByRootKey, signal });

  const roots = await Promise.all(definition.rootTopology.map(async (topology) => {
    const creation = rootCreations.get(topology.rootKey);
    const root = await human.createRootIssue({
      caseId: definition.caseId,
      rootKey: topology.rootKey,
      teamId: creation.teamId,
      projectId: creation.projectId,
      routingLabelId: creation.routingLabelId,
      rootStatusId: creation.rootStatusId,
    });
    if (!identifier(root?.rootIssueId) || !identifier(root?.identifier)) {
      throw stableError("foreground_e2e_parallel_root_create_invalid");
    }
    return Object.freeze({ topology, creation, root });
  }));

  const actions = await Promise.all(roots.map(async ({ root }) => {
    const action = await human.waitForPlanReviewAction({
      rootIssueId: root.rootIssueId,
      terminalStatus: "Approved",
      ...(signal ? { signal } : {}),
    });
    if (!identifier(action?.actionIssueId) || !identifier(action?.terminalStatusId)) {
      throw stableError("foreground_e2e_parallel_plan_review_invalid");
    }
    return Object.freeze(action);
  }));
  await Promise.all(actions.map((action) => human.setHumanActionTerminalStatus({
    issueId: action.actionIssueId,
    terminalStatus: "Approved",
    stateId: action.terminalStatusId,
  })));

  return Object.freeze({
    context: Object.freeze({
      humanActorId: human.actorId,
      rootIssueIdsByKey: Object.freeze(Object.fromEntries(roots.map(({ topology, root }) => [topology.rootKey, root.rootIssueId]))),
      parallel: Object.freeze({
        roots: Object.freeze(roots.map(({ topology, creation, root }, index) => Object.freeze({
          rootKey: topology.rootKey,
          conductorRef: topology.conductorRef,
          repositoryRef: topology.repositoryRef,
          rootIssueId: root.rootIssueId,
          planReviewActionIssueId: actions[index].actionIssueId,
          routingLabelId: creation.routingLabelId,
          conductorId: creation.conductorId,
          performerProfileId: creation.performerProfileId,
          repositoryRoot: creation.repositoryRoot,
        }))),
      }),
    }),
  });
}

function assertDefinition(definition) {
  const canonical = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "parallel_multi_conductor");
  if (definition !== canonical || definition.rootTopology.length < 2 ||
      new Set(definition.rootTopology.map(({ conductorRef }) => conductorRef)).size !== definition.rootTopology.length ||
      new Set(definition.rootTopology.map(({ repositoryRef }) => repositoryRef)).size !== definition.rootTopology.length) {
    throw stableError("foreground_e2e_parallel_case_definition_invalid");
  }
}

function assertInput({ definition, human, rootCreationsByRootKey, signal }) {
  if (!human || !identifier(human.actorId) || typeof human.createRootIssue !== "function" ||
      typeof human.waitForPlanReviewAction !== "function" || typeof human.setHumanActionTerminalStatus !== "function" ||
      !rootCreationsByRootKey || typeof rootCreationsByRootKey !== "object" || Array.isArray(rootCreationsByRootKey) ||
      signal !== undefined && (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function")) {
    throw stableError("foreground_e2e_parallel_case_input_invalid");
  }
  const rootKeys = definition.rootTopology.map(({ rootKey }) => rootKey);
  if (Object.keys(rootCreationsByRootKey).length !== rootKeys.length ||
      rootKeys.some((rootKey) => !Object.hasOwn(rootCreationsByRootKey, rootKey))) {
    throw stableError("foreground_e2e_parallel_case_input_invalid");
  }
  const creations = new Map(rootKeys.map((rootKey) => [rootKey, validRootCreation(rootCreationsByRootKey[rootKey])]));
  if ([...creations.values()].some((creation) => !creation) ||
      new Set([...creations.values()].map(({ routingLabelId }) => routingLabelId)).size !== rootKeys.length ||
      new Set([...creations.values()].map(({ conductorId }) => conductorId)).size !== rootKeys.length ||
      new Set([...creations.values()].map(({ performerProfileId }) => performerProfileId)).size !== rootKeys.length ||
      new Set([...creations.values()].map(({ repositoryRoot }) => repositoryRoot)).size !== rootKeys.length) {
    throw stableError("foreground_e2e_parallel_case_input_invalid");
  }
  return creations;
}

function validRootCreation(value) {
  if (!value || !identifier(value.teamId) || !identifier(value.projectId) || !identifier(value.routingLabelId) ||
      !identifier(value.rootStatusId) || !identifier(value.conductorId) || !identifier(value.performerProfileId) ||
      !repositoryRoot(value.repositoryRoot)) {
    return undefined;
  }
  return Object.freeze({
    teamId: value.teamId,
    projectId: value.projectId,
    routingLabelId: value.routingLabelId,
    rootStatusId: value.rootStatusId,
    conductorId: value.conductorId,
    performerProfileId: value.performerProfileId,
    repositoryRoot: value.repositoryRoot,
  });
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function repositoryRoot(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.includes("\u0000");
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
