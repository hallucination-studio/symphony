import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { loadE2EConfig } from "../../tools/e2e/config.mjs";

const LIVE_TIMEOUT_MS = 300_000;
const missingConfiguration = (() => {
  try {
    loadE2EConfig({ environment: process.env });
    return undefined;
  } catch (error) {
    if (error?.code === "e2e_configuration_invalid" &&
        Array.isArray(error.issues) &&
        error.issues.every((issue) => typeof issue === "string" && issue.endsWith("_missing"))) {
      return "real Linear E2E configuration is not present";
    }
    throw error;
  }
})();

test("real Linear boundary preserves complete Tree and mutation preconditions", {
  skip: missingConfiguration,
  timeout: LIVE_TIMEOUT_MS,
}, async () => {
  const { LinearSdkImpl } = await import(
    "../../packages/podium/dist/internal/linear-gateway/internal/LinearSdkImpl.js"
  );
  const { LinearGatewayProtocolHandlerImpl } = await import(
    "../../packages/podium/dist/internal/linear-gateway/LinearGatewayProtocolHandlerImpl.js"
  );
  const config = loadE2EConfig({ environment: process.env });
  const organizationId = await LinearSdkImpl.discoverDevelopmentTokenOrganizationId(
    config.secrets.linearDevToken,
  );
  const bootstrap = new LinearSdkImpl(
    {
      kind: "development_token",
      token: config.secrets.linearDevToken,
      delegateActorId: "bootstrap",
    },
    organizationId,
  );
  const projectConfiguration = await bootstrap.readTargetProjectConfiguration({
    clientId: config.linear.clientId,
    projectSlugId: config.linear.projectSlugId,
  });
  const projectId = projectConfiguration.project.projectId;
  const pool = await bootstrap.readConductorProjectPool({ projectId });
  assert.ok(pool.members.length > 0, "the live project must have a Conductor pool member");
  const conductorShortHash = pool.members[0];
  const sdk = new LinearSdkImpl(
    {
      kind: "development_token",
      token: config.secrets.linearDevToken,
      delegateActorId: projectConfiguration.delegateActorId,
    },
    organizationId,
  );
  const gateway = new LinearGatewayProtocolHandlerImpl(sdk, {
    maxAttempts: 2,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
  });
  const runId = `linear-boundary-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runDigest = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  const rootDescription = [
    "Root created by the real Linear boundary contract test.",
    "<!-- symphony live-boundary",
    `run_id: ${runId}`,
    "-->",
  ].join("\n");
  const root = await sdk.createRootIssue({
    projectId,
    conductorShortHash,
    title: `Linear boundary ${runDigest}`,
    description: rootDescription,
  });
  const rootIssueId = root.rootIssueId;
  const managedMarker = `linear-boundary-${runDigest}`;

  let tree = await gateway.getWorkflowIssueTree(projectId, rootIssueId);
    const rootNode = tree.issues.find(({ issueId }) => issueId === rootIssueId);
    assert.ok(rootNode);
    assert.equal(rootNode.isArchived, false);

    const rootTarget = await sdk.readWorkflowMutationTarget(rootIssueId);
    assert.ok(rootTarget);
    const createCycle = {
      kind: "create_workflow_issue",
      writeId: `${managedMarker}-create`,
      conductorShortHash,
      expectedProjectId: projectId,
      rootIssueId,
      expectedRootRemoteVersion: rootTarget.updatedAt,
      parentExpectedRemoteVersion: rootTarget.updatedAt,
      parentExpectedStatusId: rootTarget.statusId,
      parentIssueId: rootIssueId,
      issueKind: "cycle",
      title: `Boundary Cycle ${runDigest}`,
      description: "Cycle created by the real Linear boundary contract test.",
      statusId: rootTarget.statusId,
      managedMarker,
      labelNames: [],
    };
    const created = assertMutationApplied(
      await gateway.mutateWorkflow(createCycle),
      "cycle_create",
    );
  const cycleIssueId = created.readBack.targetIssueId;

    tree = await gateway.getWorkflowIssueTree(projectId, rootIssueId);
    const cycleNode = tree.issues.find(({ issueId }) => issueId === cycleIssueId);
    assert.ok(cycleNode);
    assert.equal(cycleNode.parentIssueId, rootIssueId);
    assert.equal(cycleNode.isArchived, false);

    const cycleTarget = await sdk.readWorkflowMutationTarget(cycleIssueId);
    assert.ok(cycleTarget);
    const currentRootBeforeComment = await sdk.readWorkflowMutationTarget(rootIssueId);
    assert.ok(currentRootBeforeComment);
    const comment = assertMutationApplied(await gateway.mutateWorkflow({
      kind: "append_workflow_comment",
      writeId: `${managedMarker}-comment`,
      conductorShortHash,
      expectedProjectId: projectId,
      rootIssueId,
      expectedRootRemoteVersion: currentRootBeforeComment.updatedAt,
      target: {
        targetIssueId: cycleIssueId,
        expectedRemoteVersion: cycleTarget.updatedAt,
        expectedManagedMarker: managedMarker,
      },
      body: "Linear boundary comment read-back.",
    }), "cycle_comment");
    const currentRootBeforeUpdate = await sdk.readWorkflowMutationTarget(rootIssueId);
    assert.ok(currentRootBeforeUpdate);
    const update = assertMutationApplied(await gateway.mutateWorkflow({
      kind: "update_workflow_issue",
      writeId: `${managedMarker}-update`,
      conductorShortHash,
      expectedProjectId: projectId,
      rootIssueId,
      expectedRootRemoteVersion: currentRootBeforeUpdate.updatedAt,
      target: {
        targetIssueId: cycleIssueId,
        expectedRemoteVersion: cycleTarget.updatedAt,
        expectedManagedMarker: managedMarker,
      },
      statusId: cycleTarget.statusId,
      title: `Boundary Cycle ${runDigest} revised`,
      description: "Cycle updated by the real Linear boundary contract test.",
    }), "cycle_update");
    const currentCycleAfterUpdate = await sdk.readWorkflowMutationTarget(cycleIssueId);
    assert.ok(currentCycleAfterUpdate);
    assert.notEqual(currentCycleAfterUpdate.updatedAt, cycleTarget.updatedAt);
    const staleArchive = await gateway.mutateWorkflow({
      kind: "archive_workflow_issue",
      writeId: `${managedMarker}-stale-archive`,
      conductorShortHash,
      expectedProjectId: projectId,
      rootIssueId,
      expectedRootRemoteVersion: currentRootBeforeUpdate.updatedAt,
      target: {
        targetIssueId: cycleIssueId,
        expectedRemoteVersion: cycleTarget.updatedAt,
        expectedIsArchived: false,
        expectedManagedMarker: managedMarker,
      },
    });
    assert.equal(staleArchive.kind, "precondition_conflict");

    const currentRoot = await sdk.readWorkflowMutationTarget(rootIssueId);
    const currentCycle = currentCycleAfterUpdate;
    assert.ok(currentRoot);
    assert.ok(currentCycle);
    const archive = assertMutationApplied(await gateway.mutateWorkflow({
      kind: "archive_workflow_issue",
      writeId: `${managedMarker}-archive`,
      conductorShortHash,
      expectedProjectId: projectId,
      rootIssueId,
      expectedRootRemoteVersion: currentRoot.updatedAt,
      target: {
        targetIssueId: cycleIssueId,
        expectedRemoteVersion: currentCycle.updatedAt,
        expectedIsArchived: false,
        expectedManagedMarker: managedMarker,
      },
    }), "cycle_archive");

    tree = await gateway.getWorkflowIssueTree(projectId, rootIssueId);
    const archivedCycle = tree.issues.find(({ issueId }) => issueId === cycleIssueId);
    assert.ok(archivedCycle, "complete Tree must include archived descendants");
    assert.equal(archivedCycle.isArchived, true);

    const archivedRoot = await sdk.readWorkflowMutationTarget(rootIssueId);
    const archivedCycleTarget = await sdk.readWorkflowMutationTarget(cycleIssueId);
    assert.ok(archivedRoot);
    assert.ok(archivedCycleTarget);
    const restore = assertMutationApplied(await gateway.mutateWorkflow({
      kind: "restore_workflow_issue",
      writeId: `${managedMarker}-restore`,
      conductorShortHash,
      expectedProjectId: projectId,
      rootIssueId,
      expectedRootRemoteVersion: archivedRoot.updatedAt,
      target: {
        targetIssueId: cycleIssueId,
        expectedRemoteVersion: archivedCycleTarget.updatedAt,
        expectedIsArchived: true,
        expectedManagedMarker: managedMarker,
      },
    }), "cycle_restore");

  tree = await gateway.getWorkflowIssueTree(projectId, rootIssueId);
  const restoredCycle = tree.issues.find(({ issueId }) => issueId === cycleIssueId);
  assert.ok(restoredCycle);
  assert.equal(restoredCycle.isArchived, false);
});

function assertMutationApplied(outcome, operation) {
  const summary = outcome.kind === "failed" ? `${outcome.kind}:${outcome.error.code}` : outcome.kind;
  assert.ok(
    outcome.kind === "applied" || outcome.kind === "already_applied",
    `${operation}_failed:${summary}`,
  );
  return outcome;
}
