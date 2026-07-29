import assert from "node:assert/strict";
import test from "node:test";

import { parseRevision } from "../../contracts/identity.js";
import type { PullRequestObservation } from "../../contracts/observation.js";
import { createDeliveryIdentity, verifiedDelivery } from "./DeliveryInterface.js";

test("delivery identity encodes Root identity injectively and deterministically", () => {
  const first = createDeliveryIdentity({ provider: "github", root_id: "LIN-1", repository_id: "repo:1", base_branch: "main" });
  const same = createDeliveryIdentity({ provider: "github", root_id: "LIN-1", repository_id: "repo:1", base_branch: "main" });
  const other = createDeliveryIdentity({ provider: "github", root_id: "LIN-2", repository_id: "repo:1", base_branch: "main" });
  assert.deepEqual(first, same);
  assert.notEqual(first.head_branch, other.head_branch);
});

test("delivery is accepted only for one open PR at the exact verified revision", () => {
  const identity = createDeliveryIdentity({ provider: "github", root_id: "LIN-1", repository_id: "repo:1", base_branch: "main" });
  const revision = parseRevision("a".repeat(40));
  const pullRequest: PullRequestObservation = {
    provider: identity.provider,
    repository_id: identity.repository_id,
    base_branch: identity.base_branch,
    head_branch: identity.head_branch,
    state: "open",
    head_revision: revision,
    url: "https://github.example/pr/1",
  };
  assert.equal(verifiedDelivery({ identity, remote_revision: revision, matching_pull_requests: [pullRequest] }, revision), pullRequest);
  assert.throws(() => verifiedDelivery({ identity, remote_revision: revision, matching_pull_requests: [pullRequest, pullRequest] }, revision), /delivery_readback_mismatch/u);
  assert.throws(() => verifiedDelivery({ identity, remote_revision: parseRevision("b".repeat(40)), matching_pull_requests: [pullRequest] }, revision), /delivery_readback_mismatch/u);
});
