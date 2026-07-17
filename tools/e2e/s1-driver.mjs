const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
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
  projectSlugId,
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
  requireFunction(now, "s1_clock_missing");
  requireFunction(sleep, "s1_sleep_missing");

  let createdRoot;
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
      const deadline = now() + timeoutMs;
      while (true) {
        const observation = await readClaimObservation(createdRoot.rootId);
        if (claimReady(observation)) return observation;
        const remaining = deadline - now();
        if (remaining < 1) break;
        await sleep(Math.min(pollIntervalMs, remaining));
      }
      throw new Error("s1_root_claim_timeout");
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
