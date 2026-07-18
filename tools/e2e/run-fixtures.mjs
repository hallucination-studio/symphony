import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MARKER = /<!-- symphony core live e2e\nrun_id: ([A-Za-z0-9][A-Za-z0-9._-]{0,127})\n-->/u;

export function createRunScopedLinearOperator({ developmentToken, fetch = globalThis.fetch }) {
  if (!developmentToken) throw stableError("linear_development_token_missing");
  if (typeof fetch !== "function") throw stableError("linear_fixture_fetch_invalid");

  return Object.freeze({
    async preflight() {
      const data = await graphql(`
        query CoreLivePreflight {
          organization { id }
          viewer { id }
          teams(first: 50) {
            nodes { id states(first: 100) { nodes { id name } } }
            pageInfo { hasNextPage }
          }
        }
      `);
      const teams = connection(data.teams, "linear_fixture_teams_invalid");
      const candidates = teams.flatMap((team) =>
        connection(team.states, "linear_fixture_states_invalid")
          .filter(({ name }) => name === "Todo")
          .map((state) => ({ teamId: team.id, stateId: state.id })),
      );
      if (!data.organization?.id || !data.viewer?.id || candidates.length < 1) {
        throw stableError("linear_fixture_preflight_invalid");
      }
      return Object.freeze({
        organizationId: data.organization.id,
        actorId: data.viewer.id,
        ...candidates[0],
        mutationCount: 0,
      });
    },

    async reconcileStaleRuns({ lock, currentRunId }) {
      assertLock(lock, currentRunId);
      const data = await graphql(`
        query CoreLiveManagedProjects {
          projects(first: 250) {
            nodes { id description }
            pageInfo { hasNextPage }
          }
        }
      `);
      const projects = connection(data.projects, "linear_fixture_projects_invalid");
      const stale = projects.filter((project) => {
        const owner = managedRunId(project.description);
        return owner !== undefined && owner !== currentRunId;
      });
      for (const project of stale) await archiveProject(project.id);
      return Object.freeze({ archivedProjectCount: stale.length });
    },

    async create({ lock, runId, conductorShortHash, rootInstruction, preflight }) {
      assertLock(lock, runId);
      if (!/^[a-f0-9]{12}$/u.test(conductorShortHash) || !preflight?.teamId || !preflight?.stateId) {
        throw stableError("linear_fixture_input_invalid");
      }
      const marker = managedMarker(runId);
      const labelName = `symphony:conductor/${conductorShortHash}`;
      const labelData = await graphql(`
        mutation CoreLiveLabel($input: ProjectLabelCreateInput!) {
          projectLabelCreate(input: $input) { success projectLabel { id name } }
        }
      `, { input: { name: labelName, description: marker } });
      const label = labelData.projectLabelCreate;
      if (label?.success !== true || !label.projectLabel?.id || label.projectLabel.name !== labelName) {
        throw stableError("linear_fixture_label_create_failed");
      }
      const projectData = await graphql(`
        mutation CoreLiveProject($input: ProjectCreateInput!) {
          projectCreate(input: $input) { success project { id name slugId } }
        }
      `, { input: {
        name: `Symphony Core Live ${runId}`,
        description: marker,
        teamIds: [preflight.teamId],
        labelIds: [label.projectLabel.id],
        useDefaultTemplate: false,
      } });
      const project = projectData.projectCreate;
      if (project?.success !== true || !project.project?.id || !project.project.slugId) {
        throw stableError("linear_fixture_project_create_failed");
      }
      const issueData = await graphql(`
        mutation CoreLiveRoot($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier } }
        }
      `, { input: {
        teamId: preflight.teamId,
        projectId: project.project.id,
        stateId: preflight.stateId,
        delegateId: preflight.actorId,
        title: `[Core Live E2E] ${runId}`,
        description: `${rootInstruction}\n\n${marker}`,
      } });
      const issue = issueData.issueCreate;
      if (issue?.success !== true || !issue.issue?.id || !issue.issue.identifier) {
        throw stableError("linear_fixture_root_create_failed");
      }
      return Object.freeze({
        runId,
        marker,
        labelName,
        projectId: project.project.id,
        projectSlugId: project.project.slugId,
        rootId: issue.issue.id,
        rootIdentifier: issue.issue.identifier,
      });
    },

    async cleanup({ lock, runId, projectId, marker }) {
      assertLock(lock, runId);
      if (marker !== managedMarker(runId) || !projectId) throw stableError("linear_fixture_cleanup_target_invalid");
      await archiveProject(projectId);
      return Object.freeze({ archivedProjectCount: 1 });
    },
  });

  async function archiveProject(projectId) {
    const data = await graphql(`
      mutation CoreLiveArchive($projectId: String!) {
        projectArchive(id: $projectId) { success }
      }
    `, { projectId });
    if (data.projectArchive?.success !== true) throw stableError("linear_fixture_archive_failed");
  }

  async function graphql(query, variables = {}) {
    let response;
    try {
      response = await fetch(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: { authorization: developmentToken, "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      throw stableError("linear_fixture_request_failed");
    }
    if (!response.ok) throw stableError(`linear_fixture_http_${response.status}`);
    let body;
    try { body = await response.json(); } catch { throw stableError("linear_fixture_response_invalid"); }
    if (body?.errors?.length || !body?.data) throw stableError("linear_fixture_graphql_failed");
    return body.data;
  }
}

export async function createRunScopedGitFixture({ runId, parentDirectory } = {}) {
  if (!RUN_ID.test(runId ?? "")) throw stableError("git_fixture_run_id_invalid");
  const root = parentDirectory
    ? path.join(parentDirectory, `repository-${runId}`)
    : await mkdtemp(path.join(os.tmpdir(), `symphony-core-live-${runId}-`));
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, "README.md"), `# Core Live E2E\n\nRun: ${runId}\n`, { mode: 0o600 });
  try {
    await execute("git", ["init", "-b", "main", root]);
    await execute("git", ["-C", root, "config", "user.name", "Symphony E2E"]);
    await execute("git", ["-C", root, "config", "user.email", "e2e@symphony.local"]);
    await execute("git", ["-C", root, "add", "README.md"]);
    await execute("git", ["-C", root, "commit", "-m", "Initialize core live fixture"]);
    const { stdout } = await execute("git", ["-C", root, "rev-parse", "HEAD"]);
    return Object.freeze({ repositoryRoot: root, baseBranch: "main", initialCommit: stdout.trim() });
  } catch {
    throw stableError("git_fixture_create_failed");
  }
}

export async function createRunScope({ runId, parentDirectory = os.tmpdir() }) {
  if (!RUN_ID.test(runId ?? "")) throw stableError("e2e_run_scope_id_invalid");
  const root = await mkdtemp(path.join(parentDirectory, `symphony-core-live-${runId}-`));
  const scope = {
    runId,
    root,
    appDataRoot: path.join(root, "app-data"),
    conductorDataRoot: path.join(root, "conductor"),
    codexHomeRoot: path.join(root, "codex-home"),
    evidenceRoot: path.join(root, "evidence"),
  };
  await Promise.all([
    scope.appDataRoot,
    scope.conductorDataRoot,
    scope.codexHomeRoot,
    scope.evidenceRoot,
  ].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  await writeFile(path.join(root, ".symphony-core-live-run"), `${runId}\n`, { mode: 0o600 });
  return Object.freeze(scope);
}

export async function cleanupRunScope(scope) {
  if (!RUN_ID.test(scope?.runId ?? "") || typeof scope?.root !== "string") {
    throw stableError("e2e_run_scope_cleanup_invalid");
  }
  let owner;
  try {
    owner = (await readFile(path.join(scope.root, ".symphony-core-live-run"), "utf8")).trim();
  } catch {
    throw stableError("e2e_run_scope_cleanup_invalid");
  }
  if (owner !== scope.runId || !path.basename(scope.root).startsWith(`symphony-core-live-${scope.runId}-`)) {
    throw stableError("e2e_run_scope_cleanup_invalid");
  }
  await rm(scope.root, { recursive: true, force: true });
}

export function managedMarker(runId) {
  if (!RUN_ID.test(runId ?? "")) throw stableError("linear_fixture_run_id_invalid");
  return `<!-- symphony core live e2e\nrun_id: ${runId}\n-->`;
}

function managedRunId(description) {
  if (typeof description !== "string") return undefined;
  return description.match(MARKER)?.[1];
}

function assertLock(lock, runId) {
  if (!lock || lock.runId !== runId || lock.released === true) throw stableError("e2e_lock_required");
}

function connection(value, code) {
  if (!Array.isArray(value?.nodes) || value.pageInfo?.hasNextPage !== false) throw stableError(code);
  return value.nodes;
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
