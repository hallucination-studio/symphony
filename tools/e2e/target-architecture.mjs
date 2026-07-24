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
        "Create one Cycle, produce a Plan, and request a Plan Review Human Action before Work begins.",
        "The Plan must propose exactly two sequential no-op Work nodes followed by Verify.",
        "Use the supplied Git facts. Do not modify files, create commits, or request any Human Action other than Plan Review.",
        `Run marker: ${runDigest}`,
      ].join("\n"),
      priority: "urgent",
    });
    rootIssueId = root.rootIssueId;

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
      reasoningEffort: "minimal",
    });
    const review = await waitForPlanReviewEvidence({
      gateway,
      projectId,
      rootIssueId,
      deadlineAt,
      failureReason: () => latestRootFailureReason(logs),
    });
    await approvePlanReviewAction({
      sdk,
      gateway,
      projectId,
      rootIssueId,
      conductorShortHash,
      approvalActionIssueId: review.approvalActionIssueId,
      approvalActionId: review.approvalActionId,
    });
    const evidence = await waitForExecutionEvidence({
      gateway,
      projectId,
      rootIssueId,
      deadlineAt,
      failureReason: () => latestRootFailureReason(logs),
    });
    if (evidence.planResults !== 1 || evidence.workResults !== 2 || evidence.verifyResults !== 1) {
      throw new Error("target_e2e_stage_evidence_incomplete");
    }
    if (logs.some(({ event }) => event === "e2e_child_failed")) {
      throw new Error("target_e2e_conductor_process_failed");
    }
  } catch (error) {
    throw new Error(`${safeErrorCode(error)}:${lastLogReason(logs)}`);
  } finally {
    if (harness) await harness.close().catch(() => undefined);
    await podium?.close?.();
    await rm(rootDirectory, { recursive: true, force: true });
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

export async function waitForExecutionEvidence({
  gateway,
  projectId,
  rootIssueId,
  deadlineAt,
  failureReason,
}) {
  const stopAt = deadlineAt.getTime();
  while (Date.now() < stopAt) {
    if (typeof failureReason === "function" && failureReason()) {
      throw new Error("target_e2e_execution_evidence_boundary_failed");
    }
    const tree = await gateway.getWorkflowIssueTree(projectId, rootIssueId);
    const evidence = executionEvidence(tree, rootIssueId);
    if (evidence) return evidence;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, Math.max(1, stopAt - Date.now()))));
  }
  throw new Error("target_e2e_execution_evidence_timeout");
}

export async function waitForPlanReviewEvidence({
  gateway,
  projectId,
  rootIssueId,
  deadlineAt,
  failureReason,
}) {
  const stopAt = deadlineAt.getTime();
  while (Date.now() < stopAt) {
    if (typeof failureReason === "function" && failureReason()) {
      throw new Error("target_e2e_plan_review_boundary_failed");
    }
    const tree = await gateway.getWorkflowIssueTree(projectId, rootIssueId);
    const evidence = planReviewEvidence(tree, rootIssueId);
    if (evidence) return evidence;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, Math.max(1, stopAt - Date.now()))));
  }
  throw new Error("target_e2e_plan_review_timeout");
}

async function approvePlanReviewAction({
  sdk,
  gateway,
  projectId,
  rootIssueId,
  conductorShortHash,
  approvalActionIssueId,
  approvalActionId,
}) {
  const tree = await gateway.getWorkflowIssueTree(projectId, rootIssueId);
  const root = await sdk.readWorkflowMutationTarget(rootIssueId);
  const action = await sdk.readWorkflowMutationTarget(approvalActionIssueId);
  const actionFact = tree.issues.find(({ issueId }) => issueId === approvalActionIssueId);
  const approved = tree.statusCatalog.find(({ name }) => name === "Approved");
  if (!root || !action || !actionFact || !approved || !["Todo", "In Progress"].includes(actionFact.statusName)) {
    throw new Error("target_e2e_plan_review_approval_precondition_invalid");
  }
  const outcome = await gateway.mutateWorkflow({
    kind: "update_workflow_issue",
    writeId: `target-e2e-human-approved:${approvalActionId}`,
    conductorShortHash,
    expectedProjectId: projectId,
    rootIssueId,
    expectedRootRemoteVersion: root.updatedAt,
    target: {
      targetIssueId: action.issueId,
      expectedRemoteVersion: action.updatedAt,
      expectedStatusId: action.statusId,
      ...(action.parentIssueId ? { expectedParentIssueId: action.parentIssueId } : {}),
      ...(action.managedMarker ? { expectedManagedMarker: action.managedMarker } : {}),
      expectedIsArchived: false,
    },
    statusId: approved.statusId,
    title: action.title,
    description: action.description,
  });
  if (outcome.kind !== "applied" && outcome.kind !== "already_applied") {
    throw new Error(`target_e2e_plan_review_approval_${outcome.kind}`);
  }
}

export function latestRootFailureReason(logs) {
  for (const event of [...logs].reverse()) {
    if (event?.event !== "e2e_child_log" || typeof event.message !== "string") continue;
    try {
      const message = JSON.parse(event.message);
      if (![
        "root_reconciliation_failed",
        "root_directive_materialization_failed",
      ].includes(message?.event)) continue;
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

function planReviewEvidence(tree, rootIssueId) {
  const root = one(tree.issues, (issue) => issue.issueId === rootIssueId && issue.issueKind === "root" && !issue.isArchived);
  const cycle = one(tree.issues, (issue) => issue.parentIssueId === rootIssueId && issue.issueKind === "cycle" && !issue.isArchived);
  const plan = cycle && one(tree.issues, (issue) => issue.parentIssueId === cycle.issueId && issue.issueKind === "plan" &&
    issue.statusName === "In Review" && !issue.isArchived);
  const action = cycle && one(tree.issues, (issue) => issue.parentIssueId === cycle.issueId && issue.issueKind === "human" &&
    ["Todo", "In Progress"].includes(issue.statusName) && !issue.isArchived &&
    issue.labels.includes("Human Action") && issue.labels.includes("Plan Review"));
  if (!root || !cycle || !plan || !action) return undefined;

  const records = managedRecords(tree.comments);
  const contract = one(records, ({ issueId, record }) => issueId === plan.issueId && record.kind === "plan_contract" &&
    record.root_issue_id === rootIssueId && record.cycle_issue_id === cycle.issueId && identifier(record.plan_contract_digest));
  const planResult = contract && one(records, ({ issueId, record }) => issueId === plan.issueId && record.kind === "stage_result" &&
    record.stage === "plan" && record.outcome_kind === "plan_completed" && record.node_issue_id === plan.issueId &&
    record.root_issue_id === rootIssueId && record.cycle_issue_id === cycle.issueId &&
    record.plan_contract_digest === contract.record.plan_contract_digest && samePlanContract(record, contract.record));
  const request = contract && one(records, ({ issueId, record }) => issueId === action.issueId && record.kind === "human_action_request" &&
    record.action_issue_id === action.issueId && record.action_kind === "plan_review" && record.parent_scope === "cycle" &&
    record.root_issue_id === rootIssueId && record.cycle_issue_id === cycle.issueId && record.related_issue_ids?.length === 1 &&
    record.related_issue_ids[0] === plan.issueId && record.proposal_digest === contract.record.plan_contract_digest && identifier(record.action_id));
  if (!contract || !planResult || !request || !hasRelation(tree.relations, action.issueId, plan.issueId, "relates_to")) return undefined;
  return {
    cycleIssueId: cycle.issueId,
    planIssueId: plan.issueId,
    approvalActionIssueId: action.issueId,
    approvalActionId: request.record.action_id,
    planContractDigest: contract.record.plan_contract_digest,
  };
}

function executionEvidence(tree, rootIssueId) {
  const root = one(tree.issues, (issue) => issue.issueId === rootIssueId && issue.issueKind === "root" &&
    issue.statusName === "In Review" && !issue.isArchived);
  const cycle = root && one(tree.issues, (issue) => issue.parentIssueId === rootIssueId && issue.issueKind === "cycle" &&
    issue.statusName === "Succeeded" && !issue.isArchived);
  const plan = cycle && one(tree.issues, (issue) => issue.parentIssueId === cycle.issueId && issue.issueKind === "plan" &&
    issue.statusName === "Done" && !issue.isArchived);
  const action = cycle && one(tree.issues, (issue) => issue.parentIssueId === cycle.issueId && issue.issueKind === "human" &&
    issue.statusName === "Approved" && !issue.isArchived && issue.labels.includes("Human Action") && issue.labels.includes("Plan Review"));
  if (!root || !cycle || !plan || !action) return undefined;

  const records = managedRecords(tree.comments);
  const contract = one(records, ({ issueId, record }) => issueId === plan.issueId && record.kind === "plan_contract" &&
    record.root_issue_id === rootIssueId && record.cycle_issue_id === cycle.issueId && identifier(record.plan_contract_digest) &&
    Array.isArray(record.proposed_work_dag?.work_nodes) && record.proposed_work_dag.work_nodes.length === 2 && record.proposed_work_dag.verify_node);
  if (!contract) return undefined;
  const digest = contract.record.plan_contract_digest;
  const planResult = one(records, ({ issueId, record }) => issueId === plan.issueId && matchingStageResult(record, {
    rootIssueId, cycleIssueId: cycle.issueId, nodeIssueId: plan.issueId, stage: "plan", outcomeKind: "plan_completed", planContractDigest: digest,
  }) && samePlanContract(record, contract.record));
  const request = one(records, ({ issueId, record }) => issueId === action.issueId && record.kind === "human_action_request" &&
    record.action_issue_id === action.issueId && record.action_kind === "plan_review" && record.parent_scope === "cycle" &&
    record.root_issue_id === rootIssueId && record.cycle_issue_id === cycle.issueId && record.related_issue_ids?.length === 1 &&
    record.related_issue_ids[0] === plan.issueId && record.proposal_digest === digest && identifier(record.action_id));
  const resolution = request && one(records, ({ issueId, record }) => issueId === action.issueId && record.kind === "human_action_resolution" &&
    record.action_issue_id === action.issueId && record.action_id === request.record.action_id && record.action_kind === "plan_review" &&
    record.outcome === "approved" && record.terminal_status === "Approved" && record.actor_kind === "human" &&
    record.proposal_digest === digest && record.terminal_remote_version === action.remoteVersion &&
    Array.isArray(record.source_comment_ids) && record.source_comment_ids.length === 0);
  if (!planResult || !request || !resolution || !hasRelation(tree.relations, action.issueId, plan.issueId, "relates_to")) return undefined;

  const workIssueIds = [];
  for (const work of contract.record.proposed_work_dag.work_nodes) {
    if (!identifier(work?.proposal_key)) return undefined;
    const node = one(tree.issues, (issue) => issue.parentIssueId === cycle.issueId && issue.issueKind === "work" &&
      issue.statusName === "Done" && !issue.isArchived && hasNodeMarker(records, issue.issueId, rootIssueId, cycle.issueId, `work:${work.proposal_key}`, "work", digest));
    if (!node || !hasRelation(tree.relations, plan.issueId, node.issueId, "relates_to") ||
      !one(records, ({ issueId, record }) => issueId === node.issueId && matchingStageResult(record, {
        rootIssueId, cycleIssueId: cycle.issueId, nodeIssueId: node.issueId, stage: "work", outcomeKind: "work_completed",
      }))) return undefined;
    workIssueIds.push(node.issueId);
  }
  if (new Set(workIssueIds).size !== workIssueIds.length) return undefined;

  for (const work of contract.record.proposed_work_dag.work_nodes) {
    const target = workIssueIds[contract.record.proposed_work_dag.work_nodes.indexOf(work)];
    if (!target || !Array.isArray(work.dependency_proposal_keys)) return undefined;
    for (const dependencyProposalKey of work.dependency_proposal_keys) {
      const sourceIndex = contract.record.proposed_work_dag.work_nodes.findIndex(({ proposal_key }) => proposal_key === dependencyProposalKey);
      const source = workIssueIds[sourceIndex];
      if (sourceIndex < 0 || !source || !hasRelation(tree.relations, source, target, "blocks")) return undefined;
    }
  }

  const verify = one(tree.issues, (issue) => issue.parentIssueId === cycle.issueId && issue.issueKind === "verify" &&
    issue.statusName === "Done" && !issue.isArchived && hasNodeMarker(records, issue.issueId, rootIssueId, cycle.issueId, "verify", "verify", digest));
  if (!verify || !hasRelation(tree.relations, plan.issueId, verify.issueId, "relates_to") ||
    !one(records, ({ issueId, record }) => issueId === verify.issueId && matchingStageResult(record, {
      rootIssueId, cycleIssueId: cycle.issueId, nodeIssueId: verify.issueId, stage: "verify", outcomeKind: "verify_passed",
    }))) return undefined;

  const rootTimelineEvents = tree.comments.filter(({ issueId, body }) => issueId === rootIssueId && isTimelineComment(body)).length;
  const cycleTimelineEvents = tree.comments.filter(({ issueId, body }) => issueId === cycle.issueId && isTimelineComment(body)).length;
  if (rootTimelineEvents === 0 || cycleTimelineEvents === 0) return undefined;
  return {
    cycleIssueId: cycle.issueId,
    planIssueId: plan.issueId,
    approvalActionIssueId: action.issueId,
    planContractDigest: digest,
    workIssueIds,
    verifyIssueId: verify.issueId,
    planResults: 1,
    workResults: workIssueIds.length,
    verifyResults: 1,
    rootTimelineEvents,
    cycleTimelineEvents,
  };
}

function managedRecords(comments) {
  return comments.flatMap((comment) => {
    const record = managedRecord(comment.body);
    return record ? [{ issueId: comment.issueId, record }] : [];
  });
}

function managedRecord(body) {
  const marker = "<!-- symphony managed-record\n";
  const endMarker = "\n-->";
  if (typeof body !== "string" || !body.startsWith(marker) || !body.endsWith(endMarker)) return undefined;
  const source = body.slice(marker.length, -endMarker.length);
  if (!source || source.includes("\n")) return undefined;
  try {
    const value = JSON.parse(source);
    return value && typeof value === "object" && !Array.isArray(value) && value.version === 1 && identifier(value.kind)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function matchingStageResult(record, expected) {
  return record.kind === "stage_result" && record.root_issue_id === expected.rootIssueId &&
    record.cycle_issue_id === expected.cycleIssueId && record.node_issue_id === expected.nodeIssueId &&
    record.stage === expected.stage && record.outcome_kind === expected.outcomeKind &&
    (expected.planContractDigest === undefined || record.plan_contract_digest === expected.planContractDigest);
}

function samePlanContract(result, contract) {
  const proposal = {
    objective: contract.objective,
    included_scope: contract.included_scope,
    excluded_scope: contract.excluded_scope,
    assumptions: contract.assumptions,
    constraints: contract.constraints,
    acceptance_criteria: contract.acceptance_criteria,
    verification_requirements: contract.verification_requirements,
  };
  return JSON.stringify(result.plan_contract) === JSON.stringify(proposal) &&
    JSON.stringify(result.proposed_work_dag) === JSON.stringify(contract.proposed_work_dag);
}

function hasNodeMarker(records, issueId, rootIssueId, cycleIssueId, nodeKey, nodeKind, planContractDigest) {
  return Boolean(one(records, ({ issueId: commentIssueId, record }) => commentIssueId === issueId && record.kind === "node_marker" &&
    record.root_issue_id === rootIssueId && record.cycle_issue_id === cycleIssueId && record.node_key === nodeKey &&
    record.node_kind === nodeKind && record.plan_contract_digest === planContractDigest));
}

function hasRelation(relations, sourceIssueId, targetIssueId, relationKind) {
  return relations.some((relation) => relation.sourceIssueId === sourceIssueId && relation.targetIssueId === targetIssueId &&
    relation.relationKind === relationKind);
}

function isTimelineComment(body) {
  return typeof body === "string" && /^<!-- symphony timeline [a-f0-9]{16,64} -->\n## Symphony · (Root Reconciliation|Cycle)\n/u.test(body);
}

function one(values, predicate) {
  const matches = values.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value);
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
