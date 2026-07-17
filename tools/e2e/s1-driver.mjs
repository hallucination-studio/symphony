import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DELIVERY_COMMAND_TIMEOUT_MS = 15_000;
const ROOT_TITLE = "[E2E] Root A";
const ROOT_DESCRIPTION = "fixed fixture";
const RUNTIME_STATUSES = new Set([
  "Stopped",
  "Starting",
  "Ready",
  "Recovering",
  "Not Responding",
  "Crashed",
  "Unbound",
  "Project Conflict",
]);
const READY_RUNTIME_STATUSES = new Set(["Ready", "Recovering"]);
const ROOT_STATES = new Set(["Todo", "In Progress", "In Review", "Done", "Canceled"]);
const WORK_NOT_STARTED_STATES = new Set(["Todo", "Canceled"]);
const ROOT_PHASES = new Set([
  "planning",
  "awaiting-human",
  "working",
  "gating",
  "delivering",
  "in-review",
  "blocked",
  "failed",
]);

export function createS1ClaimDriver({
  linear,
  client,
  git,
  delivery,
  projectSlugId,
  repositoryPath,
  baseBranch,
  githubRepository,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  now = () => Date.now(),
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  requireFunction(linear?.createAndDelegateRoot, "s1_linear_create_root_missing");
  requireFunction(linear?.readRootClaimFacts, "s1_linear_read_claim_missing");
  requireFunction(client?.openConductors, "s1_client_open_conductors_missing");
  requireFunction(client?.readProfile, "s1_client_read_profile_missing");
  requireFunction(client?.readConductorRuntime, "s1_client_read_runtime_missing");
  const slugId = requiredText(projectSlugId, "s1_project_slug_id_invalid");
  const profile = "E2E primary";
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("s1_claim_timeout_invalid");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error("s1_claim_poll_interval_invalid");
  }
  if (git !== undefined) {
    requireFunction(git?.readCommitCount, "s1_git_read_commit_count_missing");
  }
  requireFunction(now, "s1_clock_missing");
  requireFunction(sleep, "s1_sleep_missing");
  const readCommitCount = git?.readCommitCount ?? readGitCommitCount;
  if (delivery !== undefined) {
    requireFunction(delivery?.readDelivery, "s1_delivery_read_missing");
  }
  const readDelivery = delivery?.readDelivery ?? readDeliveryBoundary;

  let createdRoot;
  let claimedRoot;
  let planApproved = false;
  let workflowProcessed = false;
  let gatePassed = false;
  return Object.freeze({
    async createRootA() {
      if (createdRoot) throw new Error("s1_root_a_already_created");
      const result = await linear.createAndDelegateRoot({
        projectSlugId: slugId,
        title: ROOT_TITLE,
        description: ROOT_DESCRIPTION,
      });
      createdRoot = rootObservation(result);
      return createdRoot;
    },

    async waitForClaim() {
      if (!createdRoot?.rootId) throw new Error("s1_root_a_missing");
      await client.openConductors();
      claimedRoot = await pollUntil(
        () => readClaimObservation(createdRoot.rootId),
        claimReady,
        "s1_root_claim_timeout",
      );
      return claimedRoot;
    },

    async waitForPlan() {
      if (!claimedRoot?.rootId) throw new Error("s1_root_claim_missing");
      requireFunction(linear?.readRootPlanFacts, "s1_linear_read_plan_missing");
      return pollUntil(
        async () => planObservation(
          await linear.readRootPlanFacts({
            projectSlugId: slugId,
            rootId: claimedRoot.rootId,
          }),
          claimedRoot.rootId,
        ),
        planReady,
        "s1_plan_timeout",
      );
    },

    async observePlanBarrier() {
      return readPlanBarrier();
    },

    async approvePlan() {
      if (!claimedRoot?.rootId) throw new Error("s1_root_claim_missing");
      requireFunction(linear?.approvePlan, "s1_linear_approve_plan_missing");
      requireFunction(linear?.readRootPlanFacts, "s1_linear_read_plan_missing");
      const barrier = await readPlanBarrier();
      if (!barrier.stable) throw new Error("s1_plan_approval_precondition_failed");
      const mutation = await linear.approvePlan({
        projectSlugId: slugId,
        rootId: claimedRoot.rootId,
      });
      if (!isObject(mutation) || mutation.rootId !== claimedRoot.rootId ||
        mutation.approvalState !== "Done" || mutation.readBack !== true) {
        throw new Error("s1_plan_approval_read_back_invalid");
      }
      const facts = await pollUntil(
        async () => planObservation(
          await linear.readRootPlanFacts({
            projectSlugId: slugId,
            rootId: claimedRoot.rootId,
          }),
          claimedRoot.rootId,
        ),
        (value) => value.phase === "working" && value.workStarted === false &&
          value.planApprovalState === "Done",
        "s1_plan_approval_timeout",
      );
      planApproved = true;
      return {
        rootId: claimedRoot.rootId,
        approvalState: facts.planApprovalState,
        phase: facts.phase,
        workStarted: facts.workStarted,
        readBack: true,
      };
    },

    async processWorkflow() {
      if (!planApproved) throw new Error("s1_plan_not_approved");
      requireFunction(linear?.readRootWorkflowFacts, "s1_linear_read_workflow_missing");
      let maxConcurrentTurns = 0;
      const result = await pollUntil(
        async () => {
          const facts = workflowObservation(
            await linear.readRootWorkflowFacts({
              projectSlugId: slugId,
              rootId: claimedRoot.rootId,
            }),
            claimedRoot.rootId,
          );
          maxConcurrentTurns = Math.max(
            maxConcurrentTurns,
            facts.activeWorkLeafCount,
          );
          return { ...facts, maxConcurrentTurns };
        },
        (value) => value.workflowComplete ||
          !value.ordered ||
          value.unansweredHumanAdvanced ||
          value.activeWorkLeafCount > 1,
        "s1_workflow_timeout",
      );
      if (!result.ordered || result.unansweredHumanAdvanced ||
        !result.workflowComplete || result.maxConcurrentTurns > 1) {
        return {
          rootId: claimedRoot.rootId,
          ordered: result.ordered,
          maxConcurrentTurns: result.maxConcurrentTurns,
          unansweredHumanAdvanced: result.unansweredHumanAdvanced,
        };
      }
      workflowProcessed = true;
      return {
        rootId: claimedRoot.rootId,
        ordered: result.ordered,
        maxConcurrentTurns: result.maxConcurrentTurns,
        unansweredHumanAdvanced: result.unansweredHumanAdvanced,
      };
    },

    async waitForRootGate() {
      if (!workflowProcessed) throw new Error("s1_workflow_not_processed");
      requireFunction(linear?.readRootGateFacts, "s1_linear_read_gate_missing");
      let deliveryStartedBeforePass = false;
      const result = await pollUntil(
        async () => {
          const facts = rootGateObservation(
            await linear.readRootGateFacts({
              projectSlugId: slugId,
              rootId: claimedRoot.rootId,
            }),
            claimedRoot.rootId,
          );
          if (facts.phase !== "delivering") {
            deliveryStartedBeforePass ||= facts.pullRequestPresent;
          }
          const passed = facts.phase === "delivering" &&
            facts.workDone && facts.humanDone &&
            facts.reworkCount === 0 && facts.gateIssueCount === 0;
          const failed = facts.phase === "working" &&
            facts.reworkCount > 0;
          return {
            ...facts,
            status: passed ? "passed" : failed ? "failed" : "waiting",
            deliveryStartedBeforePass,
          };
        },
        (value) => value.status !== "waiting",
        "s1_root_gate_timeout",
      );
      const observation = {
        rootId: claimedRoot.rootId,
        status: result.status,
        deliveryStartedBeforePass: result.deliveryStartedBeforePass,
        reworkCount: result.reworkCount,
        gateIssueCount: result.gateIssueCount,
      };
      gatePassed = observation.status === "passed";
      return observation;
    },

    async waitForDelivery() {
      if (!gatePassed) throw new Error("s1_root_gate_not_passed");
      requireFunction(linear?.readRootDeliveryFacts, "s1_linear_read_delivery_missing");
      const result = await pollUntil(
        async () => {
          const facts = deliveryObservation(
            await linear.readRootDeliveryFacts({
              projectSlugId: slugId,
              rootId: claimedRoot.rootId,
            }),
            claimedRoot.rootId,
          );
          const duplicate = facts.duplicateDelivery;
          const terminal = facts.phase === "in-review" &&
            ["In Review", "Done"].includes(facts.state);
          const delivered = terminal && facts.kind !== undefined &&
            facts.managedCommentCount === 1;
          const boundary = delivered
            ? await readDelivery({
              repositoryPath,
              githubRepository,
              kind: facts.kind,
              deliveryBranch: facts.deliveryBranch,
            })
            : undefined;
          const boundaryReady = boundary?.branchPresent === true &&
            (facts.kind !== "pull_request" || boundary.pullRequestCount === 1);
          return {
            ...facts,
            status: duplicate || (terminal && (!delivered || !boundaryReady))
              ? "invalid"
              : delivered ? "ready" : "waiting",
          };
        },
        (value) => value.status !== "waiting",
        "s1_delivery_timeout",
      );
      if (result.status === "invalid") {
        throw new Error(result.duplicateDelivery
          ? "s1_delivery_duplicate"
          : "s1_delivery_boundary_invalid");
      }
      return {
        kind: result.kind,
        rootState: result.state,
        phase: result.phase,
        automaticallyCompleted: result.state === "Done",
        duplicateDelivery: result.duplicateDelivery,
      };
    },
  });

  async function readClaimObservation(rootId) {
    const [facts, profileView, runtimeView] = await Promise.all([
      linear.readRootClaimFacts({ projectSlugId: slugId, rootId }),
      client.readProfile(profile),
      client.readConductorRuntime(),
    ]);
    const safeFacts = claimFacts(facts, rootId);
    const safeProfile = profileObservation(profileView);
    const safeRuntime = runtimeObservation(runtimeView);
    return {
      ...safeFacts,
      profileReadiness: safeProfile.readiness,
      profileIsActive: safeProfile.isActive,
      runtimeStatus: safeRuntime.status,
    };
  }

  async function readPlanBarrier() {
    if (!claimedRoot?.rootId) throw new Error("s1_root_claim_missing");
    requireFunction(linear?.readRootPlanFacts, "s1_linear_read_plan_missing");
    const facts = planObservation(
      await linear.readRootPlanFacts({
        projectSlugId: slugId,
        rootId: claimedRoot.rootId,
      }),
      claimedRoot.rootId,
    );
    const deliveryBranch = requiredText(
      claimedRoot.deliveryBranch,
      "s1_delivery_branch_missing",
    );
    const commitCount = await readCommitCount({
      repositoryPath: requiredText(repositoryPath, "s1_repository_path_missing"),
      baseBranch: requiredText(baseBranch, "s1_base_branch_missing"),
      deliveryBranch,
    });
    if (!nonNegativeInteger(commitCount)) {
      throw new Error("s1_git_commit_count_invalid");
    }
    return {
      rootId: claimedRoot.rootId,
      stable: planReady(facts) && commitCount === 0,
      phase: facts.phase,
      workStates: facts.workStates,
      workStarted: facts.workStarted,
      commitCount,
    };
  }

  async function pollUntil(read, ready, timeoutCode) {
    const deadline = now() + timeoutMs;
    for (;;) {
      const observation = await read();
      if (ready(observation)) return observation;
      const remaining = deadline - now();
      if (remaining < 1) break;
      await sleep(Math.min(pollIntervalMs, remaining));
    }
    throw new Error(timeoutCode);
  }
}

function rootObservation(value) {
  if (
    !isObject(value) ||
    typeof value.rootId !== "string" ||
    !value.rootId ||
    value.delegated !== true ||
    value.readBack !== true
  ) {
    throw new Error("s1_root_create_observation_invalid");
  }
  return {
    rootId: returnedText(value.rootId, "s1_root_create_observation_invalid"),
    ...optionalReturnedText(value, "identifier"),
    ...optionalReturnedText(value, "projectId"),
    ...optionalReturnedText(value, "projectName"),
    ...optionalReturnedText(value, "state"),
    delegated: true,
    readBack: true,
  };
}

function claimFacts(value, rootId) {
  if (
    !isObject(value) ||
    value.rootId !== rootId ||
    !ROOT_STATES.has(value.state) ||
    (value.phase !== undefined && !ROOT_PHASES.has(value.phase)) ||
    !nonNegativeInteger(value.singletonCount) ||
    !nonNegativeInteger(value.managedCommentCount) ||
    typeof value.managedCommentReady !== "boolean" ||
    (value.deliveryBranch !== undefined &&
      typeof value.deliveryBranch !== "string") ||
    (value.deliveryBranch !== undefined &&
      !/^[A-Za-z0-9._/-]{1,128}$/u.test(value.deliveryBranch))
  ) {
    throw new Error("s1_claim_facts_invalid");
  }
  return {
    rootId,
    state: value.state,
    phase: value.phase,
    singletonCount: value.singletonCount,
    managedCommentCount: value.managedCommentCount,
    managedCommentReady: value.managedCommentReady,
    ...(value.deliveryBranch !== undefined
      ? { deliveryBranch: value.deliveryBranch }
      : {}),
  };
}

function profileObservation(value) {
  if (
    !isObject(value) ||
    !["login-required", "ready", "invalid"].includes(value.readiness) ||
    typeof value.isActive !== "boolean"
  ) {
    throw new Error("s1_profile_observation_invalid");
  }
  return { readiness: value.readiness, isActive: value.isActive };
}

function runtimeObservation(value) {
  if (!isObject(value) || !RUNTIME_STATUSES.has(value.status)) {
    throw new Error("s1_runtime_observation_invalid");
  }
  return { status: value.status };
}

function claimReady(value) {
  return value.state === "In Progress" &&
    value.phase === "planning" &&
    value.singletonCount === 1 &&
    value.managedCommentCount === 1 &&
    value.managedCommentReady === true &&
    value.profileReadiness === "ready" &&
    value.profileIsActive === true &&
    READY_RUNTIME_STATUSES.has(value.runtimeStatus);
}

function planObservation(value, rootId) {
  if (
    !isObject(value) ||
    value.rootId !== rootId ||
    !ROOT_STATES.has(value.state) ||
    (value.phase !== undefined && !ROOT_PHASES.has(value.phase)) ||
    typeof value.treeMatches !== "boolean" ||
    !nonNegativeInteger(value.planApprovalCount) ||
    (value.planApprovalState !== undefined && !ROOT_STATES.has(value.planApprovalState)) ||
    typeof value.planApprovalReady !== "boolean" ||
    typeof value.plannedRootInputReady !== "boolean" ||
    !Array.isArray(value.workStates) ||
    value.workStates.length > 250 ||
    !value.workStates.every((state) => ROOT_STATES.has(state)) ||
    typeof value.workStarted !== "boolean"
  ) {
    throw new Error("s1_plan_facts_invalid");
  }
  return {
    rootId,
    state: value.state,
    phase: value.phase,
    treeMatches: value.treeMatches,
    planApprovalCount: value.planApprovalCount,
    ...(value.planApprovalState !== undefined
      ? { planApprovalState: value.planApprovalState }
      : {}),
    planApprovalReady: value.planApprovalReady,
    plannedRootInputReady: value.plannedRootInputReady,
    workStates: [...value.workStates],
    workStarted: value.workStarted,
  };
}

function workflowObservation(value, rootId) {
  if (
    !isObject(value) ||
    value.rootId !== rootId ||
    typeof value.phase !== "string" ||
    !ROOT_PHASES.has(value.phase) ||
    typeof value.ordered !== "boolean" ||
    !nonNegativeInteger(value.activeWorkLeafCount) ||
    typeof value.unansweredHumanAdvanced !== "boolean" ||
    typeof value.workflowComplete !== "boolean"
  ) {
    throw new Error("s1_workflow_facts_invalid");
  }
  return {
    rootId,
    phase: value.phase,
    ordered: value.ordered,
    activeWorkLeafCount: value.activeWorkLeafCount,
    unansweredHumanAdvanced: value.unansweredHumanAdvanced,
    workflowComplete: value.workflowComplete,
  };
}

function rootGateObservation(value, rootId) {
  if (
    !isObject(value) ||
    value.rootId !== rootId ||
    typeof value.state !== "string" ||
    !ROOT_STATES.has(value.state) ||
    typeof value.phase !== "string" ||
    !ROOT_PHASES.has(value.phase) ||
    typeof value.workDone !== "boolean" ||
    typeof value.humanDone !== "boolean" ||
    !nonNegativeInteger(value.reworkCount) ||
    !nonNegativeInteger(value.gateIssueCount) ||
    typeof value.pullRequestPresent !== "boolean"
  ) {
    throw new Error("s1_root_gate_facts_invalid");
  }
  return {
    rootId,
    state: value.state,
    phase: value.phase,
    workDone: value.workDone,
    humanDone: value.humanDone,
    reworkCount: value.reworkCount,
    gateIssueCount: value.gateIssueCount,
    pullRequestPresent: value.pullRequestPresent,
  };
}

function deliveryObservation(value, rootId) {
  if (
    !isObject(value) ||
    value.rootId !== rootId ||
    typeof value.state !== "string" ||
    !ROOT_STATES.has(value.state) ||
    typeof value.phase !== "string" ||
    !ROOT_PHASES.has(value.phase) ||
    (value.kind !== undefined && !["pull_request", "branch"].includes(value.kind)) ||
    (value.deliveryBranch !== undefined &&
      !/^[A-Za-z0-9._/-]{1,128}$/u.test(value.deliveryBranch)) ||
    typeof value.pullRequestPresent !== "boolean" ||
    !nonNegativeInteger(value.managedCommentCount) ||
    typeof value.duplicateDelivery !== "boolean"
  ) {
    throw new Error("s1_delivery_facts_invalid");
  }
  return {
    rootId,
    state: value.state,
    phase: value.phase,
    ...(value.kind !== undefined ? { kind: value.kind } : {}),
    ...(value.deliveryBranch !== undefined
      ? { deliveryBranch: value.deliveryBranch }
      : {}),
    pullRequestPresent: value.pullRequestPresent,
    managedCommentCount: value.managedCommentCount,
    duplicateDelivery: value.duplicateDelivery,
  };
}

function planReady(value) {
  return value.state === "In Progress" &&
    value.phase === "awaiting-human" &&
    value.treeMatches === true &&
    value.planApprovalCount === 1 &&
    value.planApprovalState === "In Progress" &&
    value.planApprovalReady === true &&
    value.plannedRootInputReady === true &&
    value.workStates.every((state) => WORK_NOT_STARTED_STATES.has(state)) &&
    value.workStarted === false;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function requiredText(value, code) {
  if (typeof value !== "string" || !value || value.length > 16_384 || /[\r\n\0]/u.test(value)) {
    throw new Error(code);
  }
  return value;
}

function returnedText(value, code) {
  if (typeof value !== "string" || !value || value.length > 16_384 || /[\r\n\0]/u.test(value)) {
    throw new Error(code);
  }
  return value;
}

function optionalReturnedText(value, key) {
  if (value[key] === undefined) return {};
  return { [key]: returnedText(value[key], "s1_root_create_observation_invalid") };
}

function requireFunction(value, code) {
  if (typeof value !== "function") throw new Error(code);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readGitCommitCount({ repositoryPath, baseBranch, deliveryBranch }) {
  const repository = requiredText(repositoryPath, "s1_repository_path_missing");
  const base = gitRef(baseBranch, "s1_base_branch_invalid");
  const delivery = gitRef(deliveryBranch, "s1_delivery_branch_invalid");
  let result;
  try {
    result = await execFileAsync(
      "git",
      ["-C", repository, "rev-list", "--count", `${base}..${delivery}`],
      { encoding: "utf8", maxBuffer: 16_384 },
    );
  } catch {
    throw new Error("s1_git_commit_count_read_failed");
  }
  const output = result.stdout.trim();
  if (!/^\d+$/u.test(output)) throw new Error("s1_git_commit_count_invalid");
  const count = Number(output);
  if (!Number.isSafeInteger(count)) throw new Error("s1_git_commit_count_invalid");
  return count;
}

async function readDeliveryBoundary({
  repositoryPath,
  githubRepository,
  kind,
  deliveryBranch,
}) {
  const repository = requiredText(repositoryPath, "s1_repository_path_missing");
  const branch = gitRef(deliveryBranch, "s1_delivery_branch_invalid");
  if (kind !== "branch" && kind !== "pull_request") {
    throw new Error("s1_delivery_kind_invalid");
  }
  await readGitBranch(repository, branch);
  if (kind === "branch") return { branchPresent: true, pullRequestCount: 0 };
  const remoteRepository = githubRepositoryRef(
    githubRepository,
    "s1_github_repository_missing",
  );
  let result;
  try {
    result = await execFileAsync(
      "gh",
      [
        "pr", "list",
        "--repo", remoteRepository,
        "--head", branch,
        "--state", "all",
        "--json", "number",
        "--limit", "10",
      ],
      {
        encoding: "utf8",
        maxBuffer: 16_384,
        timeout: DELIVERY_COMMAND_TIMEOUT_MS,
      },
    );
  } catch {
    throw new Error("s1_github_delivery_read_failed");
  }
  let pullRequests;
  try {
    pullRequests = JSON.parse(result.stdout);
  } catch {
    throw new Error("s1_github_delivery_response_invalid");
  }
  if (!Array.isArray(pullRequests) || pullRequests.length > 10 ||
    !pullRequests.every((pullRequest) =>
      isObject(pullRequest) && Number.isSafeInteger(pullRequest.number) &&
      pullRequest.number > 0,
    )) {
    throw new Error("s1_github_delivery_response_invalid");
  }
  return { branchPresent: true, pullRequestCount: pullRequests.length };
}

async function readGitBranch(repositoryPath, branch) {
  try {
    await execFileAsync(
      "git",
      ["-C", repositoryPath, "show-ref", "--verify", `refs/heads/${branch}`],
      {
        encoding: "utf8",
        maxBuffer: 16_384,
        timeout: DELIVERY_COMMAND_TIMEOUT_MS,
      },
    );
  } catch {
    throw new Error("s1_delivery_branch_read_failed");
  }
}

function githubRepositoryRef(value, code) {
  if (typeof value !== "string" || !/^[^/\s]{1,100}\/[^/\s]{1,100}$/u.test(value)) {
    throw new Error(code);
  }
  return value;
}

function gitRef(value, code) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value)) {
    throw new Error(code);
  }
  return value;
}
