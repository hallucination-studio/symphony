import { parseManagedRecord, serializeManagedRecord } from "../../root-reconciliation/api/index.js";
import type { RootOwnershipRecord } from "../../root-reconciliation/api/ManagedRecords.js";
import type { DiscoveredRoot } from "../../root-reconciliation/api/RootModels.js";
import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootOwnershipClaimDependencies,
  RootOwnershipClaimInterface,
  RootOwnershipClaimResult,
} from "../api/RootOwnershipClaimInterface.js";

const managedRecordMarker = "<!-- symphony managed-record";

export class LinearRootOwnershipClaimImpl implements RootOwnershipClaimInterface {
  constructor(private readonly dependencies: RootOwnershipClaimDependencies) {}

  async claim(input: { root: DiscoveredRoot }): Promise<RootOwnershipClaimResult> {
    let tree = await this.dependencies.linear.readWorkflowIssueTree(input.root.issueId);
    const root = rootIssue(tree, input.root.issueId);
    if (root.project_id !== input.root.projectId) throw new Error("root_ownership_project_invalid");
    const existing = rootOwnership(tree, input.root.issueId);
    if (existing && existing.conductorId !== this.dependencies.conductorId) {
      return { kind: "foreign_owner" };
    }

    if (root.status_name === "Canceled" && existing) {
      const workspace = await this.ensureOwnedWorkspace(input, existing);
      return { kind: "already_owned", ownership: existing, workspace };
    }

    const profile = await this.dependencies.profileFor({
      ...(existing ? { ownedProfileId: existing.performerProfileId } : {}),
    });
    if (!profile || !profile.ready) {
      return { kind: "profile_not_ready", ...(profile ? { profileId: profile.profileId } : {}) };
    }
    if (existing && existing.performerProfileId !== profile.profileId) {
      throw new Error("root_ownership_profile_conflict");
    }
    if (root.status_name === "Done" || root.status_name === "Canceled") {
      throw new Error("root_ownership_root_terminal");
    }

    if (root.status_name !== "In Progress" && !(existing && root.status_name === "In Review")) {
      const status = tree.status_catalog.find(({ name }) => name === "In Progress");
      if (!status) throw new Error("root_ownership_status_missing");
      const outcome = await this.dependencies.linear.mutateWorkflow({
        kind: "update_workflow_issue",
        writeId: `${input.root.issueId}:ownership:in-progress`,
        expectedProjectId: input.root.projectId,
        rootIssueId: input.root.issueId,
        expectedRootRemoteVersion: root.remote_version,
        target: {
          targetIssueId: root.issue_id,
          expectedRemoteVersion: root.remote_version,
          expectedStatusId: root.status_id,
        },
        statusId: status.status_id,
        title: root.title,
        description: root.description,
      });
      requireApplied(outcome, "root_ownership_state_write_failed");
      tree = await this.dependencies.linear.readWorkflowIssueTree(input.root.issueId);
      const updatedRoot = rootIssue(tree, input.root.issueId);
      if (updatedRoot.status_name !== "In Progress") {
        throw new Error(`root_ownership_state_read_back_${statusCode(updatedRoot.status_name)}`);
      }
    }

    const expectedWorkspace = this.dependencies.workspaceFor(input.root);
    if (existing && existing.deliveryBranch !== expectedWorkspace.branch) {
      throw new Error("git_workspace_identity_conflict");
    }
    const workspace = await this.dependencies.git.ensureWorkspace({
      rootIssueId: input.root.issueId,
      rootIdentifier: input.root.identifier,
      baseBranch: this.dependencies.baseBranch,
    });
    if (
      workspace.rootIssueId !== expectedWorkspace.rootIssueId ||
      workspace.branch !== expectedWorkspace.branch ||
      workspace.worktreePath !== expectedWorkspace.worktreePath
    ) {
      throw new Error("git_workspace_identity_conflict");
    }
    const snapshot = await this.dependencies.git.inspect(workspace);
    if (snapshot.branch !== expectedWorkspace.branch) throw new Error("git_workspace_identity_conflict");

    if (existing) {
      const readBack = await this.dependencies.linear.readWorkflowIssueTree(input.root.issueId);
      const ownership = rootOwnership(readBack, input.root.issueId);
      if (!ownership || !sameOwnership(ownership, existing)) throw new Error("root_ownership_read_back_failed");
      return { kind: "already_owned", ownership, workspace };
    }

    const ownership: RootOwnershipRecord = {
      kind: "root_ownership",
      version: 1,
      rootIssueId: input.root.issueId,
      conductorId: this.dependencies.conductorId,
      performerProfileId: profile.profileId,
      deliveryBranch: workspace.branch,
      ownerGeneration: this.dependencies.ownerGeneration,
    };
    const freshRoot = rootIssue(tree, input.root.issueId);
    const outcome = await this.dependencies.linear.mutateWorkflow({
      kind: "append_workflow_comment",
      writeId: `${input.root.issueId}:ownership:${this.dependencies.ownerGeneration}`,
      expectedProjectId: input.root.projectId,
      rootIssueId: input.root.issueId,
      expectedRootRemoteVersion: freshRoot.remote_version,
      target: {
        targetIssueId: freshRoot.issue_id,
        expectedRemoteVersion: freshRoot.remote_version,
        expectedStatusId: freshRoot.status_id,
      },
      body: serializeManagedRecord(ownership),
    });
    requireApplied(outcome, "root_ownership_write_failed");
    const readBack = await this.dependencies.linear.readWorkflowIssueTree(input.root.issueId);
    const persisted = rootOwnership(readBack, input.root.issueId);
    if (!persisted || !sameOwnership(persisted, ownership)) throw new Error("root_ownership_read_back_failed");
    const persistedRoot = rootIssue(readBack, input.root.issueId);
    if (persistedRoot.status_name !== "In Progress") {
      throw new Error(`root_ownership_state_read_back_${statusCode(persistedRoot.status_name)}`);
    }
    return { kind: "claimed", ownership: persisted, workspace };
  }

  private async ensureOwnedWorkspace(input: { root: DiscoveredRoot }, ownership: RootOwnershipRecord) {
    const workspace = this.dependencies.workspaceFor(input.root);
    if (ownership.deliveryBranch !== workspace.branch) {
      throw new Error("git_workspace_identity_conflict");
    }
    const ensured = await this.dependencies.git.ensureWorkspace({
      rootIssueId: input.root.issueId,
      rootIdentifier: input.root.identifier,
      baseBranch: this.dependencies.baseBranch,
    });
    if (
      ensured.rootIssueId !== workspace.rootIssueId ||
      ensured.branch !== workspace.branch ||
      ensured.worktreePath !== workspace.worktreePath
    ) {
      throw new Error("git_workspace_identity_conflict");
    }
    const snapshot = await this.dependencies.git.inspect(ensured);
    if (snapshot.branch !== workspace.branch) throw new Error("git_workspace_identity_conflict");
    return ensured;
  }
}

function rootIssue(tree: LinearWorkflowTreeSnapshot, rootIssueId: string) {
  const root = tree.issues.find(({ issue_id }) => issue_id === rootIssueId);
  if (!root || root.parent_issue_id !== undefined || root.issue_kind !== "root") {
    throw new Error("root_ownership_root_invalid");
  }
  return root;
}

function rootOwnership(tree: LinearWorkflowTreeSnapshot, rootIssueId: string): RootOwnershipRecord | undefined {
  const records: RootOwnershipRecord[] = [];
  for (const comment of tree.comments) {
    if (comment.issue_id !== rootIssueId || !comment.body.startsWith(managedRecordMarker)) continue;
    const parsed = parseManagedRecord(comment.body);
    if (!parsed.ok) throw new Error("root_ownership_record_invalid");
    if (parsed.value.kind === "root_ownership") records.push(parsed.value);
  }
  if (records.length > 1) throw new Error("root_ownership_duplicate");
  return records[0];
}

function requireApplied(
  outcome: Awaited<ReturnType<RootOwnershipClaimDependencies["linear"]["mutateWorkflow"]>>,
  code: string,
): void {
  if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") throw new Error(code);
}

function sameOwnership(left: RootOwnershipRecord, right: RootOwnershipRecord): boolean {
  return serializeManagedRecord(left) === serializeManagedRecord(right);
}

function statusCode(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_|_$/gu, "");
  return /^[a-z][a-z0-9_]{0,48}$/u.test(normalized) ? normalized : "unknown";
}
