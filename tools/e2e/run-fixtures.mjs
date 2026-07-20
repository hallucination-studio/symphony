import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MARKER = /<!-- symphony core live e2e\nrun_id: ([A-Za-z0-9][A-Za-z0-9._-]{0,127})\n-->/u;
const ROOT_COMMENT_MARKER = "<!-- symphony root\n";
const TIMELINE_MARKER = /\n*<!-- symphony turn event\nevent_key: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127}:(?:0|[1-9][0-9]{0,15}))\n-->\s*$/u;
const TIMELINE_HEADING = /^\*\*Performer (warning|error|Turn completed) \([^\n]{1,160}\)\*\*/u;
const MAX_COMMENT_LENGTH = 16_384;
const ROOT_GATE_TITLE = "[Root Gate] Acceptance Checklist";
const ROOT_GATE_CHECKS = Object.freeze([
  ["root-facts", "Root目标和最新Root facts仍然一致"],
  ["work-evidence", "每个有效Work child都有匹配的completion evidence"],
  ["git-checks", "声明的Git checks通过，且worktree状态符合交付要求"],
  ["blockers", "所有Root blocker都处于Done或Canceled"],
  ["delivery", "当前commit和delivery branch满足Root delivery precondition"],
]);

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

    async reconcileStaleRuns({ lock, currentRunId, retainedProjectId }) {
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
      const archivedRootCount = retainedProjectId
        ? await archiveRetainedRootTrees({
            projectId: retainedProjectId,
            excludeRunId: currentRunId,
          })
        : undefined;
      return Object.freeze({
        archivedProjectCount: staleProjects.length,
        ...(archivedRootCount === undefined ? {} : { archivedRootCount }),
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
      const runLabelName = `symphony:e2e/${runId}`;
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
      const runLabelData = await graphql(`
        mutation CoreLiveRunLabel($input: IssueLabelCreateInput!) {
          issueLabelCreate(input: $input) { success issueLabel { id name } }
        }
      `, { input: {
        name: runLabelName,
        teamId: preflight.teamId,
        color: "#5E6AD2",
        isGroup: false,
      } });
      const runLabel = runLabelData.issueLabelCreate;
      if (runLabel?.success !== true || !runLabel.issueLabel?.id || runLabel.issueLabel.name !== runLabelName) {
        throw stableError("linear_fixture_run_label_create_failed");
      }
      if (retainedProject) {
        const attachedData = await graphql(`
          mutation CoreLiveAttachLabel($projectId: String!, $labelId: String!) {
            projectAddLabel(id: $projectId, labelId: $labelId) {
              success
            }
          }
        `, { projectId: retainedProject.id, labelId: label.projectLabel.id });
        const attached = attachedData.projectAddLabel;
        if (attached?.success !== true) {
          log({
            event: "e2e_linear_fixture_rejected",
            operation: "CoreLiveAttachLabel",
            success: false,
          });
          await deleteProjectLabel(label.projectLabel.id).catch(() => {});
          throw stableError("linear_fixture_project_label_attach_failed");
        }
        let attachedLabels;
        try {
          const readbackData = await graphql(`
            query CoreLiveAttachedLabelReadback($projectId: String!) {
              project(id: $projectId) {
                labels(first: 64) {
                  nodes { id }
                  pageInfo { hasNextPage }
                }
              }
            }
          `, { projectId: retainedProject.id });
          attachedLabels = connection(
            readbackData.project?.labels,
            "linear_fixture_project_labels_invalid",
          );
        } catch (error) {
          await deleteProjectLabel(label.projectLabel.id).catch(() => {});
          throw error;
        }
        if (!attachedLabels.some(({ id }) => id === label.projectLabel.id)) {
          log({
            event: "e2e_linear_fixture_rejected",
            operation: "CoreLiveAttachedLabelReadback",
            label_attached: false,
          });
          await deleteProjectLabel(label.projectLabel.id).catch(() => {});
          throw stableError("linear_fixture_project_label_attach_failed");
        }
        return Object.freeze({
          runId,
          marker,
          retainProject: true,
          labelId: label.projectLabel.id,
          labelName,
          runLabelId: runLabel.issueLabel.id,
          runLabelName,
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
        runLabelId: runLabel.issueLabel.id,
        runLabelName,
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
        title: rootName,
        description: rootInstruction,
        ...(project.runLabelId ? { labelIds: [project.runLabelId] } : {}),
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

    async readRunState({ fixture }) {
      const data = await graphql(`
        query CoreLiveRunState($rootId: String!, $projectId: String!) {
          issue(id: $rootId) {
            id
            description
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
      const issues = connection(data.project?.issues, "linear_fixture_state_invalid");
      return runState(fixture, data.issue, issues);
    },

    async readRunStates({ fixtures }) {
      if (!Array.isArray(fixtures) || fixtures.length === 0 ||
          new Set(fixtures.map(({ rootId }) => rootId)).size !== fixtures.length ||
          new Set(fixtures.map(({ projectId }) => projectId)).size !== 1) {
        throw stableError("linear_fixture_states_invalid");
      }
      const projectId = fixtures[0].projectId;
      const data = await graphql(`
        query CoreLiveRunStates($projectId: String!) {
          project(id: $projectId) {
            issues(first: 250) {
              nodes {
                id title description parent { id } state { name }
                labels(first: 64) { nodes { name } pageInfo { hasNextPage } }
                comments(first: 64) { nodes { body } pageInfo { hasNextPage } }
              }
              pageInfo { hasNextPage }
            }
          }
        }
      `, { projectId });
      const issues = connection(data.project?.issues, "linear_fixture_states_invalid");
      return Object.freeze(fixtures.map((fixture) => {
        const root = issues.find(({ id }) => id === fixture.rootId);
        if (!root) throw stableError("linear_fixture_state_invalid");
        return runState(fixture, root, issues);
      }));
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
        body.startsWith("Symphony\n") && body.includes(ROOT_COMMENT_MARKER) &&
        body.endsWith("\n-->"));
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

    async readManagedHuman({ lock, runId, fixture }) {
      assertLock(lock, runId);
      if (!fixture?.rootId || !fixture.projectId) throw stableError("linear_fixture_human_invalid");
      const data = await graphql(`
        query CoreLiveHuman($issueId: String!) {
          issue(id: $issueId) {
            id
            project { id }
            parent { id }
            title
            description
            updatedAt
            state { name }
            comments(first: 64) {
              nodes { body }
              pageInfo { hasNextPage }
            }
          }
        }
      `, { issueId: fixture.approvalId });
      const issue = data.issue;
      const comments = connection(issue?.comments, "linear_fixture_human_invalid");
      const marker = parsePlanApprovalDescription(issue?.description);
      if (
        issue?.project?.id !== fixture.projectId ||
        issue?.parent?.id !== fixture.rootId ||
        issue?.id !== fixture.approvalId ||
        issue?.title !== "[Human Action] Approve Plan" ||
        !marker ||
        !["Todo", "In Progress"].includes(issue.state?.name) ||
        typeof issue.updatedAt !== "string"
      ) {
        throw stableError("linear_fixture_human_invalid");
      }
      return Object.freeze({
        issueId: issue.id,
        rootIssueId: fixture.rootId,
        projectId: issue.project.id,
        parentIssueId: issue.parent.id,
        title: issue.title,
        description: issue.description,
        managedMarker: marker.managedMarker,
        kind: "human",
        humanKind: "plan_approval",
        state: issue.state.name,
        remoteVersion: issue.updatedAt,
        comments,
      });
    },

    async postHumanResponse({ lock, runId, fixture, human, body, expectedRemoteVersion }) {
      assertLock(lock, runId);
      if (
        human?.issueId !== fixture?.approvalId ||
        typeof body !== "string" ||
        body.length === 0 ||
        expectedRemoteVersion !== human.remoteVersion
      ) {
        throw stableError("linear_fixture_human_mutation_invalid");
      }
      const data = await graphql(`
        mutation CoreLiveHumanComment($input: CommentCreateInput!) {
          commentCreate(input: $input) { success comment { id body } }
        }
      `, { input: { issueId: human.issueId, body } });
      const comment = data.commentCreate;
      if (comment?.success !== true || comment.comment?.body !== body || !comment.comment.id) {
        throw stableError("linear_fixture_human_comment_failed");
      }
      return Object.freeze({ commentId: comment.comment.id, body: comment.comment.body });
    },

    async completeHuman({ lock, runId, fixture, human, expectedRemoteVersion, doneStateId }) {
      assertLock(lock, runId);
      if (
        human?.issueId !== fixture?.approvalId ||
        expectedRemoteVersion !== human.remoteVersion ||
        typeof doneStateId !== "string" ||
        doneStateId.length === 0
      ) {
        throw stableError("linear_fixture_human_mutation_invalid");
      }
      const data = await graphql(`
        mutation CoreLiveHumanStatus($issueId: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $issueId, input: $input) { success issue { id state { name } } }
        }
      `, { issueId: human.issueId, input: { stateId: doneStateId } });
      if (data.issueUpdate?.success !== true ||
          data.issueUpdate.issue?.id !== human.issueId ||
          data.issueUpdate.issue.state?.name !== "Done") {
        throw stableError("linear_fixture_human_status_failed");
      }
      return Object.freeze({ issueId: human.issueId, state: "Done" });
    },

    async cleanup({
      lock,
      runId,
      projectId,
      labelId,
      runLabelId,
      runLabelName,
      marker,
      retainProject = false,
      rootIds,
    }) {
      assertLock(lock, runId);
      if (marker !== managedMarker(runId) || !projectId || !labelId) {
        throw stableError("linear_fixture_cleanup_target_invalid");
      }
      let archivedRootCount = 0;
      await attemptAll([
        ...(!retainProject
          ? [() => archiveManagedProject(projectId)]
          : [async () => {
              archivedRootCount = await archiveRetainedRootTrees({
                projectId,
                runId,
                rootIds,
                runLabelName,
              });
            }]),
        () => deleteProjectLabel(labelId),
        ...(runLabelId ? [() => deleteIssueLabel(runLabelId)] : []),
      ]);
      return Object.freeze({
        archivedProjectCount: retainProject ? 0 : 1,
        ...(retainProject ? { archivedRootCount } : {}),
        deletedLabelCount: 1,
        ...(runLabelId ? { deletedRunLabelCount: 1 } : {}),
      });
    },
  });

  async function resolveRetainedProject(projectSlugId, teamId) {
    const data = await graphql(`
      query CoreLiveProjectBySlug($projectId: String!) {
        project(id: $projectId) {
          id
          name
          slugId
          updatedAt
          teams(first: 50) { nodes { id } pageInfo { hasNextPage } }
          labels(first: 64) { nodes { name } pageInfo { hasNextPage } }
        }
      }
    `, { projectId: projectSlugId });
    const project = data.project;
    if (!project || project.slugId !== projectSlugId) {
      throw stableError("linear_fixture_project_slug_invalid");
    }
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

  async function archiveRetainedRootTrees({
    projectId,
    runId,
    excludeRunId,
    rootIds,
    runLabelName,
  }) {
    const data = await graphql(`
      query CoreLiveRetainedProjectIssues($projectId: String!) {
        project(id: $projectId) {
          issues(first: 250) {
            nodes {
              id title description parent { id }
              labels(first: 64) { nodes { name } pageInfo { hasNextPage } }
            }
            pageInfo { hasNextPage }
          }
        }
      }
    `, { projectId });
    const issues = connection(
      data.project?.issues,
      "linear_fixture_retained_project_issues_invalid",
    );
    const expectedRootIds = rootIds === undefined ? undefined : new Set(rootIds);
    if (expectedRootIds && (expectedRootIds.size !== rootIds.length || expectedRootIds.size === 0)) {
      throw stableError("linear_fixture_cleanup_root_identity_invalid");
    }
    const roots = issues.filter((issue) => {
      const markerOwner = managedRunId(issue.description);
      const labelOwner = issueRunId(issue, runLabelName);
      const owner = markerOwner ?? labelOwner;
      return issue.parent === null &&
        typeof issue.id === "string" &&
        typeof issue.title === "string" &&
        (labelOwner !== undefined || issue.title.startsWith("[Core Live E2E] ")) &&
        (runId === undefined ? owner !== undefined && owner !== excludeRunId : owner === runId) &&
        (expectedRootIds === undefined || expectedRootIds.has(issue.id));
    });
    if (
      expectedRootIds &&
      (roots.length !== expectedRootIds.size || roots.some(({ id }) => !expectedRootIds.has(id)))
    ) {
      throw stableError("linear_fixture_cleanup_root_identity_invalid");
    }
    const selected = new Set(roots.map(({ id }) => id));
    let changed;
    do {
      changed = false;
      for (const issue of issues) {
        if (!selected.has(issue.id) && selected.has(issue.parent?.id)) {
          selected.add(issue.id);
          changed = true;
        }
      }
    } while (changed);
    const selectedIssues = issues.filter(({ id }) => selected.has(id));
    selectedIssues.sort((left, right) => issueDepth(right, issues) - issueDepth(left, issues));
    await attemptAll(selectedIssues.map(({ id }) => () => archiveIssue(id)));
    return roots.length;
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

  async function deleteIssueLabel(labelId) {
    const data = await graphql(`
      mutation CoreLiveDeleteRunLabel($labelId: String!) {
        issueLabelDelete(id: $labelId) { success }
      }
    `, { labelId });
    if (data.issueLabelDelete?.success !== true) {
      throw stableError("linear_fixture_run_label_delete_failed");
    }
  }

  async function graphql(query, variables = {}) {
    const operation = query.match(/(?:query|mutation)\s+([A-Za-z0-9_]+)/u)?.[1] ?? "unknown";
    let response;
    let responseDurationMs = 0;
    const attempts = /^\s*query\b/u.test(query) ? 3 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const startedAt = Date.now();
      try {
        response = await fetch(LINEAR_GRAPHQL_URL, {
          method: "POST",
          headers: { authorization: developmentToken, "content-type": "application/json" },
          body: JSON.stringify({ query, variables }),
        });
        responseDurationMs = Math.max(0, Date.now() - startedAt);
      } catch {
        log({
          event: "linear_physical_request",
          operation,
          durationMs: Math.max(0, Date.now() - startedAt),
        });
        if (attempt < attempts) {
          log({ event: "e2e_linear_request_retry", operation, attempt });
          continue;
        }
        log({ event: "e2e_linear_request_failed", operation });
        throw stableError("linear_fixture_request_failed");
      }
      break;
    }
    log({
      event: "linear_physical_request",
      operation,
      durationMs: responseDurationMs,
      ...(Number.isSafeInteger(response.status) ? { status: response.status } : {}),
      ...rateWindowEvidence(response.headers),
    });
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

  function rateWindowEvidence(headers) {
    const requestWindow = rateWindow(headers, "x-ratelimit-requests");
    const complexityWindow = rateWindow(headers, "x-ratelimit-complexity");
    return {
      ...(requestWindow ? { requestWindow } : {}),
      ...(complexityWindow ? { complexityWindow } : {}),
    };
  }

  function rateWindow(headers, prefix) {
    const limit = nonnegativeHeader(headers, `${prefix}-limit`);
    const remaining = nonnegativeHeader(headers, `${prefix}-remaining`);
    const reset = nonnegativeHeader(headers, `${prefix}-reset`);
    return limit === undefined || remaining === undefined || reset === undefined
      ? undefined
      : { limit, remaining, reset };
  }

  function nonnegativeHeader(headers, name) {
    const value = headers?.get?.(name);
    if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) {
      return undefined;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
}

function issueRunId(issue, expectedLabelName) {
  const labels = Array.isArray(issue?.labels?.nodes) ? issue.labels.nodes : [];
  const label = labels.find(({ name }) =>
    typeof name === "string" &&
    (!expectedLabelName || name === expectedLabelName) &&
    name.startsWith("symphony:e2e/"));
  return label ? label.name.slice("symphony:e2e/".length) : undefined;
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

function parsePlanApprovalDescription(description) {
  const match = typeof description === "string"
    ? description.match(/<!-- symphony managed marker\nmanaged_marker: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})\nkind: human\nhuman_kind: plan_approval\ntarget_issue_id: none\n-->/u)
    : undefined;
  return match ? { managedMarker: match[1] } : undefined;
}

function field(comment, name) {
  if (typeof comment !== "string") return undefined;
  const match = comment.match(new RegExp(`(?:^|\\n)${name}: ([^\\n]+)`, "u"));
  return match?.[1] && match[1] !== "none" ? match[1] : undefined;
}

function nonNegativeField(comment, name) {
  const value = field(comment, name);
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
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

function connection(value, code) {
  if (!Array.isArray(value?.nodes) || value.pageInfo?.hasNextPage !== false) throw stableError(code);
  return value.nodes;
}

function runState(fixture, root, issues) {
  if (root?.id !== fixture.rootId) throw stableError("linear_fixture_state_invalid");
  const labels = connection(root.labels, "linear_fixture_state_invalid");
  const comments = connection(root.comments, "linear_fixture_state_invalid");
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
  const gateNodes = treeIssues.filter(({ title, parent }) =>
    title === ROOT_GATE_TITLE && parent?.id === fixture.rootId);
  const gateIssueId = gateNodes.length === 1 ? gateNodes[0].id : undefined;
  const workNodes = work.filter(({ id }) => id !== gateIssueId);
  const gateChecklistChecked = gateNodes.length === 1 &&
    gateNodes[0].description === rootGateIssueDescription(fixture.rootId, true);
  const managedComment = comments.map(({ body }) => body)
    .find((body) => typeof body === "string" && body.startsWith("Symphony\n") &&
      body.includes(ROOT_COMMENT_MARKER) && body.endsWith("\n-->"));
  const providerInputTokens = nonNegativeField(managedComment, "usage_input_tokens");
  const phaseLabels = labels.map(({ name }) => name)
    .filter((name) => name.startsWith("symphony:run/"));
  return Object.freeze({
    rootState: root.state?.name,
    phase: phaseLabels.length === 1 ? phaseLabels[0].slice("symphony:run/".length) : undefined,
    approvalId: approval?.id,
    approvalState: approval?.state?.name,
    planApprovalCount: treeIssues.filter(({ description }) =>
      typeof description === "string" && description.includes("human_kind: plan_approval")).length,
    childCount: treeIssues.length,
    treeMatches: Boolean(approval?.parent?.id === fixture.rootId) &&
      work.length > 0 && work.every(({ parent }) => Boolean(parent?.id)),
    rootDescription: root.description,
    workIssueIds: workNodes.map(({ id }) => id),
    workStates: workNodes.map(({ state }) => state?.name),
    humanIssueId: approval?.id,
    gateIssueId,
    gateCheckIds: gateNodes.length === 1 ? rootGateCheckIds(gateNodes[0].description) : [],
    managedCommentPresent: managedComment !== undefined,
    performerId: field(managedComment, "performer_id"),
    ...(providerInputTokens === undefined ? {} : { providerInputTokens }),
    deliveryBranch: field(managedComment, "delivery_branch"),
    reworkCount: workNodes.filter(({ title }) => title === "[Rework] Root Gate Findings").length,
    gateCount: gateNodes.length,
    gateChecklistChecked,
  });
}

function rootGateIssueDescription(rootId, checked) {
  const description = [
    "## Root Gate Checklist",
    ...ROOT_GATE_CHECKS.map(([id, text]) =>
      "- [" + (checked ? "x" : " ") + "] \`" + id + "\`: " + text),
  ].join("\n");
  return description + "\n\n<!-- symphony managed marker\nmanaged_marker: " +
    rootId + ":root-gate\n-->\n\n<!-- symphony work metadata\nkind: work\n" +
    "origin: symphony\ncompleted_input_hash: none\n-->";
}

function rootGateCheckIds(description) {
  if (typeof description !== "string") return [];
  return description.split("\n")
    .slice(1, ROOT_GATE_CHECKS.length + 1)
    .map((line) => line.match(/^- \[[ x]\] `([A-Za-z0-9][A-Za-z0-9._-]{0,63})`:/u)?.[1])
    .filter((id) => id !== undefined);
}

function issueDepth(issue, issues) {
  const byId = new Map(issues.map((candidate) => [candidate.id, candidate]));
  const visited = new Set([issue.id]);
  let depth = 0;
  let parentId = issue.parent?.id;
  while (parentId) {
    if (visited.has(parentId)) throw stableError("linear_fixture_issue_parent_cycle");
    visited.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parent?.id;
  }
  return depth;
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
