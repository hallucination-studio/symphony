import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MARKER = /<!-- symphony core live e2e\nrun_id: ([A-Za-z0-9][A-Za-z0-9._-]{0,127})\n-->/u;
const ROOT_COMMENT_MARKER = "<!-- symphony root marker -->";
const TIMELINE_MARKER = /\n*<!-- symphony turn event\nevent_key: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127}:(?:0|[1-9][0-9]{0,15}))\n-->\s*$/u;
const TIMELINE_HEADING = /^\*\*Performer (warning|error|Turn completed) \([^\n]{1,160}\)\*\*/u;
const MAX_COMMENT_LENGTH = 16_384;

export function createRunScopedLinearOperator({
  developmentToken,
  applicationClientId,
  fetch = globalThis.fetch,
  log = () => {},
}) {
  if (!developmentToken) throw stableError("linear_development_token_missing");
  if (typeof fetch !== "function") throw stableError("linear_fixture_fetch_invalid");

  return Object.freeze({
    async preflight() {
      const data = await graphql(`
        query CoreLivePreflight($clientId: String!) {
          organization { id }
          applicationInfo(clientId: $clientId) { name }
          users(first: 250, filter: { app: { eq: true } }) {
            nodes { id name displayName app }
            pageInfo { hasNextPage }
          }
          teams(first: 50) {
            nodes {
              id
              states(first: 50) {
                nodes { id name }
                pageInfo { hasNextPage }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      `, { clientId: applicationClientId });
      const teams = connection(data.teams, "linear_fixture_teams_invalid");
      const appUsers = connection(data.users, "linear_fixture_app_users_invalid");
      const actorCandidates = appUsers.filter((user) => user.app === true &&
        (user.name === data.applicationInfo?.name || user.displayName === data.applicationInfo?.name));
      const candidates = teams.map((team) => {
        const states = connection(team.states, "linear_fixture_states_invalid");
        return {
          teamId: team.id,
          stateId: states.find(({ name }) => name === "Todo")?.id,
          doneStateId: states.find(({ name }) => name === "Done")?.id,
        };
      }).filter(({ stateId, doneStateId }) => stateId && doneStateId);
      if (!data.organization?.id || !data.applicationInfo?.name ||
          actorCandidates.length !== 1 || candidates.length < 1) {
        throw stableError("linear_fixture_preflight_invalid");
      }
      return Object.freeze({
        organizationId: data.organization.id,
        actorId: actorCandidates[0].id,
        ...candidates[0],
        mutationCount: 0,
      });
    },

    async reconcileStaleRuns({ lock, currentRunId }) {
      assertLock(lock, currentRunId);
      const data = await graphql(`
        query CoreLiveManagedResources {
          projects(first: 250) {
            nodes { id description }
            pageInfo { hasNextPage }
          }
          projectLabels(first: 250) {
            nodes { id description }
            pageInfo { hasNextPage }
          }
        }
      `);
      const projects = connection(data.projects, "linear_fixture_projects_invalid");
      const labels = connection(data.projectLabels, "linear_fixture_labels_invalid");
      const staleProjects = projects.filter((project) => {
        const owner = managedRunId(project.description);
        return owner !== undefined && owner !== currentRunId;
      });
      const staleLabels = labels.filter((label) => {
        const owner = managedRunId(label.description);
        return owner !== undefined && owner !== currentRunId;
      });
      await attemptAll([
        ...staleProjects.map((project) => () => archiveManagedProject(project.id)),
        ...staleLabels.map((label) => () => deleteProjectLabel(label.id)),
      ]);
      return Object.freeze({
        archivedProjectCount: staleProjects.length,
        deletedLabelCount: staleLabels.length,
      });
    },

    async create({ lock, runId, conductorShortHash, projectSlugId, rootInstruction, preflight }) {
      const project = await this.createProject({
        lock, runId, conductorShortHash, projectSlugId, preflight,
      });
      return this.createRoot({ lock, runId, rootInstruction, preflight, project });
    },

    async createProject({ lock, runId, conductorShortHash, projectSlugId, preflight }) {
      assertLock(lock, runId);
      if (!/^[a-f0-9]{12}$/u.test(conductorShortHash) || !preflight?.teamId ||
          (!projectSlugId && !preflight?.stateId)) {
        throw stableError("linear_fixture_input_invalid");
      }
      const marker = managedMarker(runId);
      const labelName = `symphony:conductor/${conductorShortHash}`;
      const retainedProject = projectSlugId
        ? await resolveRetainedProject(projectSlugId, preflight.teamId)
        : undefined;
      const labelData = await graphql(`
        mutation CoreLiveLabel($input: ProjectLabelCreateInput!) {
          projectLabelCreate(input: $input) { success projectLabel { id name } }
        }
      `, { input: { name: labelName, description: marker } });
      const label = labelData.projectLabelCreate;
      if (label?.success !== true || !label.projectLabel?.id || label.projectLabel.name !== labelName) {
        throw stableError("linear_fixture_label_create_failed");
      }
      if (retainedProject) {
        const attachedData = await graphql(`
          mutation CoreLiveAttachLabel($projectId: String!, $labelId: String!) {
            projectAddLabel(id: $projectId, labelId: $labelId) {
              success
              project { id }
            }
          }
        `, { projectId: retainedProject.id, labelId: label.projectLabel.id });
        const attached = attachedData.projectAddLabel;
        if (attached?.success !== true || attached.project?.id !== retainedProject.id) {
          await deleteProjectLabel(label.projectLabel.id).catch(() => {});
          throw stableError("linear_fixture_project_label_attach_failed");
        }
        return Object.freeze({
          runId,
          marker,
          retainProject: true,
          labelId: label.projectLabel.id,
          labelName,
          projectId: retainedProject.id,
          projectSlugId: retainedProject.slugId,
          projectName: retainedProject.name,
          projectUpdatedAt: retainedProject.updatedAt,
        });
      }
      const projectData = await graphql(`
        mutation CoreLiveProject($input: ProjectCreateInput!) {
          projectCreate(input: $input) { success project { id name slugId updatedAt } }
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
      return Object.freeze({
        runId,
        marker,
        retainProject: false,
        labelId: label.projectLabel.id,
        labelName,
        projectId: project.project.id,
        projectSlugId: project.project.slugId,
        projectName: project.project.name,
        projectUpdatedAt: project.project.updatedAt ?? new Date().toISOString(),
      });
    },

    async createRoot({
      lock,
      runId,
      rootName = runId,
      rootInstruction,
      priority,
      sortOrder,
      preflight,
      project,
    }) {
      assertLock(lock, runId);
      if (
        project?.runId !== runId ||
        project.marker !== managedMarker(runId) ||
        typeof rootName !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/u.test(rootName) ||
        (priority !== undefined &&
          (!Number.isSafeInteger(priority) || priority < 0 || priority > 4)) ||
        (sortOrder !== undefined && !Number.isFinite(sortOrder))
      ) {
        throw stableError("linear_fixture_project_invalid");
      }
      const issueData = await graphql(`
        mutation CoreLiveRoot($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier } }
        }
      `, { input: {
        teamId: preflight.teamId,
        projectId: project.projectId,
        stateId: preflight.stateId,
        delegateId: preflight.actorId,
        title: `[Core Live E2E] ${rootName}`,
        description: `${rootInstruction}\n\n${project.marker}`,
        ...(priority === undefined ? {} : { priority }),
        ...(sortOrder === undefined
          ? {}
          : { sortOrder, preserveSortOrderOnCreate: true }),
      } });
      const issue = issueData.issueCreate;
      if (issue?.success !== true || !issue.issue?.id || !issue.issue.identifier) {
        throw stableError("linear_fixture_root_create_failed");
      }
      return Object.freeze({
        ...project,
        runId,
        rootId: issue.issue.id,
        rootIdentifier: issue.issue.identifier,
      });
    },

    async createBlockerRelation({ lock, runId, blocker, dependent }) {
      assertLock(lock, runId);
      assertRelatedFixtures(runId, blocker, dependent);
      const data = await graphql(`
        mutation CoreLiveBlocker($input: IssueRelationCreateInput!) {
          issueRelationCreate(input: $input) {
            success
            issueRelation {
              id
              type
              issue { id }
              relatedIssue { id }
            }
          }
        }
      `, { input: {
        issueId: blocker.rootId,
        relatedIssueId: dependent.rootId,
        type: "blocks",
      } });
      const relation = data.issueRelationCreate;
      if (
        relation?.success !== true ||
        relation.issueRelation?.type !== "blocks" ||
        relation.issueRelation.issue?.id !== blocker.rootId ||
        relation.issueRelation.relatedIssue?.id !== dependent.rootId
      ) {
        throw stableError("linear_fixture_blocker_create_failed");
      }
      return Object.freeze({ relationId: relation.issueRelation.id });
    },

    async updateRootScheduling({ lock, runId, fixture, priority, sortOrder }) {
      assertLock(lock, runId);
      assertRelatedFixtures(runId, fixture, fixture);
      if (
        !Number.isSafeInteger(priority) || priority < 0 || priority > 4 ||
        !Number.isFinite(sortOrder)
      ) {
        throw stableError("linear_fixture_scheduling_update_invalid");
      }
      const data = await graphql(`
        mutation CoreLiveSchedulingUpdate(
          $issueId: String!,
          $input: IssueUpdateInput!
        ) {
          issueUpdate(id: $issueId, input: $input) {
            success
            issue { id priority sortOrder }
          }
        }
      `, {
        issueId: fixture.rootId,
        input: { priority, sortOrder },
      });
      const updated = data.issueUpdate;
      if (
        updated?.success !== true ||
        updated.issue?.id !== fixture.rootId ||
        updated.issue.priority !== priority ||
        updated.issue.sortOrder !== sortOrder
      ) {
        throw stableError("linear_fixture_scheduling_update_failed");
      }
      return Object.freeze({ priority, sortOrder });
    },

    async completeRoot({ lock, runId, fixture, doneStateId }) {
      assertLock(lock, runId);
      assertRelatedFixtures(runId, fixture, fixture);
      if (typeof doneStateId !== "string" || doneStateId.length === 0) {
        throw stableError("linear_fixture_root_completion_invalid");
      }
      const data = await graphql(`
        mutation CoreLiveCompleteRoot(
          $issueId: String!,
          $input: IssueUpdateInput!
        ) {
          issueUpdate(id: $issueId, input: $input) {
            success
            issue { id state { name } }
          }
        }
      `, {
        issueId: fixture.rootId,
        input: { stateId: doneStateId },
      });
      if (
        data.issueUpdate?.success !== true ||
        data.issueUpdate.issue?.id !== fixture.rootId ||
        data.issueUpdate.issue.state?.name !== "Done"
      ) {
        throw stableError("linear_fixture_root_completion_failed");
      }
      return Object.freeze({ rootState: "Done" });
    },

    async readRunState({ fixture }) {
      const data = await graphql(`
        query CoreLiveRunState($rootId: String!, $projectId: String!) {
          issue(id: $rootId) {
            id
            state { name }
            labels(first: 64) { nodes { name } pageInfo { hasNextPage } }
            comments(first: 64) { nodes { body } pageInfo { hasNextPage } }
          }
          project(id: $projectId) {
            issues(first: 250) {
              nodes { id title description parent { id } state { name } }
              pageInfo { hasNextPage }
            }
          }
        }
      `, { rootId: fixture.rootId, projectId: fixture.projectId });
      const labels = connection(data.issue?.labels, "linear_fixture_state_invalid");
      const comments = connection(data.issue?.comments, "linear_fixture_state_invalid");
      const issues = connection(data.project?.issues, "linear_fixture_state_invalid");
      const treeIssueIds = new Set([fixture.rootId]);
      let added;
      do {
        added = false;
        for (const issue of issues) {
          if (!treeIssueIds.has(issue.id) && treeIssueIds.has(issue.parent?.id)) {
            treeIssueIds.add(issue.id);
            added = true;
          }
        }
      } while (added);
      const treeIssues = issues.filter(({ id }) => id !== fixture.rootId && treeIssueIds.has(id));
      const approval = treeIssues.find(({ description }) =>
        typeof description === "string" && description.includes("human_kind: plan_approval"));
      const work = treeIssues.filter(({ description }) =>
        typeof description === "string" && description.includes("kind: work"));
      const managedComment = comments.map(({ body }) => body)
        .find((body) => typeof body === "string" && body.includes("<!-- symphony root marker -->"));
      const phaseLabels = labels.map(({ name }) => name).filter((name) => name.startsWith("symphony:run/"));
      return Object.freeze({
        rootState: data.issue?.state?.name,
        phase: phaseLabels.length === 1 ? phaseLabels[0].slice("symphony:run/".length) : undefined,
        approvalId: approval?.id,
        approvalState: approval?.state?.name,
        planApprovalCount: treeIssues.filter(({ description }) =>
          typeof description === "string" && description.includes("human_kind: plan_approval")).length,
        treeMatches: Boolean(approval?.parent?.id === fixture.rootId) &&
          work.length > 0 && work.every(({ parent }) => Boolean(parent?.id)),
        workStates: work.map(({ state }) => state?.name),
        performerId: field(managedComment, "performer_id"),
        deliveryBranch: field(managedComment, "delivery_branch"),
        reworkCount: work.filter(({ title }) => title === "[Rework] Root Gate Findings").length,
      });
    },

    async readRootCommentEvidence({ fixture }) {
      if (!fixture?.rootId || !fixture.projectId) {
        throw stableError("linear_fixture_comment_evidence_invalid");
      }
      const data = await graphql(`
        query CoreLiveRootComments($rootId: String!) {
          issue(id: $rootId) {
            id
            project { id }
            comments(first: 250) {
              nodes { id body }
              pageInfo { hasNextPage }
            }
          }
        }
      `, { rootId: fixture.rootId });
      if (
        data.issue?.id !== fixture.rootId ||
        data.issue?.project?.id !== fixture.projectId
      ) {
        throw stableError("linear_fixture_comment_evidence_invalid");
      }
      const comments = connection(
        data.issue.comments,
        "linear_fixture_comment_evidence_invalid",
      );
      if (!comments.every((comment) =>
        typeof comment?.id === "string" && typeof comment.body === "string")) {
        throw stableError("linear_fixture_comment_evidence_invalid");
      }
      const primary = comments.filter(({ body }) =>
        body.startsWith("Symphony Root Run\n") &&
        body.endsWith(ROOT_COMMENT_MARKER));
      const timeline = comments
        .filter(({ body }) => body.includes("<!-- symphony turn event"))
        .map(({ body }) => timelineEvidence(body));
      const eventKeys = timeline.map(({ eventKey }) => eventKey);
      if (
        primary.length !== 1 ||
        primary[0].body.length > MAX_COMMENT_LENGTH ||
        eventKeys.length !== new Set(eventKeys).size
      ) {
        throw stableError("linear_fixture_comment_evidence_invalid");
      }
      const eventKinds = [...new Set(timeline.map(({ eventKind }) => eventKind))];
      return Object.freeze({
        rootId: fixture.rootId,
        primaryCommentId: primary[0].id,
        primaryCommentCount: primary.length,
        timelineEventCount: timeline.length,
        completionEventCount: timeline.filter(
          ({ eventKind }) => eventKind === "turn_completed",
        ).length,
        eventKinds,
        eventKeys,
      });
    },

    async approvePlan({ lock, runId, fixture, preflight, approvalId }) {
      assertLock(lock, runId);
      if (!approvalId || !preflight.doneStateId) throw stableError("linear_fixture_approval_invalid");
      const data = await graphql(`
        mutation CoreLiveApprove($issueId: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $issueId, input: $input) { success issue { id } }
        }
      `, { issueId: approvalId, input: { stateId: preflight.doneStateId } });
      if (data.issueUpdate?.success !== true || data.issueUpdate.issue?.id !== approvalId) {
        throw stableError("linear_fixture_approval_failed");
      }
      return this.readRunState({ fixture });
    },

    async cleanup({ lock, runId, projectId, labelId, marker, retainProject = false }) {
      assertLock(lock, runId);
      if (marker !== managedMarker(runId) || !projectId || !labelId) {
        throw stableError("linear_fixture_cleanup_target_invalid");
      }
      await attemptAll([
        ...(!retainProject ? [() => archiveManagedProject(projectId)] : []),
        () => deleteProjectLabel(labelId),
      ]);
      return Object.freeze({
        archivedProjectCount: retainProject ? 0 : 1,
        deletedLabelCount: 1,
      });
    },
  });

  async function resolveRetainedProject(projectSlugId, teamId) {
    const data = await graphql(`
      query CoreLiveProjectBySlug {
        projects(first: 250) {
          nodes {
            id
            name
            slugId
            updatedAt
            teams(first: 50) { nodes { id } pageInfo { hasNextPage } }
            labels(first: 64) { nodes { name } pageInfo { hasNextPage } }
          }
          pageInfo { hasNextPage }
        }
      }
    `);
    const projects = connection(data.projects, "linear_fixture_projects_invalid")
      .filter(({ slugId }) => slugId === projectSlugId);
    if (projects.length !== 1) throw stableError("linear_fixture_project_slug_invalid");
    const project = projects[0];
    const teams = connection(project.teams, "linear_fixture_project_teams_invalid");
    const labels = connection(project.labels, "linear_fixture_project_labels_invalid");
    if (!teams.some(({ id }) => id === teamId) ||
        labels.some(({ name }) => name.startsWith("symphony:conductor/"))) {
      throw stableError("linear_fixture_retained_project_invalid");
    }
    return project;
  }

  async function archiveManagedProject(projectId) {
    let firstFailure;
    let issueIds = [];
    try {
      const data = await graphql(`
        query CoreLiveProjectIssues($projectId: String!) {
          project(id: $projectId) {
            issues(first: 250) {
              nodes { id }
              pageInfo { hasNextPage }
            }
          }
        }
      `, { projectId });
      issueIds = connection(data.project?.issues, "linear_fixture_project_issues_invalid")
        .map(({ id }) => id);
    } catch (error) {
      firstFailure = error;
    }
    try {
      await attemptAll([
        ...issueIds.map((issueId) => () => archiveIssue(issueId)),
        () => archiveProject(projectId),
      ]);
    } catch (error) {
      firstFailure ??= error;
    }
    if (firstFailure) throw firstFailure;
  }

  async function archiveIssue(issueId) {
    const data = await graphql(`
      mutation CoreLiveArchiveIssue($issueId: String!) {
        issueArchive(id: $issueId) { success }
      }
    `, { issueId });
    if (data.issueArchive?.success !== true) {
      throw stableError("linear_fixture_issue_archive_failed");
    }
  }

  async function archiveProject(projectId) {
    const data = await graphql(`
      mutation CoreLiveArchive($projectId: String!) {
        projectArchive(id: $projectId) { success }
      }
    `, { projectId });
    if (data.projectArchive?.success !== true) throw stableError("linear_fixture_archive_failed");
  }

  async function deleteProjectLabel(labelId) {
    const data = await graphql(`
      mutation CoreLiveDeleteLabel($labelId: String!) {
        projectLabelDelete(id: $labelId) { success }
      }
    `, { labelId });
    if (data.projectLabelDelete?.success !== true) {
      throw stableError("linear_fixture_label_delete_failed");
    }
  }

  async function graphql(query, variables = {}) {
    const operation = query.match(/(?:query|mutation)\s+([A-Za-z0-9_]+)/u)?.[1] ?? "unknown";
    let response;
    try {
      response = await fetch(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: { authorization: developmentToken, "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      log({ event: "e2e_linear_request_failed", operation });
      throw stableError("linear_fixture_request_failed");
    }
    let body;
    let responseText;
    try {
      if (typeof response.text === "function") {
        responseText = await response.text();
        body = JSON.parse(responseText);
      } else {
        body = await response.json();
      }
    } catch {
      log({
        event: "e2e_linear_response_invalid",
        operation,
        http_status: response.status,
        content_type: response.headers?.get?.("content-type") ?? "unknown",
        response_body: redactLinearMessage(responseText ?? "unavailable", developmentToken),
      });
      throw stableError("linear_fixture_response_invalid");
    }
    if (!response.ok || body?.errors?.length || !body?.data) {
      const errors = Array.isArray(body?.errors) ? body.errors : [];
      log({
        event: "e2e_linear_graphql_failed",
        operation,
        http_status: response.status,
        error_codes: errors.map((error) => String(error?.extensions?.code ?? "unknown")),
        error_messages: errors.map((error) => redactLinearMessage(error?.message, developmentToken)),
        error_paths: errors.map((error) => Array.isArray(error?.path) ? error.path.join(".") : "unknown"),
      });
      if (!response.ok) throw stableError(`linear_fixture_http_${response.status}`);
      throw stableError("linear_fixture_graphql_failed");
    }
    return body.data;
  }
}

function redactLinearMessage(value, developmentToken) {
  if (typeof value !== "string") return "unknown";
  return value.replaceAll(developmentToken, "[REDACTED]").slice(0, 4_096);
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

function field(comment, name) {
  if (typeof comment !== "string") return undefined;
  const match = comment.match(new RegExp(`(?:^|\\n)${name}: ([^\\n]+)`, "u"));
  return match?.[1] && match[1] !== "none" ? match[1] : undefined;
}

function timelineEvidence(body) {
  if (body.length > MAX_COMMENT_LENGTH) {
    throw stableError("linear_fixture_comment_evidence_invalid");
  }
  const marker = body.match(TIMELINE_MARKER);
  const heading = body.match(TIMELINE_HEADING);
  const eventKind = heading?.[1] === "warning"
    ? "warning_raised"
    : heading?.[1] === "error"
      ? "error_raised"
      : heading?.[1] === "Turn completed"
        ? "turn_completed"
        : undefined;
  if (!marker?.[1] || !eventKind) {
    throw stableError("linear_fixture_comment_evidence_invalid");
  }
  return { eventKey: marker[1], eventKind };
}

function assertLock(lock, runId) {
  if (!lock || lock.runId !== runId || lock.released === true) throw stableError("e2e_lock_required");
}

function assertRelatedFixtures(runId, first, second) {
  if (
    !first?.rootId ||
    !second?.rootId ||
    first.runId !== runId ||
    second.runId !== runId ||
    first.projectId !== second.projectId ||
    first.marker !== managedMarker(runId) ||
    second.marker !== managedMarker(runId)
  ) {
    throw stableError("linear_fixture_root_relation_invalid");
  }
}

function connection(value, code) {
  if (!Array.isArray(value?.nodes) || value.pageInfo?.hasNextPage !== false) throw stableError(code);
  return value.nodes;
}

async function attemptAll(actions) {
  let firstFailure;
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      firstFailure ??= error;
    }
  }
  if (firstFailure) throw firstFailure;
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
