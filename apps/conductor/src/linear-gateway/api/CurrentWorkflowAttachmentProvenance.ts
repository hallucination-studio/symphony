import type { LinearWorkflowTreeSnapshot } from "./LinearGatewayInterface.js";

export function hasCurrentWorkflowAttachmentProof(input: {
  tree: LinearWorkflowTreeSnapshot;
  attachment: LinearWorkflowTreeSnapshot["attachments"][number];
}): boolean {
  const { tree, attachment } = input;
  const source = tree.source_manifest.find((candidate) =>
    candidate.source_kind === "linear_attachment" &&
    candidate.source_id === attachment.attachment_id &&
    candidate.source_version === attachment.remote_version);
  if (source?.actor_kind === "symphony") return true;
  if (source?.actor_kind !== "unknown" || !tree.coverage.is_complete) return false;

  const latest = tree.activities
    .filter((activity) => activity.issue_id === attachment.issue_id &&
      activity.attachment_id === attachment.attachment_id &&
      activity.activity_kinds.includes("attachment_changed"))
    .sort((left, right) => left.created_at.localeCompare(right.created_at) ||
      compareCodePoints(left.activity_id, right.activity_id))
    .at(-1);
  return latest?.actor_kind === "symphony" && latest.actor_id !== undefined;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
