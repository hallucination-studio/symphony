import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export function createSerializedWorkflowBoundary({ statePath, readState = readFile } = {}) {
  if (typeof statePath !== "string" || statePath.length === 0 || typeof readState !== "function") {
    throw new Error("serialized_workflow_boundary_invalid");
  }
  const requestKinds = [];
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
      throw new Error("serialized_workflow_request_unsupported");
    },
  });

  return Object.freeze({ handler, requestKinds, treeReadDigests });

  async function readTree() {
    const serialized = await readState(statePath, "utf8");
    treeReadDigests.push(createHash("sha256").update(serialized).digest("hex"));
    return JSON.parse(serialized);
  }
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
