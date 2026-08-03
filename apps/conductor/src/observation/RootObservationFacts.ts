import { createHash } from "node:crypto";

import { parseObservationDigest, type ObservationDigest } from "../contracts/identity.js";
import type {
  ConcreteGitChange,
  GitSnapshot,
} from "../contracts/observation.js";
import type { TaskSnapshot } from "../contracts/task-management.js";
import { canonicalTaskSnapshot } from "./TaskFacts.js";

function canonicalGitSnapshot(snapshot: GitSnapshot) {
  return {
    repository_id: snapshot.repository_id,
    base_branch: snapshot.base_branch,
    head_branch: snapshot.head_branch,
    head_revision: snapshot.head_revision,
    workspace_state: snapshot.workspace_state,
    diff_digest: snapshot.diff_digest,
    pull_request: snapshot.pull_request === null ? null : {
      provider: snapshot.pull_request.provider,
      repository_id: snapshot.pull_request.repository_id,
      base_branch: snapshot.pull_request.base_branch,
      head_branch: snapshot.pull_request.head_branch,
      state: snapshot.pull_request.state,
      head_revision: snapshot.pull_request.head_revision,
      url: snapshot.pull_request.url,
    },
  };
}

export function rootObservationDigest(task: TaskSnapshot, git: GitSnapshot): ObservationDigest {
  const canonical = JSON.stringify({
    schema_version: 1,
    task: canonicalTaskSnapshot(task),
    git: canonicalGitSnapshot(git),
  });
  const digest = createHash("sha256")
    .update("symphony:root-observation:v1\0")
    .update(canonical)
    .digest("hex");
  return parseObservationDigest(`sha256:${digest}`);
}

export function gitSnapshotChanges(before: GitSnapshot, after: GitSnapshot): readonly ConcreteGitChange[] {
  const changes: ConcreteGitChange[] = [];
  if (before.head_revision !== after.head_revision) {
    changes.push({ kind: "head_changed", before: before.head_revision, after: after.head_revision });
  }
  if (before.workspace_state !== after.workspace_state) {
    changes.push({ kind: "workspace_changed", before: before.workspace_state, after: after.workspace_state });
  }
  const beforePullRequestRevision = before.pull_request?.head_revision ?? null;
  const afterPullRequestRevision = after.pull_request?.head_revision ?? null;
  if (beforePullRequestRevision !== afterPullRequestRevision) {
    changes.push({
      kind: "pull_request_changed",
      before: beforePullRequestRevision,
      after: afterPullRequestRevision,
    });
  }
  return Object.freeze(changes);
}
