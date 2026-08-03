import assert from "node:assert/strict";
import test from "node:test";

import type { MutationResult } from "../../contracts/mutation.js";
import type { GitSnapshot } from "../../contracts/observation.js";
import type {
  CommitWorkspaceRequest,
  GitCommitProof,
  GitWorkspaceInterface,
  PrepareWorkspaceRequest,
  RootWorkspaceIdentity,
} from "./GitWorkspaceInterface.js";

const git = {
  prepare(request: PrepareWorkspaceRequest): Promise<MutationResult> {
    return Promise.resolve({ schema_version: 1, outcome: "not_applied", target_id: request.root_id, correlation_id: request.correlation_id, reason: "inert fixture" });
  },
  read(): Promise<GitSnapshot> { return Promise.reject(new Error("inert_fixture")); },
  readCommitProof(): Promise<GitCommitProof> { return Promise.reject(new Error("inert_fixture")); },
  commit(request: CommitWorkspaceRequest): Promise<MutationResult> {
    return Promise.resolve({ schema_version: 1, outcome: "not_applied", target_id: request.root_id, correlation_id: request.correlation_id, reason: "inert fixture" });
  },
} satisfies GitWorkspaceInterface;

test("Git workspace interface exposes only Root-scoped typed operations", () => {
  const methods: readonly (keyof GitWorkspaceInterface)[] = ["prepare", "read", "readCommitProof", "commit"];
  assert.deepEqual(Object.keys(git).sort(), [...methods].sort());
  const identityKeys: readonly (keyof RootWorkspaceIdentity)[] = ["root_id", "repository_id", "base_branch", "head_branch"];
  assert.equal(identityKeys.includes("root_id"), true);
});
