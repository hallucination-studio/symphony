import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LinearClient } from "@linear/sdk";

const REQUIRED_ENV = [
  "SYMPHONY_E2E_CODEX_API_KEY",
  "SYMPHONY_E2E_CODEX_BASE_URL",
  "SYMPHONY_E2E_CODEX_MODEL",
  "SYMPHONY_E2E_LINEAR_DEV_TOKEN",
  "SYMPHONY_E2E_LINEAR_HUMAN_TOKEN",
  "SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED",
  "SYMPHONY_E2E_PROJECT_SLUG_ID",
];
const KIND_NAMES = ["root", "cycle", "plan", "work", "verify"];
const MAX_PROCESS_OUTPUT = 1024 * 1024;

function requiredEnvironment() {
  const values = Object.fromEntries(REQUIRED_ENV.map((name) => [name, process.env[name]]));
  if (Object.values(values).some((value) => !value)) throw new Error("e2e_environment_incomplete");
  if (values.SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED !== "true") throw new Error("e2e_setup_not_authorized");
  return values;
}

async function all(connection, limit = 5000) {
  for (let page = 0; page < 100; page += 1) {
    if (connection.nodes.length > limit) throw new Error("e2e_linear_read_limit_exceeded");
    if (!connection.pageInfo.hasNextPage) return connection.nodes;
    const before = connection.nodes.length;
    connection = await connection.fetchNext();
    if (connection.nodes.length <= before) throw new Error("e2e_linear_incomplete_page");
  }
  throw new Error("e2e_linear_read_limit_exceeded");
}

async function uniqueState(client, teamId, name) {
  const states = await all(await client.workflowStates({
    first: 50,
    filter: { team: { id: { eq: teamId } }, name: { eq: name } },
  }));
  const matches = states.filter((state) => state.teamId === teamId && state.name === name);
  if (matches.length !== 1) throw new Error("e2e_state_identity_ambiguous");
  return matches[0];
}

async function uniqueLabel(client, teamId, kind) {
  const name = `symphony:kind/${kind}`;
  const labels = await all(await client.issueLabels({ first: 50, filter: { name: { eq: name } } }));
  const matches = labels.filter((label) => label.name === name && (label.teamId === null || label.teamId === teamId));
  if (matches.length !== 1) throw new Error("e2e_label_identity_ambiguous");
  return matches[0];
}

async function readIssue(issue) {
  const [state, labels] = await Promise.all([issue.state, all(await issue.labels({ first: 50 }))]);
  if (!state) throw new Error("e2e_issue_state_missing");
  const kinds = labels.map(({ name }) => name).filter((name) => name.startsWith("symphony:kind/"));
  if (kinds.length !== 1) throw new Error("e2e_issue_kind_ambiguous");
  return { id: issue.id, status: state.name, kind: kinds[0].slice("symphony:kind/".length) };
}

export async function readRootTree(client, rootId) {
  const root = await client.issue(rootId);
  const rootRecord = await readIssue(root);
  const cycles = [];
  for (const cycle of await all(await root.children({ first: 50 }))) {
    const cycleRecord = await readIssue(cycle);
    const stages = [];
    for (const stage of await all(await cycle.children({ first: 50 }))) {
      const stageRecord = await readIssue(stage);
      const inverse = await all(await stage.inverseRelations({ first: 50 }));
      stages.push({
        ...stageRecord,
        dependency_ids: inverse.filter(({ type }) => type === "blocks").map(({ issueId }) => issueId).sort(),
      });
    }
    cycles.push({ ...cycleRecord, stages });
  }
  return { ...rootRecord, cycles };
}

export function assertCompletedMultiWorkRoot(tree) {
  if (tree.kind !== "root" || tree.status !== "In Review") throw new Error("e2e_root_not_in_review");
  if (tree.cycles.length !== 1) throw new Error("e2e_cycle_identity_ambiguous");
  const cycle = tree.cycles[0];
  if (cycle.kind !== "cycle" || cycle.status !== "Succeeded") throw new Error("e2e_cycle_not_succeeded");
  const plans = cycle.stages.filter(({ kind }) => kind === "plan");
  const works = cycle.stages.filter(({ kind }) => kind === "work");
  const verifies = cycle.stages.filter(({ kind }) => kind === "verify");
  if (plans.length !== 1 || plans[0].status !== "Done") throw new Error("e2e_plan_not_done");
  if (works.length < 2 || works.some(({ status }) => status !== "Done")) throw new Error("e2e_multi_work_not_done");
  if (verifies.length !== 1 || verifies[0].status !== "Done") throw new Error("e2e_verify_not_done");
  const workIds = works.map(({ id }) => id).sort();
  if (JSON.stringify(verifies[0].dependency_ids) !== JSON.stringify(workIds)) {
    throw new Error("e2e_verify_dependencies_incomplete");
  }
}

function boundedOutput(child) {
  let stdout = "";
  let stderr = "";
  const append = (current, chunk) => {
    const next = current + chunk.toString("utf8");
    if (Buffer.byteLength(next) > MAX_PROCESS_OUTPUT) throw new Error("e2e_process_output_limit_exceeded");
    return next;
  };
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
  return { stdout: () => stdout, stderr: () => stderr };
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("e2e_conductor_shutdown_timeout")), 15_000)),
  ]);
}

async function archiveTree(client, rootId) {
  const root = await client.issue(rootId);
  for (const cycle of await all(await root.children({ first: 50 }))) {
    for (const stage of await all(await cycle.children({ first: 50 }))) await client.archiveIssue(stage.id);
    await client.archiveIssue(cycle.id);
  }
  await client.archiveIssue(rootId);
}

export async function withOneRoot(repositoryPath, run) {
  const env = requiredEnvironment();
  const human = new LinearClient({ apiKey: env.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN });
  const project = await human.project(env.SYMPHONY_E2E_PROJECT_SLUG_ID);
  const teams = await all(await project.teams({ first: 20 }));
  if (teams.length !== 1) throw new Error("e2e_team_identity_ambiguous");
  const team = teams[0];
  const existing = await all(await human.issues({
    first: 50,
    filter: { team: { id: { eq: team.id } }, project: { id: { eq: project.id } } },
  }));
  if (existing.length !== 0) throw new Error("e2e_project_not_empty");
  const [todo, rootLabel] = await Promise.all([
    uniqueState(human, team.id, "Todo"),
    uniqueLabel(human, team.id, "root"),
    ...KIND_NAMES.slice(1).map((kind) => uniqueLabel(human, team.id, kind)),
  ]);
  const created = await human.createIssue({
    teamId: team.id,
    projectId: project.id,
    stateId: todo.id,
    labelIds: [rootLabel.id],
    title: "E2E: create two independent text artifacts",
    description: [
      "Create exactly two required Work Items.",
      "Work 1 creates e2e-output/alpha.txt containing exactly alpha followed by a newline.",
      "Work 2 creates e2e-output/beta.txt containing exactly beta followed by a newline.",
      "Keep the changes minimal and verify both files and their exact contents.",
    ].join("\n"),
  });
  if (!created.success || !created.issueId) throw new Error("e2e_root_creation_failed");
  const rootId = created.issueId;
  const symphony = new LinearClient({ accessToken: env.SYMPHONY_E2E_LINEAR_DEV_TOKEN });
  const delegateActorId = (await symphony.viewer).id;
  const delegated = await human.updateIssue(rootId, { delegateId: delegateActorId });
  if (!delegated.success || delegated.issueId !== rootId) throw new Error("e2e_root_delegation_failed");
  const delegatedRoot = await human.issue(rootId);
  if (delegatedRoot.delegateId !== delegateActorId) throw new Error("e2e_root_delegation_readback_mismatch");
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-"));
  const configPath = path.join(directory, "conductor.json");
  const performerHome = path.join(directory, "performer-home");
  await mkdir(performerHome, { mode: 0o700 });
  await writeFile(configPath, JSON.stringify({
    linear_team_id: team.id,
    program_data_path: path.join(directory, "program-data"),
    performer_home: performerHome,
    codex_executable: "/opt/homebrew/bin/codex",
    delivery_provider_endpoint: "https://api.github.com",
    root_routing: [{
      root_id: rootId,
      repository_id: "symphony-e2e",
      repository_path: repositoryPath,
      base_branch: "main",
    }],
  }), { mode: 0o600 });
  const child = spawn(process.execPath, [path.join(repositoryPath, "apps/conductor/dist/main.js"), "--config", configPath], {
    cwd: repositoryPath,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SYMPHONY_LINEAR_TOKEN: env.SYMPHONY_E2E_LINEAR_DEV_TOKEN,
      SYMPHONY_CODEX_API_KEY: env.SYMPHONY_E2E_CODEX_API_KEY,
      SYMPHONY_CODEX_BASE_URL: env.SYMPHONY_E2E_CODEX_BASE_URL,
      SYMPHONY_CODEX_MODEL: env.SYMPHONY_E2E_CODEX_MODEL,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = boundedOutput(child);
  try {
    return await run({ client: human, rootId, child, output });
  } finally {
    await stop(child);
    await archiveTree(human, rootId);
  }
}

export async function waitForRoot(client, rootId, predicate, processEvidence, timeoutMs = 30 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processEvidence.child.exitCode !== null) {
      const ready = processEvidence.output.stdout().includes('"event":"conductor_ready"');
      const failureLine = processEvidence.output.stderr().split("\n").find((line) => line.includes('"event":"conductor_failed"'));
      let reason = "no_failure_event";
      try {
        const parsed = JSON.parse(failureLine ?? "null");
        if (typeof parsed?.reason_code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(parsed.reason_code)) reason = parsed.reason_code;
      } catch {}
      throw new Error(`e2e_conductor_exited:${processEvidence.child.exitCode}:${ready ? "ready" : "not_ready"}:${reason}`);
    }
    const tree = await readRootTree(client, rootId);
    if (predicate(tree)) return tree;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("e2e_linear_acceptance_timeout");
}
