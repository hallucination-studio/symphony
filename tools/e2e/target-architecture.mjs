import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

import { loadE2EConfig } from "./config.mjs";
import { provisionApiKeyProfile } from "./conductor-profile.mjs";
import {
  createProductionPodiumConductorOwner,
  startConductorHarness,
} from "./conductor-harness.mjs";

export const TARGET_E2E_DEADLINE_MS = 300_000;

const ACCEPTANCE_HEADING = "## 9. 真实边界验收";
const execFileAsync = promisify(execFile);

const SCENARIO_COMMANDS = Object.freeze({
  linear_tree: Object.freeze([
    "tests/integration/linear-boundary-live.test.mjs",
  ]),
  production_process: Object.freeze([
    "tests/integration/agent-boundary/conductor-process.test.mjs",
    "tests/integration/agent-boundary/performer-process.test.mjs",
  ]),
  restart_recovery: Object.freeze([
    "tests/e2e/conductor-harness.test.mjs",
  ]),
});

export async function readArchitectureAcceptanceManifest(
  path = "docs/architecture/roadmap.md",
) {
  const source = await readFile(path, "utf8");
  const sectionStart = source.indexOf(`${ACCEPTANCE_HEADING}\n`);
  if (sectionStart < 0) throw new Error("architecture_acceptance_section_missing");
  const section = source.slice(sectionStart + ACCEPTANCE_HEADING.length);
  const sectionEnd = section.search(/\n##\s/u);
  const body = sectionEnd < 0 ? section : section.slice(0, sectionEnd);
  const entries = [...body.matchAll(/^\s*(\d+)\.\s+(.+)$/gmu)]
    .map((match) => ({ id: Number(match[1]), statement: match[2].trim() }));
  if (entries.length === 0) throw new Error("architecture_acceptance_entries_missing");
  const ids = entries.map(({ id }) => id);
  if (new Set(ids).size !== ids.length || ids.some((id, index) => id !== index + 1)) {
    throw new Error("architecture_acceptance_entries_not_contiguous");
  }
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

export function targetArchitectureScenarioManifest(acceptanceEntries) {
  if (!Array.isArray(acceptanceEntries) || acceptanceEntries.length !== 8) {
    throw new Error("target_architecture_acceptance_manifest_invalid");
  }
  return Object.freeze(acceptanceEntries.map((entry) => Object.freeze({
    id: entry.id,
    statement: entry.statement,
    evidence:
      entry.id === 1 ? "linear_tree" :
        entry.id === 2 || entry.id === 3 ? "production_process" :
          entry.id === 6 ? "restart_recovery" :
            "production_process",
  })));
}

export async function runTargetArchitectureEvidence({
  environment = process.env,
  deadlineAt = new Date(Date.now() + TARGET_E2E_DEADLINE_MS),
  spawnProcess = spawn,
} = {}) {
  loadE2EConfig({ environment });
  const acceptance = await readArchitectureAcceptanceManifest();
  const scenarios = targetArchitectureScenarioManifest(acceptance);
  const completedEvidence = new Set();
  for (const scenario of scenarios) {
    if (completedEvidence.has(scenario.evidence)) continue;
    await runScenarioEvidence({
      scenario: scenario.evidence,
      environment,
      deadlineAt,
      spawnProcess,
    });
    completedEvidence.add(scenario.evidence);
  }
  return Object.freeze({
    acceptanceCount: acceptance.length,
    scenarioCount: scenarios.length,
    evidenceKinds: Object.freeze([...completedEvidence].sort()),
  });
}

async function runScenarioEvidence({ scenario, environment, deadlineAt, spawnProcess }) {
  if (scenario === "production_process") {
    await runProductionRootEvidence({ environment, deadlineAt });
    return;
  }
  const testFiles = SCENARIO_COMMANDS[scenario];
  if (!testFiles) throw new Error("target_architecture_evidence_unknown");
  const args = ["--test", ...testFiles];
  const result = await runChild({
    executable: process.execPath,
    args,
    environment,
    deadlineAt,
    spawnProcess,
  });
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`target_architecture_evidence_${scenario}_failed`);
  }
}

async function runProductionRootEvidence({ environment, deadlineAt }) {
  const config = loadE2EConfig({ environment });
  const runId = `target-architecture-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runDigest = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "symphony-target-architecture-"));
  const databasePath = path.join(rootDirectory, "podium.db");
  const repositoryRoot = path.join(rootDirectory, "repository");
  const conductorDataRoot = path.join(rootDirectory, "conductor");
  let harness;
  let podium;
  let sdk;
  let gateway;
  let rootIssueId;
  const logs = [];
  try {
    await initializeRepository(repositoryRoot);
    const { LinearSdkImpl } = await import(
      "../../packages/podium/dist/internal/linear-gateway/internal/LinearSdkImpl.js"
    );
    const { LinearGatewayProtocolHandlerImpl } = await import(
      "../../packages/podium/dist/internal/linear-gateway/LinearGatewayProtocolHandlerImpl.js"
    );
    const organizationId = await LinearSdkImpl.discoverDevelopmentTokenOrganizationId(
      config.secrets.linearDevToken,
    );
    const bootstrap = new LinearSdkImpl(
      { kind: "development_token", token: config.secrets.linearDevToken, delegateActorId: "bootstrap" },
      organizationId,
    );
    const projectConfiguration = await bootstrap.readTargetProjectConfiguration({
      clientId: config.linear.clientId,
      projectSlugId: config.linear.projectSlugId,
    });
    const projectId = projectConfiguration.project.projectId;
    const pool = await bootstrap.readConductorProjectPool({ projectId });
    const conductorShortHash = pool.members[0];
    if (!conductorShortHash) throw new Error("target_e2e_conductor_pool_empty");
    sdk = new LinearSdkImpl(
      {
        kind: "development_token",
        token: config.secrets.linearDevToken,
        delegateActorId: projectConfiguration.delegateActorId,
      },
      organizationId,
    );
    gateway = new LinearGatewayProtocolHandlerImpl(sdk, {
      maxAttempts: 2,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
    });
    const root = await sdk.createRootIssue({
      projectId,
      conductorShortHash,
      title: `Target architecture ${runDigest}`,
      description: [
        "Disposable target architecture acceptance root.",
        "Execute the existing Cycle Plan, then each Work issue in order, then Verify.",
        "The two Work issues are deliberately ordinary read-only checks; do not request human action.",
        `Run marker: ${runDigest}`,
      ].join("\n"),
    });
    rootIssueId = root.rootIssueId;
    const cycleIssueId = await createChild({
      sdk, gateway, rootIssueId, projectId, conductorShortHash, issueKind: "cycle",
      title: `Cycle ${runDigest}`, description: "Run the disposable target architecture acceptance cycle.",
      marker: `${runDigest}:cycle`, statusName: "Draft",
    });
    await createChild({
      sdk, gateway, rootIssueId, projectId, conductorShortHash, parentIssueId: cycleIssueId,
      issueKind: "plan", title: `Plan ${runDigest}`, description: "Define the already-scoped two-check execution.",
      marker: `${runDigest}:plan`, statusName: "Todo",
    });
    await createChild({
      sdk, gateway, rootIssueId, projectId, conductorShortHash, parentIssueId: cycleIssueId,
      issueKind: "work", title: `Work A ${runDigest}`, description: "Inspect the repository and report the current HEAD.",
      marker: `${runDigest}:work-a`, order: 1, statusName: "Todo",
    });
    await createChild({
      sdk, gateway, rootIssueId, projectId, conductorShortHash, parentIssueId: cycleIssueId,
      issueKind: "work", title: `Work B ${runDigest}`, description: "Inspect the repository and report the current status.",
      marker: `${runDigest}:work-b`, order: 2, statusName: "Todo",
    });
    await createChild({
      sdk, gateway, rootIssueId, projectId, conductorShortHash, parentIssueId: cycleIssueId,
      issueKind: "verify", title: `Verify ${runDigest}`, description: "Verify the scoped repository checks.",
      marker: `${runDigest}:verify`, order: 3, statusName: "Todo",
    });

    const bindingId = `${runDigest}-binding`;
    const conductorId = `${runDigest}-conductor`;
    const installationId = `development-token:${organizationId}`;
    const { SqlitePodiumStoreImpl } = await import(
      "../../packages/podium/dist/internal/storage/SqlitePodiumStoreImpl.js"
    );
    const store = new SqlitePodiumStoreImpl(databasePath);
    store.saveLinearInstallation({
      kind: "development_token",
      installationId,
      organizationId,
      delegateActorId: projectConfiguration.delegateActorId,
      accessToken: config.secrets.linearDevToken,
    });
    store.saveProject({
      projectId: projectConfiguration.project.projectId,
      installationId,
      organizationId,
      name: projectConfiguration.project.name,
      updatedAt: projectConfiguration.project.updatedAt,
    });
    store.saveConductorBinding({
      bindingId,
      conductorId,
      conductorShortHash,
      linearInstallationId: installationId,
      organizationId,
      repositoryContext: {
        repositoryHandle: `${runDigest}-repository`,
        repositoryIdentity: `${runDigest}-repository`,
        repositoryDisplayName: "target-architecture-e2e",
        repositoryRoot,
        baseBranch: "main",
      },
      desiredState: "running",
    });
    store.close();

    podium = await createProductionPodiumConductorOwner({
      databasePath,
      log: (event) => logs.push(event),
    });
    const environmentForConductor = {
      HOME: environment.HOME,
      LANG: environment.LANG,
      LC_ALL: environment.LC_ALL,
      PATH: environment.PATH,
      SYMPHONY_PRIVATE_IPC_FD: "3",
      SYMPHONY_INSTANCE_ID: runId,
      SYMPHONY_BINDING_ID: bindingId,
      SYMPHONY_CONDUCTOR_ID: conductorId,
      SYMPHONY_CONDUCTOR_SHORT_HASH: conductorShortHash,
      SYMPHONY_LINEAR_INSTALLATION_ID: installationId,
      SYMPHONY_ORGANIZATION_ID: organizationId,
      SYMPHONY_REPOSITORY_HANDLE: `${runDigest}-repository`,
      SYMPHONY_REPOSITORY_ROOT: repositoryRoot,
      SYMPHONY_BASE_BRANCH: "main",
      SYMPHONY_CONDUCTOR_DATA_ROOT: conductorDataRoot,
      SYMPHONY_PERFORMER_EXECUTABLE: path.resolve(".venv/bin/performer"),
      SYMPHONY_CODEX_BASE_URL: config.codex.baseUrl,
      SYMPHONY_ROOT_DEADLINE_AT: deadlineAt.toISOString(),
      SYMPHONY_CYCLE_DELAY_MS: "250",
    };
    harness = await startConductorHarness({
      podium,
      environment: environmentForConductor,
      startupTimeoutMs: Math.min(30_000, remaining(deadlineAt)),
      shutdownTimeoutMs: 5_000,
      log: (event) => logs.push(event),
    });
    const apiKey = Buffer.from(config.secrets.codexApiKey, "utf8");
    await provisionApiKeyProfile({
      harness,
      conductorId,
      model: config.codex.model,
      apiKey,
      displayName: "Target architecture E2E",
      reasoningEffort: "low",
    });
    const evidence = await waitForExecutionEvidence({
      gateway,
      projectId,
      rootIssueId,
      deadlineAt,
      failureReason: () => latestRootFailureReason(logs),
    });
    if (evidence.planResults < 1 || evidence.workResults < 2 || evidence.verifyResults < 1) {
      throw new Error("target_e2e_stage_evidence_incomplete");
    }
    if (logs.some(({ event }) => event === "e2e_child_failed")) {
      throw new Error("target_e2e_conductor_process_failed");
    }
  } catch (error) {
    throw new Error(`${safeErrorCode(error)}:${lastLogReason(logs)}`);
  } finally {
    try {
      if (gateway && sdk && rootIssueId) await archiveRoot({ sdk, gateway, rootIssueId });
    } finally {
      if (harness) await harness.close().catch(() => undefined);
      await podium?.close?.();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  }
}

async function initializeRepository(repositoryRoot) {
  await mkdir(repositoryRoot, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repositoryRoot]);
  await execFileAsync("git", ["-C", repositoryRoot, "config", "user.email", "e2e@symphony.local"]);
  await execFileAsync("git", ["-C", repositoryRoot, "config", "user.name", "Symphony E2E"]);
  await writeFile(path.join(repositoryRoot, "README.md"), "Disposable target architecture repository.\n", "utf8");
  await execFileAsync("git", ["-C", repositoryRoot, "add", "README.md"]);
  await execFileAsync("git", ["-C", repositoryRoot, "commit", "-m", "Initialize target architecture E2E repository"]);
}

async function createChild({
  sdk,
  gateway,
  rootIssueId,
  projectId,
  conductorShortHash,
  parentIssueId = rootIssueId,
  issueKind,
  title,
  description,
  marker,
  order,
  statusName = "Todo",
}) {
  const tree = await gateway.getWorkflowIssueTree(projectId, rootIssueId);
  const root = await sdk.readWorkflowMutationTarget(rootIssueId);
  const parent = await sdk.readWorkflowMutationTarget(parentIssueId);
  const desiredStatus = tree.statusCatalog.find(({ name }) => name === statusName);
  if (!root || !parent || !desiredStatus) throw new Error("target_e2e_workflow_setup_incomplete");
  const outcome = await gateway.mutateWorkflow({
    kind: "create_workflow_issue",
    writeId: `${marker}:create`,
    conductorShortHash,
    expectedProjectId: projectId,
    rootIssueId,
    expectedRootRemoteVersion: root.updatedAt,
    parentExpectedRemoteVersion: parent.updatedAt,
    parentExpectedStatusId: parent.statusId,
    parentIssueId,
    issueKind,
    title,
    description,
    statusId: desiredStatus.statusId,
    managedMarker: marker,
    labelNames: [],
    ...(order === undefined ? {} : { order }),
  });
  if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
    throw new Error(`target_e2e_workflow_child_${outcome.kind}`);
  }
  return outcome.readBack.targetIssueId;
}

export async function waitForExecutionEvidence({ gateway, projectId, rootIssueId, deadlineAt, failureReason }) {
  const stopAt = Math.min(deadlineAt.getTime(), Date.now() + 180_000);
  let latest = { planResults: 0, workResults: 0, verifyResults: 0 };
  while (Date.now() < stopAt) {
    if (typeof failureReason === "function" && failureReason()) {
      throw new Error("target_e2e_execution_evidence_boundary_failed");
    }
    const tree = await gateway.getWorkflowIssueTree(projectId, rootIssueId);
    latest = {
      planResults: countStageResults(tree.comments, "plan"),
      workResults: countStageResults(tree.comments, "work"),
      verifyResults: countStageResults(tree.comments, "verify"),
    };
    if (latest.planResults >= 1 && latest.workResults >= 2 && latest.verifyResults >= 1) return latest;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, Math.max(1, stopAt - Date.now()))));
  }
  throw new Error("target_e2e_execution_evidence_timeout");
}

function latestRootFailureReason(logs) {
  for (const event of [...logs].reverse()) {
    if (event?.event !== "e2e_child_log" || typeof event.message !== "string") continue;
    try {
      const message = JSON.parse(event.message);
      if (message?.event !== "root_reconciliation_failed") continue;
      const fields = message.fields && typeof message.fields === "object" && !Array.isArray(message.fields)
        ? message.fields
        : message;
      const reason = fields.reason;
      return typeof reason === "string" && /^[a-z][a-z0-9_:-]{1,120}$/u.test(reason) ? reason : "root_reconciliation_failed";
    } catch {
      continue;
    }
  }
  return undefined;
}

function countStageResults(comments, stage) {
  return comments.filter((comment) =>
    comment.body.includes("stage_result") && new RegExp(`"stage"\\s*:\\s*"${stage}"`, "u").test(comment.body),
  ).length;
}

async function archiveRoot({ sdk, gateway, rootIssueId }) {
  const target = await sdk.readWorkflowMutationTarget(rootIssueId);
  if (!target || target.isArchived) return;
  const outcome = await gateway.mutateWorkflow({
    kind: "archive_workflow_issue",
    writeId: `target-architecture-cleanup:${rootIssueId}`,
    expectedProjectId: target.projectId,
    rootIssueId,
    expectedRootRemoteVersion: target.updatedAt,
    target: {
      targetIssueId: rootIssueId,
      expectedRemoteVersion: target.updatedAt,
      expectedIsArchived: false,
    },
  });
  if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
    throw new Error(`target_e2e_cleanup_${outcome.kind}`);
  }
}

function remaining(deadlineAt) {
  return Math.max(1, deadlineAt.getTime() - Date.now());
}

export function safeErrorCode(error) {
  const code = error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.message : "target_e2e_failed";
  if (/^[a-z][a-z0-9_]{1,120}$/u.test(code)) return code;
  const errorName = error instanceof Error && typeof error.name === "string"
    ? error.name
      .replace(/([a-z])([A-Z])/gu, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "_")
      .replace(/^_|_$/gu, "")
    : "unknown_error";
  return /^[a-z][a-z0-9_]{1,60}$/u.test(errorName)
    ? `target_e2e_${errorName}`
    : "target_e2e_unknown_error";
}

export function lastLogReason(logs) {
  const eventPriority = [
    "e2e_podium_response_error",
    "e2e_podium_handler_failed",
    "e2e_child_log",
    "e2e_child_failed",
  ];
  for (const eventName of eventPriority) {
    for (const event of [...logs].reverse()) {
      if (event?.event !== eventName) continue;
      const reason = readLogReason(event, logs);
      if (reason) return reason;
    }
  }
  return "no_sanitized_boundary_reason";
}

function readLogReason(event, logs) {
  for (const key of ["reason", "code"]) {
    const value = event?.[key];
    if (typeof value === "string" && /^[a-z][a-z0-9_]{1,120}$/u.test(value)) {
      const concrete = value === "root_reconciliation_failed" && typeof event?.failure_code === "string"
        ? event.failure_code
        : value;
      if (concrete !== "root_reconciliation_failed") return addRequestKind(concrete, event?.request_kind, logs);
      if (typeof event?.phase === "string" && /^[a-z][a-z0-9_]{1,80}$/u.test(event.phase)) {
        return `root_reconciliation_${event.phase}`;
      }
      return concrete;
    }
  }
  if (event?.event !== "e2e_child_log" || typeof event.message !== "string") return undefined;
  try {
    const message = JSON.parse(event.message);
    const fields = message?.fields && typeof message.fields === "object" && !Array.isArray(message.fields)
      ? { ...message, ...message.fields }
      : message;
    for (const key of ["sanitized_reason", "error_code", "code", "reason"]) {
      const value = fields?.[key];
      if (typeof value === "string" && /^[a-z][a-z0-9_]{1,120}$/u.test(value)) {
        const concrete = value === "root_reconciliation_failed" && typeof fields?.failure_code === "string"
          ? fields.failure_code
          : value;
        if (concrete !== "root_reconciliation_failed") return addRequestKind(concrete, fields?.request_kind, logs);
        if (typeof fields?.phase === "string" && /^[a-z][a-z0-9_]{1,80}$/u.test(fields.phase)) {
          return `root_reconciliation_${fields.phase}`;
        }
        return concrete;
      }
    }
  } catch {
    // Child logs are diagnostic only; malformed text is not a reason.
  }
  return undefined;
}

function addRequestKind(reason, requestKind, logs) {
  if (reason !== "podium_conductor_request_failed" ||
      typeof requestKind !== "string" || !/^[a-z][a-z0-9_]{1,80}$/u.test(requestKind)) {
    return reason;
  }
  const physical = [...logs].reverse().find((event) =>
    event?.event === "linear_physical_request" &&
    typeof event.operation === "string" &&
    /^[A-Za-z][A-Za-z0-9_]{0,120}$/u.test(event.operation),
  );
  const physicalSuffix = physical
    ? `_${physical.operation}${Number.isSafeInteger(physical.status) ? `_${physical.status}` : ""}`
    : "";
  return `${reason}_${requestKind}${physicalSuffix}`;
}

function runChild({ executable, args, environment, deadlineAt, spawnProcess }) {
  return new Promise((resolve, reject) => {
    const remaining = deadlineAt.getTime() - Date.now();
    if (remaining <= 0) {
      reject(new Error("target_architecture_deadline_exceeded"));
      return;
    }
    const child = spawnProcess(executable, args, {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "ignore", "ignore"],
      detached: process.platform !== "win32",
    });
    let settled = false;
    const timer = setTimeout(() => {
      signalChild(child, "SIGKILL");
      finish({ code: null, signal: "SIGKILL" });
    }, remaining);
    const onError = () => finish({ code: null, signal: "spawn_error" });
    const onExit = (code, signal) => finish({ code, signal });
    child.once("error", onError);
    child.once("exit", onExit);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      resolve(result);
    }
  });
}

function signalChild(child, signal) {
  if (!child?.pid) {
    child?.kill?.(signal);
    return;
  }
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}
