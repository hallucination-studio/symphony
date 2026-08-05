import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { LinearClient, LinearErrorType } from "@linear/sdk";
import { fromMarkdown } from "mdast-util-from-markdown";

import { runBlackBoxScenario } from "./black-box-runner.mjs";

const executeFile = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT_SECTIONS = Object.freeze(["Requirement", "Domain Knowledge", "Root ADR", "Acceptance"]);
const CYCLE_SECTIONS = Object.freeze([
  "Root Definition Revision",
  ...ROOT_SECTIONS,
  "Architecture",
  "Feature Design",
  "Code Design",
  "Boundaries",
  "Acceptance Mapping",
  "Failure Strategy",
]);
const KIND_LABEL_NAMES = Object.freeze([
  "symphony:kind/root",
  "symphony:kind/cycle",
  "symphony:kind/plan",
  "symphony:kind/work",
  "symphony:kind/verify",
]);
const ROOT_CAPABILITIES = Object.freeze([
  "task_manage:get_issue",
  "task_manage:list_issues",
  "task_manage:list_children",
  "task_manage:create_issue",
  "task_manage:update_issue",
  "task_manage:list_relations",
  "task_manage:list_states",
  "task_manage:list_labels",
  "git:get_workspace",
  "git:get_status",
  "git:get_diff",
]);
const TEMPORARY_STATES = Object.freeze([
  { name: "Awaiting Acceptance", type: "started", color: "#5E6AD2" },
  { name: "Rejected", type: "canceled", color: "#D05B5B" },
]);
const COMMAND_TIMEOUT_MS = 30_000;
const SCENARIO_TIMEOUT_MS = 4 * 60_000;
const NODE_TEST_TIMEOUT_MS = 4 * 60_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_CONSECUTIVE_TRANSIENT_READ_FAILURES = 3;
const TRANSIENT_LINEAR_ERROR_TYPES = new Set([
  LinearErrorType.NetworkError,
  LinearErrorType.Ratelimited,
  LinearErrorType.InternalError,
  LinearErrorType.LockTimeout,
]);
const COMMAND_ENVIRONMENT_KEYS = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SSH_AUTH_SOCK",
  "TMP",
  "TMPDIR",
  "TEMP",
  "USER",
  "XDG_CONFIG_HOME",
]);

function commandEnvironment() {
  const environment = { GIT_TERMINAL_PROMPT: "0", GH_PAGER: "cat", PAGER: "cat" };
  for (const key of COMMAND_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

async function command(executable, args, cwd = process.cwd()) {
  try {
    const result = await executeFile(executable, args, {
      cwd,
      env: commandEnvironment(),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch {
    throw new Error("fixture_command_failed");
  }
}

function humanClient(access) {
  return new LinearClient({ apiKey: access.linearHumanToken });
}

function uniqueByName(nodes, name, code) {
  const matches = nodes.filter((node) => node.name === name && node.archivedAt == null);
  assert.equal(matches.length, 1, code);
  return matches[0];
}

function shouldCreateTemporaryState(states, name) {
  const active = states.filter((state) => state.name === name && state.archivedAt == null);
  assert.ok(active.length <= 1, "workflow_state_identity_ambiguous");
  return active.length === 0;
}

async function projectContext(client, projectSlugId) {
  const projects = await client.projects({ first: 2, filter: { slugId: { eq: projectSlugId } } });
  assert.equal(projects.pageInfo.hasNextPage, false, "project_catalog_incomplete");
  assert.equal(projects.nodes.length, 1, "project_identity_ambiguous");
  const project = projects.nodes[0];
  assert.ok(project, "project_identity_missing");
  const teams = await project.teams({ first: 2 });
  assert.equal(teams.pageInfo.hasNextPage, false, "project_team_catalog_incomplete");
  assert.equal(teams.nodes.length, 1, "project_team_identity_ambiguous");
  const team = teams.nodes[0];
  assert.ok(team, "project_team_identity_missing");
  return { project, team };
}

async function workflowStatesCatalog(client, teamId) {
  const states = [];
  let after;
  for (let page = 0; page < 100; page += 1) {
    const connection = await client.workflowStates({
      first: 100,
      after,
      includeArchived: true,
      filter: { team: { id: { eq: teamId } } },
    });
    states.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return states;
    after = connection.pageInfo.endCursor ?? null;
    if (after === null) throw new Error("workflow_state_catalog_incomplete");
  }
  throw new Error("workflow_state_catalog_incomplete");
}

async function workflowCatalog(client, teamId) {
  const [states, labels] = await Promise.all([
    workflowStatesCatalog(client, teamId),
    client.issueLabels({
      first: KIND_LABEL_NAMES.length + 1,
      filter: {
        and: [
          { or: [{ team: { id: { eq: teamId } } }, { team: { null: true } }] },
          { or: KIND_LABEL_NAMES.map((name) => ({ name: { eq: name } })) },
        ],
      },
    }),
  ]);
  assert.equal(labels.pageInfo.hasNextPage, false, "workflow_label_catalog_incomplete");
  return { states, labels: labels.nodes };
}

async function symphonyActor(client) {
  const users = await client.users({
    first: 20,
    filter: { app: { eq: true }, active: { eq: true } },
  });
  assert.equal(users.pageInfo.hasNextPage, false, "agent_catalog_incomplete");
  const actors = users.nodes.filter((user) => user.app && user.displayName === "symphony");
  assert.equal(actors.length, 1, "agent_actor_identity_ambiguous");
  return actors[0].id;
}

function initialRootDescription(runId, fixtureDirectory) {
  return [
    `# Accepted Root E2E ${runId}`,
    "",
    "## Requirement",
    "",
    `Deliver an isolated two-turn continuity proof under \`${fixtureDirectory}/\` without changing any other path.`,
    "",
    "The approved execution graph must contain exactly two ordered Work items and one fresh Verify:",
    "",
    `1. Work 1 generates a fresh value matching \`e7-[0-9a-f]{32}\`, writes only the lowercase SHA-256 of the exact value to \`${fixtureDirectory}/context-proof.sha256\`, and returns the raw value only in its final Work summary. It must not persist the raw value anywhere.`,
    `2. Work 2 depends on Work 1, recalls that exact raw value from the preceding turn in the same Work thread, and writes it with one trailing newline to \`${fixtureDirectory}/context-proof.txt\`. It must not generate a replacement value or recover the value from repository content.`,
    `3. Verify runs in a fresh context and uses only the exact committed repository files to prove that \`context-proof.txt\` matches the required format and hashes to the digest in \`context-proof.sha256\`.`,
    "",
    "Authorized scope is one Cycle with one Plan, two ordered Work items, and one Verify, followed by exact Git and PR delivery.",
    "Required consequences are same-thread two-turn continuity, fresh Verify context, exact committed files, and public revision convergence.",
    "Out of scope are extra Work items, extra dependencies, unrelated repository changes, replacement values, and automatic repair.",
    "No approval-blocking assumptions remain: the fixture directory, repository, and external provider identities are supplied as current facts.",
    "",
    "## Domain Knowledge",
    "",
    "Linear is the durable workflow authority; Git and the public pull request are the delivery authorities.",
    "Work 1 and Work 2 use one live Work thread across two turns; Plan and Verify use fresh contexts.",
    "Verify may inspect only the exact committed repository files and may not mutate the workspace.",
    "",
    "## Root ADR",
    "",
    "Root owns semantic scope and acceptance; Conductor owns the approved Cycle mechanics and never reinterprets this document.",
    "The raw continuity value may exist only in the Work 1 final summary and the Work 2 output file; the digest is the only Work 1 file evidence.",
    "Acceptance requires the unchanged verified revision to match the remote ref and the unique pull request in two public convergence rounds.",
    "",
    "## Acceptance",
    "",
    "- Linear contains exactly Root -> Cycle -> Plan + two ordered Work items + Verify, with Work 1 blocking Work 2 and both Work items blocking Verify.",
    `- The committed files under \`${fixtureDirectory}/\` contain the lowercase digest and the exact \`e7-[0-9a-f]{32}\` value with one trailing newline, and the digest matches.`,
    "- Plan and Verify are fresh contexts, Work 2 uses the preceding Work turn's exact value, and no extra repository path changes occur.",
    "- Verify, the accepted Cycle, the remote branch, and the unique pull request all identify the same exact revision in two matching convergence rounds.",
  ].join("\n");
}

async function createLinearFixture(
  access,
  runId,
  fixtureDirectory,
  description = initialRootDescription(runId, fixtureDirectory),
) {
  const client = humanClient(access);
  const createdStateIds = [];
  const rootId = randomUUID();
  try {
    const { project, team } = await projectContext(client, access.projectSlugId);
    let catalog = await workflowCatalog(client, team.id);
    for (const definition of TEMPORARY_STATES) {
      if (shouldCreateTemporaryState(catalog.states, definition.name)) {
        const stateId = randomUUID();
        const receipt = await client.createWorkflowState({
          id: stateId,
          teamId: team.id,
          name: definition.name,
          type: definition.type,
          color: definition.color,
          description: `Temporary Symphony E7 workflow fixture ${runId}`,
        });
        assert.equal(receipt.success, true, "workflow_state_create_failed");
        createdStateIds.push(stateId);
      }
    }
    catalog = await workflowCatalog(client, team.id);

    const states = Object.fromEntries([
      "Todo",
      "In Progress",
      "In Review",
      "Done",
      "Draft",
      "Awaiting Acceptance",
      "Succeeded",
      "Rejected",
      "Failed",
      "Canceled",
    ].map((name) => [name, uniqueByName(catalog.states, name, `missing_state_${name}`).id]));
    const labels = Object.fromEntries(KIND_LABEL_NAMES.map((name) => [
      name,
      uniqueByName(catalog.labels, name, `missing_label_${name}`).id,
    ]));
    const agentActorId = await symphonyActor(client);
    const receipt = await client.createIssue({
      id: rootId,
      teamId: team.id,
      projectId: project.id,
      title: `[Symphony E7.2] ${runId}`,
      description,
      stateId: states["In Progress"],
      labelIds: [labels["symphony:kind/root"]],
      delegateId: null,
      priority: 1,
    });
    assert.equal(receipt.success, true, "root_fixture_create_failed");
    const root = await client.issue(rootId);
    assert.equal(root.id, rootId, "root_fixture_readback_mismatch");
    assert.equal(root.delegateId, undefined, "root_fixture_must_start_undelegated");
    return Object.freeze({
      rootId,
      teamId: team.id,
      projectId: project.id,
      agentActorId,
      initialDescription: description,
      createdStateIds: Object.freeze([...createdStateIds]),
      states: Object.freeze(states),
      labels: Object.freeze(labels),
    });
  } catch {
    await client.archiveIssue(rootId).catch(() => undefined);
    for (const stateId of [...createdStateIds].reverse()) {
      await client.archiveWorkflowState(stateId).catch(() => undefined);
    }
    throw new Error("linear_fixture_setup_failed");
  }
}

async function archiveIssueTree(client, rootId) {
  const root = await client.issue(rootId).catch(() => null);
  if (root === null || root.archivedAt != null) return;
  const cycles = await root.children({ first: 50 });
  assert.equal(cycles.pageInfo.hasNextPage, false, "linear_cleanup_cycle_page_incomplete");
  for (const cycle of cycles.nodes) {
    const stages = await cycle.children({ first: 50 });
    assert.equal(stages.pageInfo.hasNextPage, false, "linear_cleanup_stage_page_incomplete");
    for (const stage of stages.nodes) {
      if (stage.archivedAt == null) assert.equal((await client.archiveIssue(stage.id)).success, true);
    }
    if (cycle.archivedAt == null) assert.equal((await client.archiveIssue(cycle.id)).success, true);
  }
  assert.equal((await client.archiveIssue(rootId)).success, true);
}

async function cleanupLinearFixture(access, fixture) {
  const client = humanClient(access);
  const failures = [];
  try {
    await archiveIssueTree(client, fixture.rootId);
  } catch {
    failures.push("issue_cleanup_failed");
  }
  for (const stateId of [...fixture.createdStateIds].reverse()) {
    try {
      const receipt = await client.archiveWorkflowState(stateId);
      if (!receipt.success) failures.push("state_cleanup_failed");
    } catch {
      failures.push("state_cleanup_failed");
    }
  }
  if (failures.length > 0) throw new Error("linear_fixture_cleanup_failed");
}

function parseRepository(value) {
  const repository = JSON.parse(value);
  assert.deepEqual(Object.keys(repository).sort(), ["defaultBranch", "nameWithOwner", "url"]);
  assert.match(repository.nameWithOwner, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  assert.match(repository.defaultBranch, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u);
  const url = new URL(repository.url);
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "github.com");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  return repository;
}

function headBranch(rootId) {
  return `symphony/root-${Buffer.from(rootId, "utf8").toString("hex")}`;
}

async function createGitFixture(rootId) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-e7-accepted-"));
  const repositoryPath = path.join(directory, "repository");
  try {
    const repository = parseRepository(await command("gh", [
      "repo",
      "view",
      "--json",
      "nameWithOwner,defaultBranchRef,url",
      "--jq",
      "{nameWithOwner,url,defaultBranch:.defaultBranchRef.name}",
    ]));
    const remoteBaseRevision = await command("gh", [
      "api",
      `repos/${repository.nameWithOwner}/git/ref/heads/${repository.defaultBranch}`,
      "--jq",
      ".object.sha",
    ]);
    assert.match(remoteBaseRevision, /^[0-9a-f]{40}$/u);
    await command("git", ["cat-file", "-e", `${remoteBaseRevision}^{commit}`], REPOSITORY_ROOT);
    await command("git", [
      "clone",
      "--no-local",
      "--no-checkout",
      "--no-tags",
      REPOSITORY_ROOT,
      repositoryPath,
    ], directory);
    await command("git", ["remote", "set-url", "origin", repository.url], repositoryPath);
    await command("git", [
      "switch",
      "--force-create",
      repository.defaultBranch,
      remoteBaseRevision,
    ], repositoryPath);
    const baseRevision = await command("git", ["rev-parse", "--verify", "HEAD^{commit}"], repositoryPath);
    assert.equal(baseRevision, remoteBaseRevision);
    const codexExecutable = await command("which", ["codex"]);
    assert.ok(path.isAbsolute(codexExecutable), "codex_executable_not_absolute");
    const performerHome = await realpath(path.join(os.homedir(), ".codex"));
    return Object.freeze({
      directory,
      repositoryPath,
      repository: repository.nameWithOwner,
      repositoryUrl: repository.url,
      repositoryId: `github:${repository.nameWithOwner.replace("/", ":")}`,
      baseBranch: repository.defaultBranch,
      baseRevision,
      headBranch: headBranch(rootId),
      codexExecutable,
      performerHome,
      programDataPath: path.join(directory, "conductor-data"),
      configPath: path.join(directory, "conductor.json"),
    });
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new Error("git_fixture_setup_failed");
  }
}

async function matchingPullRequests(fixture, state = "all") {
  const output = await command("gh", [
    "pr",
    "list",
    "--repo",
    fixture.repository,
    "--base",
    fixture.baseBranch,
    "--head",
    fixture.headBranch,
    "--state",
    state,
    "--json",
    "url,state,baseRefName,headRefName,headRefOid,body",
  ], fixture.repositoryPath);
  const pullRequests = JSON.parse(output);
  assert.ok(Array.isArray(pullRequests), "github_pull_request_payload_invalid");
  return pullRequests;
}

async function remoteRevision(fixture) {
  const output = await command("gh", [
    "api",
    `repos/${fixture.repository}/git/matching-refs/heads/${fixture.headBranch}`,
  ], fixture.repositoryPath);
  const references = JSON.parse(output);
  assert.ok(Array.isArray(references), "git_remote_ref_payload_invalid");
  const matches = references.filter((reference) => (
    reference !== null
    && typeof reference === "object"
    && reference.ref === `refs/heads/${fixture.headBranch}`
  ));
  assert.ok(matches.length <= 1, "git_remote_ref_identity_ambiguous");
  if (matches.length === 0) return null;
  const revision = matches[0]?.object?.sha;
  assert.match(revision, /^[0-9a-f]{40}$/u, "git_remote_ref_payload_invalid");
  return revision;
}

async function cleanupGitFixture(_access, fixture) {
  const failures = [];
  try {
    const pullRequests = await matchingPullRequests(fixture, "open");
    for (const pullRequest of pullRequests) {
      await command("gh", ["pr", "close", pullRequest.url, "--repo", fixture.repository], fixture.repositoryPath);
    }
  } catch {
    failures.push("pull_request_cleanup_failed");
  }
  try {
    if (await remoteRevision(fixture) !== null) {
      await command("git", [
        "-c",
        "credential.helper=!gh auth git-credential",
        "push",
        "origin",
        "--delete",
        fixture.headBranch,
      ], fixture.repositoryPath);
    }
  } catch {
    failures.push("remote_branch_cleanup_failed");
  }
  try {
    await rm(fixture.directory, { recursive: true, force: true });
  } catch {
    failures.push("local_fixture_cleanup_failed");
  }
  if (failures.length > 0) throw new Error("git_fixture_cleanup_failed");
}

function conductorConfiguration(linear, git) {
  return Object.freeze({
    linear_team_id: linear.teamId,
    agent_actor_id: linear.agentActorId,
    polling_interval_ms: 1_000,
    program_data_path: git.programDataPath,
    performer_home: git.performerHome,
    codex_executable: git.codexExecutable,
    delivery_provider_endpoint: "https://api.github.com",
    root_states: {
      todo: linear.states.Todo,
      in_progress: linear.states["In Progress"],
      in_review: linear.states["In Review"],
      done: linear.states.Done,
      failed: linear.states.Failed,
    },
    workflow: {
      labels: {
        root: linear.labels["symphony:kind/root"],
        cycle: linear.labels["symphony:kind/cycle"],
        plan: linear.labels["symphony:kind/plan"],
        work: linear.labels["symphony:kind/work"],
        verify: linear.labels["symphony:kind/verify"],
      },
      cycle_states: {
        draft: linear.states.Draft,
        in_progress: linear.states["In Progress"],
        awaiting_acceptance: linear.states["Awaiting Acceptance"],
        succeeded: linear.states.Succeeded,
        rejected: linear.states.Rejected,
        failed: linear.states.Failed,
        canceled: linear.states.Canceled,
      },
      stage_states: {
        todo: linear.states.Todo,
        in_progress: linear.states["In Progress"],
        done: linear.states.Done,
        failed: linear.states.Failed,
        canceled: linear.states.Canceled,
      },
    },
    root_capabilities: ROOT_CAPABILITIES,
    root: {
      root_id: linear.rootId,
      repository_id: git.repositoryId,
      repository_path: git.repositoryPath,
      base_branch: git.baseBranch,
    },
  });
}

async function issueFact(issue) {
  const state = await issue.state;
  return Object.freeze({
    id: issue.id,
    title: issue.title,
    description: issue.description ?? null,
    stateId: issue.stateId,
    state: state.name,
    labelIds: Object.freeze([...issue.labelIds].sort()),
    delegateId: issue.delegateId ?? null,
    parentId: issue.parentId ?? null,
    updatedAt: issue.updatedAt.toISOString(),
  });
}

async function issueRelations(issue) {
  const [outgoing, incoming] = await Promise.all([
    issue.relations({ first: 50 }),
    issue.inverseRelations({ first: 50 }),
  ]);
  assert.equal(outgoing.pageInfo.hasNextPage, false, "outgoing_relation_page_incomplete");
  assert.equal(incoming.pageInfo.hasNextPage, false, "incoming_relation_page_incomplete");
  return [...outgoing.nodes, ...incoming.nodes].map((relation) => Object.freeze({
    id: relation.id,
    type: relation.type,
    sourceId: relation.issueId,
    targetId: relation.relatedIssueId,
    updatedAt: relation.updatedAt.toISOString(),
  }));
}

async function readRootTree(access, fixture) {
  const client = humanClient(access);
  const rootIssue = await client.issue(fixture.rootId);
  const root = await issueFact(rootIssue);
  const cycleConnection = await rootIssue.children({ first: 50 });
  assert.equal(cycleConnection.pageInfo.hasNextPage, false, "cycle_page_incomplete");
  const cycles = [];
  const relationMap = new Map();
  for (const cycleIssue of cycleConnection.nodes) {
    const cycle = await issueFact(cycleIssue);
    const stageConnection = await cycleIssue.children({ first: 50 });
    assert.equal(stageConnection.pageInfo.hasNextPage, false, "stage_page_incomplete");
    const stages = [];
    for (const stageIssue of stageConnection.nodes) {
      stages.push(await issueFact(stageIssue));
      for (const relation of await issueRelations(stageIssue)) relationMap.set(relation.id, relation);
    }
    cycles.push(Object.freeze({ ...cycle, stages: Object.freeze(stages) }));
  }
  for (const description of [
    root.description,
    ...cycles.flatMap((cycle) => [cycle.description, ...cycle.stages.map((stage) => stage.description)]),
  ]) {
    if (description !== null) assert.equal(description.includes(access.linearHumanToken), false, "human_token_in_markdown");
  }
  return Object.freeze({
    root,
    cycles: Object.freeze(cycles),
    relations: Object.freeze([...relationMap.values()].sort((left, right) => left.id.localeCompare(right.id))),
  });
}

async function issueHistory(access, issueIds) {
  const client = humanClient(access);
  const histories = {};
  for (const issueId of issueIds) {
    const issue = await client.issue(issueId);
    const connection = await issue.history({ first: 100 });
    assert.equal(connection.pageInfo.hasNextPage, false, "issue_history_page_incomplete");
    histories[issueId] = Object.freeze(connection.nodes.map((entry) => Object.freeze({
      createdAt: entry.createdAt.toISOString(),
      fromStateId: entry.fromStateId ?? null,
      toStateId: entry.toStateId ?? null,
      updatedDescription: entry.updatedDescription,
    })).sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
  }
  return Object.freeze(histories);
}

function assertClosedMarkdown(markdown, expectedSections) {
  assert.equal(typeof markdown, "string");
  const tree = fromMarkdown(markdown);
  const children = tree.children ?? [];
  const headings = children.filter((node) => node.type === "heading" && node.depth === 2);
  const names = headings.map((heading) => {
    assert.equal(heading.children.length, 1, "markdown_heading_not_closed");
    const child = heading.children[0];
    assert.equal(child.type, "text", "markdown_heading_not_text");
    return child.value;
  });
  assert.deepEqual(names, expectedSections);
  for (const [index, heading] of headings.entries()) {
    const start = children.indexOf(heading) + 1;
    const next = headings[index + 1];
    const end = next === undefined ? children.length : children.indexOf(next);
    assert.ok(end > start, `markdown_section_empty_${expectedSections[index]}`);
  }
}

function kindOf(issue, labels) {
  const matches = KIND_LABEL_NAMES.filter((name) => issue.labelIds.includes(labels[name]));
  assert.equal(matches.length, 1, "issue_kind_ambiguous");
  return matches[0].slice("symphony:kind/".length);
}

function recordOfKind(records, kind, code) {
  const matches = records.filter((record) => record.record_kind === kind);
  assert.equal(matches.length, 1, code);
  return matches[0];
}

function transitionTime(histories, issueId, stateId, code) {
  const transition = histories[issueId]?.find((entry) => entry.toStateId === stateId);
  assert.ok(transition, code);
  return Date.parse(transition.createdAt);
}

function orderedWorkEdge(relations, work) {
  const workIds = new Set(work.map((stage) => stage.id));
  const matches = relations.filter((relation) => (
    relation.type === "blocks"
    && workIds.has(relation.sourceId)
    && workIds.has(relation.targetId)
  ));
  assert.notEqual(matches.length, 0, "ordered_work_relation_missing");
  assert.equal(matches.length, 1, "ordered_work_relation_ambiguous");
  return matches[0];
}

function assertExecutionHistory(tree, histories, linear) {
  const cycle = tree.cycles[0];
  const stages = cycle.stages;
  const plan = stages.find((stage) => kindOf(stage, linear.labels) === "plan");
  const work = stages.filter((stage) => kindOf(stage, linear.labels) === "work");
  const verify = stages.find((stage) => kindOf(stage, linear.labels) === "verify");
  assert.ok(plan);
  assert.equal(work.length, 2);
  assert.ok(verify);
  const workEdge = orderedWorkEdge(tree.relations, work);
  const firstWork = work.find((stage) => stage.id === workEdge.sourceId);
  const secondWork = work.find((stage) => stage.id === workEdge.targetId);
  assert.ok(firstWork);
  assert.ok(secondWork);

  const planDone = transitionTime(histories, plan.id, linear.states.Done, "plan_done_transition_missing");
  const firstStarted = transitionTime(histories, firstWork.id, linear.states["In Progress"], "first_work_start_missing");
  const firstDone = transitionTime(histories, firstWork.id, linear.states.Done, "first_work_done_missing");
  const secondStarted = transitionTime(histories, secondWork.id, linear.states["In Progress"], "second_work_start_missing");
  const secondDone = transitionTime(histories, secondWork.id, linear.states.Done, "second_work_done_missing");
  const verifyStarted = transitionTime(histories, verify.id, linear.states["In Progress"], "verify_start_missing");
  const verifyDone = transitionTime(histories, verify.id, linear.states.Done, "verify_done_missing");
  const awaitingAcceptance = transitionTime(
    histories,
    cycle.id,
    linear.states["Awaiting Acceptance"],
    "awaiting_acceptance_transition_missing",
  );
  const succeeded = transitionTime(histories, cycle.id, linear.states.Succeeded, "cycle_succeeded_transition_missing");
  const inReview = transitionTime(histories, tree.root.id, linear.states["In Review"], "root_in_review_transition_missing");

  assert.ok(planDone <= firstStarted);
  assert.ok(firstStarted <= firstDone);
  assert.ok(firstDone <= secondStarted);
  assert.ok(secondStarted <= secondDone);
  assert.ok(secondDone <= verifyStarted);
  assert.ok(verifyStarted <= verifyDone);
  assert.ok(verifyDone <= awaitingAcceptance);
  assert.ok(awaitingAcceptance <= succeeded);
  assert.ok(succeeded <= inReview);

  const cycleApproved = transitionTime(histories, cycle.id, linear.states["In Progress"], "cycle_approval_missing");
  const lateDescriptionChanges = histories[cycle.id].filter((entry) => (
    entry.updatedDescription && Date.parse(entry.createdAt) > cycleApproved
  ));
  assert.deepEqual(lateDescriptionChanges, []);
  for (const stage of stages) {
    assert.equal(histories[stage.id].some((entry) => entry.updatedDescription), false, "sealed_stage_description_changed");
  }
  return { firstWork, secondWork, verify };
}

async function waitForTree(fixtures, linear, predicate, deadline, signal, timeoutCode) {
  let latest;
  let consecutiveTransientFailures = 0;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const observation = await fixtures.operate(async (access) => {
      try {
        return Object.freeze({ tree: await readRootTree(access, linear), transientFailure: false });
      } catch (error) {
        if (!TRANSIENT_LINEAR_ERROR_TYPES.has(error?.type)) throw error;
        return Object.freeze({ tree: null, transientFailure: true });
      }
    });
    if (observation.transientFailure) {
      consecutiveTransientFailures += 1;
      assert.ok(
        consecutiveTransientFailures <= MAX_CONSECUTIVE_TRANSIENT_READ_FAILURES,
        "linear_poll_consecutively_unavailable",
      );
      await delay(POLL_INTERVAL_MS, undefined, { signal });
      continue;
    }
    consecutiveTransientFailures = 0;
    latest = observation.tree;
    assert.ok(latest, "linear_poll_tree_missing");
    if (predicate(latest)) return latest;
    await delay(POLL_INTERVAL_MS, undefined, { signal });
  }
  throw new Error(timeoutCode);
}

async function waitForInReview(fixtures, linear, deadline, signal) {
  return waitForTree(
    fixtures,
    linear,
    (latest) => {
      const terminalFailure = latest.cycles.some((cycle) => ["Rejected", "Failed", "Canceled"].includes(cycle.state));
      assert.equal(terminalFailure, false, "cycle_reached_unexpected_terminal_state");
      return latest.root.state === "In Review";
    },
    deadline,
    signal,
    "accepted_root_scenario_timed_out",
  );
}

async function delegateRoot(access, fixture) {
  const client = humanClient(access);
  const receipt = await client.updateIssue(fixture.rootId, { delegateId: fixture.agentActorId });
  assert.equal(receipt.success, true, "root_delegation_failed");
  const root = await client.issue(fixture.rootId);
  assert.equal(root.delegateId, fixture.agentActorId, "root_delegation_readback_mismatch");
}

async function updateIssueState(access, issueId, stateId, readbackCode = "external_state_update_failed") {
  const client = humanClient(access);
  const receipt = await client.updateIssue(issueId, { stateId });
  assert.equal(receipt.success, true, readbackCode);
  const issue = await client.issue(issueId);
  assert.equal(issue.stateId, stateId, `${readbackCode}_readback_mismatch`);
}

async function updateIssueDescription(access, issueId, description) {
  const client = humanClient(access);
  const receipt = await client.updateIssue(issueId, { description });
  assert.equal(receipt.success, true, "external_description_update_failed");
  const issue = await client.issue(issueId);
  assert.equal(issue.description, description, "external_description_update_readback_mismatch");
}

async function issueRecords(access, issueId) {
  const client = humanClient(access);
  const issue = await client.issue(issueId);
  const comments = await issue.comments({ first: 100 });
  assert.equal(comments.pageInfo.hasNextPage, false, "record_comment_page_incomplete");
  return Object.freeze(comments.nodes.map((comment) => {
    const tree = fromMarkdown(comment.body);
    const code = tree.children?.find((node) => node.type === "code" && node.lang === "json");
    if (code?.type !== "code" || typeof code.value !== "string") return null;
    try {
      const record = JSON.parse(code.value);
      return record !== null && typeof record === "object" && !Array.isArray(record) ? record : null;
    } catch {
      return null;
    }
  }).filter((record) => record !== null));
}

async function gitEvidence(fixture, fixtureDirectory) {
  const pullRequests = await matchingPullRequests(fixture, "all");
  assert.equal(pullRequests.length, 1, "pull_request_identity_ambiguous");
  const pullRequest = pullRequests[0];
  assert.equal(pullRequest.state, "OPEN");
  assert.equal(pullRequest.baseRefName, fixture.baseBranch);
  assert.equal(pullRequest.headRefName, fixture.headBranch);
  assert.match(pullRequest.headRefOid, /^[0-9a-f]{40}$/u);
  const remote = await remoteRevision(fixture);
  const local = await command("git", ["rev-parse", "--verify", `refs/heads/${fixture.headBranch}^{commit}`], fixture.repositoryPath);
  assert.equal(remote, pullRequest.headRefOid);
  assert.equal(local, pullRequest.headRefOid);
  assert.equal(pullRequest.body, `Verified revision: ${pullRequest.headRefOid}`);

  const parents = (await command("git", ["rev-list", "--parents", "-n", "1", local], fixture.repositoryPath)).split(" ");
  assert.deepEqual(parents, [local, fixture.baseRevision]);
  const changedPaths = (await command("git", [
    "diff",
    "--name-only",
    fixture.baseRevision,
    local,
    "--",
  ], fixture.repositoryPath)).split("\n").filter(Boolean).sort();
  const hashPath = `${fixtureDirectory}/context-proof.sha256`;
  const preimagePath = `${fixtureDirectory}/context-proof.txt`;
  assert.deepEqual(changedPaths, [hashPath, preimagePath].sort());
  const hash = await command("git", ["show", `${local}:${hashPath}`], fixture.repositoryPath);
  const preimage = await command("git", ["show", `${local}:${preimagePath}`], fixture.repositoryPath);
  assert.match(hash, /^[0-9a-f]{64}$/u);
  assert.match(preimage, /^e7-[0-9a-f]{32}$/u);
  assert.equal(createHash("sha256").update(preimage, "utf8").digest("hex"), hash);
  return Object.freeze({ revision: local, pullRequestUrl: pullRequest.url });
}

test("temporary workflow state ownership stays with the fixture that creates it", () => {
  assert.equal(shouldCreateTemporaryState([], "Awaiting Acceptance"), true);
  assert.equal(shouldCreateTemporaryState([
    { name: "Awaiting Acceptance", archivedAt: null },
  ], "Awaiting Acceptance"), false);
  assert.throws(
    () => shouldCreateTemporaryState([
      { name: "Awaiting Acceptance", archivedAt: null },
      { name: "Awaiting Acceptance", archivedAt: null },
    ], "Awaiting Acceptance"),
    /workflow_state_identity_ambiguous/u,
  );
});

test("execution graph requires exactly one Work blocks relation", () => {
  const work = [{ id: "WORK-1" }, { id: "WORK-2" }];
  assert.throws(
    () => orderedWorkEdge([
      { sourceId: "WORK-1", targetId: "WORK-2", type: "related" },
    ], work),
    /ordered_work_relation_missing/u,
  );
  assert.deepEqual(
    orderedWorkEdge([
      { sourceId: "WORK-1", targetId: "WORK-2", type: "blocks" },
    ], work),
    { sourceId: "WORK-1", targetId: "WORK-2", type: "blocks" },
  );
  assert.throws(
    () => orderedWorkEdge([
      { sourceId: "WORK-1", targetId: "WORK-2", type: "blocks" },
      { sourceId: "WORK-2", targetId: "WORK-1", type: "blocks" },
    ], work),
    /ordered_work_relation_ambiguous/u,
  );
});

function registerAcceptedRootScenario() {
  test("RM-E2E-001..007 external Root reaches accepted multi-Work delivery through public boundaries", {
  timeout: NODE_TEST_TIMEOUT_MS,
}, async () => {
  const runId = `e7-${randomUUID().replaceAll("-", "")}`;
  const fixtureDirectory = `e2e-fixture/${runId}`;
  await runBlackBoxScenario({
    scenario: async ({ fixtures, product }) => {
      const linear = await fixtures.create({
        setup: (access) => createLinearFixture(access, runId, fixtureDirectory),
        cleanup: cleanupLinearFixture,
      });
      const git = await fixtures.create({
        setup: () => createGitFixture(linear.rootId),
        cleanup: cleanupGitFixture,
      });
      await writeFile(git.configPath, `${JSON.stringify(conductorConfiguration(linear, git), null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });

      const baseline = await fixtures.operate((access) => readRootTree(access, linear));
      assertClosedMarkdown(baseline.root.description, ROOT_SECTIONS);
      assert.equal(baseline.root.delegateId, null);
      assert.equal(baseline.root.state, "In Progress");
      assert.deepEqual(baseline.cycles, []);
      assert.equal(await fixtures.operate(() => remoteRevision(git)), null);

      const running = await product.start(git.configPath);
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      const parked = await fixtures.operate((access) => readRootTree(access, linear));
      assert.deepEqual(parked, baseline);
      assert.equal(await fixtures.operate(() => remoteRevision(git)), null);

      await fixtures.operate((access) => delegateRoot(access, linear));
      const polling = new AbortController();
      let finalTree;
      try {
        finalTree = await Promise.race([
          waitForInReview(fixtures, linear, Date.now() + SCENARIO_TIMEOUT_MS, polling.signal),
          running.waitForFailure(),
        ]);
      } finally {
        polling.abort();
      }
      assert.equal(finalTree.root.state, "In Review");
      assert.equal(finalTree.root.delegateId, linear.agentActorId);
      assertClosedMarkdown(finalTree.root.description, ROOT_SECTIONS);
      assert.equal(finalTree.cycles.length, 1);
      const cycle = finalTree.cycles[0];
      assert.equal(cycle.state, "Succeeded");
      assert.equal(cycle.parentId, linear.rootId);
      assertClosedMarkdown(cycle.description, CYCLE_SECTIONS);
      assert.equal(cycle.stages.length, 4);
      assert.deepEqual(cycle.stages.map((stage) => kindOf(stage, linear.labels)).sort(), [
        "plan",
        "verify",
        "work",
        "work",
      ]);
      assert.equal(cycle.stages.every((stage) => stage.state === "Done"), true);
      assert.equal(finalTree.relations.length, 3);
      const verify = cycle.stages.find((stage) => kindOf(stage, linear.labels) === "verify");
      const works = cycle.stages.filter((stage) => kindOf(stage, linear.labels) === "work");
      assert.ok(verify);
      assert.equal(finalTree.relations.filter((relation) => (
        works.some((work) => work.id === relation.sourceId)
        && relation.targetId === verify.id
        && relation.type === "blocks"
      )).length, 2);

      const issueIds = [linear.rootId, cycle.id, ...cycle.stages.map((stage) => stage.id)];
      const histories = await fixtures.operate((access) => issueHistory(access, issueIds));
      const ordered = assertExecutionHistory(finalTree, histories, linear);
      assert.notEqual(ordered.firstWork.id, ordered.secondWork.id);
      assert.equal(ordered.verify.id, verify.id);
      const delivered = await fixtures.operate(() => gitEvidence(git, fixtureDirectory));
      assert.match(delivered.revision, /^[0-9a-f]{40}$/u);
      assert.match(delivered.pullRequestUrl, /^https:\/\/github\.com\//u);

      const stageRecords = await Promise.all(cycle.stages.map(async (stage) => (
        fixtures.operate((access) => issueRecords(access, stage.id))
      )));
      for (const [index, records] of stageRecords.entries()) {
        const completion = recordOfKind(records, "stage_completion", `stage_completion_record_missing_${index}`);
        assert.equal(completion.stage_id, cycle.stages[index].id, `stage_completion_owner_mismatch_${index}`);
        assert.equal(completion.basis_status, "In Progress", `stage_completion_basis_mismatch_${index}`);
      }
      const cycleRecords = await fixtures.operate((access) => issueRecords(access, cycle.id));
      const approval = recordOfKind(cycleRecords, "cycle_approval", "cycle_approval_record_missing");
      assert.equal(approval.cycle_id, cycle.id, "cycle_approval_owner_mismatch");
      const completion = recordOfKind(cycleRecords, "cycle_completion", "cycle_completion_record_missing");
      assert.equal(completion.successor_policy, "not_applicable", "accepted_successor_policy_mismatch");
      assert.equal(completion.completion.outcome, "accepted", "accepted_cycle_outcome_missing");
      const acceptanceProof = completion.completion.acceptance_convergence_proof;
      assert.equal(acceptanceProof.proof_scope, "acceptance", "acceptance_proof_scope_mismatch");
      assert.equal(acceptanceProof.observation_order, "linear -> git -> linear -> git");
      assert.deepEqual(acceptanceProof.first_round, acceptanceProof.second_round);

      const rootRecords = await fixtures.operate((access) => issueRecords(access, linear.rootId));
      const delivery = recordOfKind(rootRecords, "delivery_completion", "delivery_completion_record_missing");
      assert.equal(delivery.root_id, linear.rootId, "delivery_record_root_mismatch");
      assert.equal(delivery.accepted_cycle_id, cycle.id, "delivery_record_cycle_mismatch");
      assert.equal(delivery.exact_revision, delivery.observed_remote_revision, "delivery_revision_mismatch");
      assert.equal(delivery.exact_revision, delivery.observed_pull_request_head, "delivery_pr_revision_mismatch");
      assert.equal(delivery.observed_pull_request_identity, delivered.pullRequestUrl, "delivery_pr_identity_mismatch");
      const deliveryProof = delivery.convergence_proof;
      assert.equal(deliveryProof.proof_scope, "delivery", "delivery_proof_scope_mismatch");
      assert.equal(
        deliveryProof.observation_order,
        "linear -> git -> delivery -> linear -> git -> delivery",
      );
      assert.deepEqual(deliveryProof.first_round, deliveryProof.second_round);
    },
  });
  });
}

export {
  CYCLE_SECTIONS,
  KIND_LABEL_NAMES,
  NODE_TEST_TIMEOUT_MS,
  ROOT_SECTIONS,
  SCENARIO_TIMEOUT_MS,
  cleanupGitFixture,
  cleanupLinearFixture,
  command,
  conductorConfiguration,
  createGitFixture,
  createLinearFixture,
  delegateRoot,
  headBranch,
  initialRootDescription,
  issueHistory,
  issueRecords,
  readRootTree,
  remoteRevision,
  updateIssueDescription,
  updateIssueState,
  waitForInReview,
  waitForTree,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  registerAcceptedRootScenario();
}
