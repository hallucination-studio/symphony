import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export function createSerializedWorkflowBoundary({ statePath, readState = readFile, writeState = writeFile } = {}) {
  if (typeof statePath !== "string" || statePath.length === 0 || typeof readState !== "function" || typeof writeState !== "function") {
    throw new Error("serialized_workflow_boundary_invalid");
  }
  const requestKinds = [];
  const mutationKinds = [];
  const treeReadDigests = [];
  const handler = Object.freeze({
    async handle(message) {
      const body = message?.body;
      requestKinds.push(body?.kind ?? "unknown");
      if (body?.kind === "conductor_handshake" || body?.kind === "conductor_heartbeat" || body?.kind === "conductor_runtime_report") {
        return { ...message, body: runtimeReport(body) };
      }
      if (body?.kind === "resolve_conductor_project") {
        return { ...message, body: {
          kind: "resolved",
          resolved_project: {
            conductor_short_hash: body.conductor_short_hash,
            conductor_pool: [{ conductor_short_hash: body.conductor_short_hash }],
            project: {
              project_id: "project-1",
              organization_id: "organization-1",
              name: "Serialized Workflow",
              updated_at: "2026-07-22T00:00:00.000Z",
            },
          },
        } };
      }
      if (body?.kind === "list_root_issues") {
        const tree = await readTree();
        const root = tree.issues.find(({ issue_id }) => issue_id === tree.root_issue_id);
        if (!root) throw new Error("serialized_workflow_root_missing");
        return { ...message, body: {
          kind: "root_issues_page",
          items: [{
            issue: {
              issue_id: root.issue_id,
              identifier: root.identifier,
              project_id: root.project_id,
              state: root.status_name,
              order: root.order,
              depth: root.depth,
              title: root.title,
              description: root.description,
              updated_at: root.updated_at,
            },
            is_delegated_to_symphony: true,
            priority: "high",
            blockers: [],
            root_conductor_labels: [],
            root_managed_comments: tree.comments
              .filter(({ issue_id }) => issue_id === root.issue_id)
              .map(({ comment_id, issue_id, body: commentBody, managed_marker, updated_at }) => ({
                comment_id, issue_id, body: commentBody, managed_marker, updated_at,
              })),
          }],
          page_info: { has_next_page: false },
        } };
      }
      if (body?.kind === "get_workflow_issue_tree") {
        return { ...message, body: { kind: "workflow_issue_tree", tree: await readTree() } };
      }
      if (body?.kind === "update_workflow_issue" || body?.kind === "append_workflow_comment") {
        mutationKinds.push(body.kind);
        return { ...message, body: await applyMutation(body) };
      }
      throw new Error("serialized_workflow_request_unsupported");
    },
  });

  return Object.freeze({ handler, requestKinds, mutationKinds, treeReadDigests });

  async function readTree() {
    const serialized = await readState(statePath, "utf8");
    treeReadDigests.push(createHash("sha256").update(serialized).digest("hex"));
    return JSON.parse(serialized);
  }

  async function applyMutation(body) {
    const tree = await readTree();
    const root = tree.issues.find(({ issue_id }) => issue_id === tree.root_issue_id);
    if (!root || body.expected_root_remote_version !== root.remote_version) {
      return { kind: "precondition_conflict" };
    }
    if (body.kind === "update_workflow_issue") {
      const target = tree.issues.find(({ issue_id }) => issue_id === body.target?.target_issue_id);
      const status = tree.status_catalog.find(({ status_id }) => status_id === body.status_id);
      if (!target || !status || !targetMatches(target, body.target)) return { kind: "precondition_conflict" };
      Object.assign(target, {
        status_id: status.status_id,
        status_name: status.name,
        status_category: status.category,
        status_position: status.position,
        title: body.title,
        description: body.description,
        remote_version: `${body.write_id}:version`,
      });
      if (target.issue_id === root.issue_id) root.remote_version = target.remote_version;
      await writeTree(tree);
      return { kind: "applied", read_back: readBack(body.write_id, target.issue_id, target.remote_version) };
    }
    const target = tree.issues.find(({ issue_id }) => issue_id === body.target?.target_issue_id);
    if (!target || !targetMatches(target, body.target)) return { kind: "precondition_conflict" };
    const existing = tree.comments.find(({ issue_id, managed_marker, body: commentBody }) =>
      issue_id === target.issue_id && (managed_marker === body.write_id || commentBody === body.body));
    if (existing) return { kind: "already_applied", read_back: readBack(body.write_id, target.issue_id, existing.remote_version) };
    tree.comments.push({
      comment_id: body.write_id,
      issue_id: target.issue_id,
      body: body.body,
      managed_marker: body.write_id,
      remote_version: `${body.write_id}:comment-version`,
      updated_at: tree.observed_at,
    });
    await writeTree(tree);
    return { kind: "applied", read_back: readBack(body.write_id, target.issue_id, `${body.write_id}:comment-version`) };
  }

  async function writeTree(tree) {
    await writeState(statePath, JSON.stringify(tree, null, 2), "utf8");
  }
}

function targetMatches(target, expected) {
  return target.remote_version === expected?.expected_remote_version
    && (expected.expected_status_id === undefined || target.status_id === expected.expected_status_id)
    && (expected.expected_parent_issue_id === undefined || target.parent_issue_id === expected.expected_parent_issue_id)
    && (expected.expected_managed_marker === undefined || target.managed_marker === expected.expected_managed_marker);
}

function readBack(writeId, targetIssueId, remoteVersion) {
  return { write_id: writeId, target_issue_id: targetIssueId, remote_version: remoteVersion };
}

function runtimeReport(body) {
  return {
    kind: "conductor_runtime_report",
    binding_id: body.binding_id,
    instance_id: body.instance_id,
    status: body.kind === "conductor_runtime_report" ? body.status : body.kind === "conductor_handshake" ? "starting" : "ready",
    observed_at: new Date().toISOString(),
    ...(typeof body.sanitized_summary === "string" ? { sanitized_summary: body.sanitized_summary } : {}),
  };
}
