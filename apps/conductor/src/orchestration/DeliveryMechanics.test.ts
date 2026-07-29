import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseObservationDigest,
  parseRepositoryId,
  parseRevision,
  parseRootIssueId,
} from "../contracts/identity.js";
import type { MutationResult } from "../contracts/mutation.js";
import type { GitObservation, LinearObservation, PullRequestObservation } from "../contracts/observation.js";
import {
  createDeliveryIdentity,
  type DeliveryObservation,
} from "../delivery/api/DeliveryInterface.js";
import type { RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { LinearMutation } from "../linear/api/LinearGatewayInterface.js";
import { DeliveryMechanics } from "./DeliveryMechanics.js";

const rootId = parseRootIssueId("LIN-1");
const revision = parseRevision("a".repeat(40));
const otherRevision = parseRevision("b".repeat(40));
const identity = createDeliveryIdentity({
  provider: "github",
  root_id: rootId,
  repository_id: parseRepositoryId("repo:1"),
  base_branch: "main",
});
const workspace: RootWorkspaceIdentity = {
  root_id: rootId,
  repository_id: identity.repository_id,
  base_branch: identity.base_branch,
  head_branch: identity.head_branch,
};
const request = {
  root_id: rootId,
  cycle_issue_id: parseCycleIssueId("LIN-2"),
  correlation_id: parseCorrelationId("delivery:1"),
  revision,
  workspace,
  identity,
};

function pullRequest(head = revision, state: PullRequestObservation["state"] = "open"): PullRequestObservation {
  return {
    provider: identity.provider,
    repository_id: identity.repository_id,
    base_branch: identity.base_branch,
    head_branch: identity.head_branch,
    state,
    head_revision: head,
    url: "https://github.example/pull/1",
  };
}

function git(head = revision, state: GitObservation["workspace_state"] = "clean"): GitObservation {
  return {
    repository_id: workspace.repository_id,
    base_branch: workspace.base_branch,
    head_branch: workspace.head_branch,
    head_revision: head,
    workspace_state: state,
    diff_digest: parseObservationDigest(`diff:${state}`),
    pull_request: null,
  };
}

function mutation(outcome: MutationResult["outcome"], target = rootId): MutationResult {
  return outcome === "applied"
    ? { schema_version: 1, outcome, target_id: target, correlation_id: request.correlation_id }
    : { schema_version: 1, outcome, target_id: target, correlation_id: request.correlation_id, reason: outcome };
}

function fixture(options: {
  initialRemote?: typeof revision | null;
  initialPullRequests?: readonly PullRequestObservation[];
  pushOutcome?: MutationResult["outcome"];
  createOutcome?: MutationResult["outcome"];
  materializePush?: boolean;
  materializePullRequest?: boolean;
  driftGitAfterDelivery?: boolean;
  driftFinalDelivery?: boolean;
  observedIdentity?: DeliveryObservation["identity"];
} = {}) {
  const events: string[] = [];
  let linear: LinearObservation = { root_id: rootId, root_status: "In Progress", active_cycle: null };
  let remoteRevision = options.initialRemote ?? null;
  let pullRequests = [...(options.initialPullRequests ?? [])];
  let deliveryReads = 0;
  let gitReads = 0;
  const linearGateway = {
    discoverRoots: () => Promise.resolve([]),
    readRoot: () => { events.push("linear:read"); return Promise.resolve(linear); },
    mutate: (command: LinearMutation) => {
      events.push(`linear:${command.kind}:${"desired_status" in command ? command.desired_status : "create"}`);
      if (command.kind === "set_root_status" && command.desired_status === "In Review") {
        linear = { root_id: rootId, root_status: "In Review", active_cycle: null };
      }
      return Promise.resolve(mutation("applied"));
    },
  };
  const gitWorkspace = {
    prepare: () => Promise.reject(new Error("unexpected_prepare")),
    commit: () => Promise.reject(new Error("unexpected_commit")),
    read: () => {
      events.push("git:read");
      gitReads += 1;
      return Promise.resolve(options.driftGitAfterDelivery && gitReads >= 2 ? git(otherRevision, "dirty") : git());
    },
  };
  const delivery = {
    read: () => {
      events.push("delivery:read");
      deliveryReads += 1;
      const observation: DeliveryObservation = {
        identity: options.observedIdentity ?? identity,
        remote_revision: remoteRevision,
        matching_pull_requests: options.driftFinalDelivery && deliveryReads >= 4 ? [] : pullRequests,
      };
      return Promise.resolve(observation);
    },
    push: () => {
      events.push("delivery:push");
      if (options.materializePush !== false) remoteRevision = revision;
      return Promise.resolve(mutation(options.pushOutcome ?? "applied"));
    },
    createPullRequest: () => {
      events.push("delivery:create");
      if (options.materializePullRequest !== false) pullRequests = [pullRequest()];
      return Promise.resolve(mutation(options.createOutcome ?? "applied"));
    },
  };
  return {
    mechanics: new DeliveryMechanics(linearGateway, gitWorkspace, delivery),
    events,
  };
}

test("DeliveryMechanics delivers one exact revision and freshly advances Root to In Review", async () => {
  const f = fixture();
  const result = await f.mechanics.deliver(request);
  assert.equal(result.kind, "delivered");
  if (result.kind === "delivered") {
    assert.equal(result.linear.root_status, "In Review");
    assert.equal(result.git.head_revision, revision);
    assert.equal(result.pull_request.head_revision, revision);
  }
  assert.deepEqual(f.events, [
    "linear:read", "git:read", "delivery:read",
    "delivery:push", "delivery:read",
    "delivery:create", "delivery:read", "git:read",
    "linear:read", "linear:set_root_status:In Review", "linear:read",
    "delivery:read", "git:read",
  ]);
});

test("DeliveryMechanics accepts uncertain effects only from exact fresh identity read-back", async () => {
  const accepted = fixture({ pushOutcome: "acceptance_unknown", createOutcome: "acceptance_unknown" });
  assert.equal((await accepted.mechanics.deliver(request)).kind, "delivered");

  const unresolvedPush = fixture({ pushOutcome: "acceptance_unknown", materializePush: false });
  assert.equal((await unresolvedPush.mechanics.deliver(request)).kind, "precondition_mismatch");
  assert.equal(unresolvedPush.events.includes("delivery:create"), false);

  const unresolvedCreate = fixture({ createOutcome: "applied", materializePullRequest: false });
  assert.equal((await unresolvedCreate.mechanics.deliver(request)).kind, "precondition_mismatch");
  assert.equal(unresolvedCreate.events.some((event) => event.endsWith(":In Review")), false);
});

test("DeliveryMechanics accepts only applied or read-back-proven uncertain mutation outcomes", async () => {
  const rejectedOutcomes: readonly MutationResult["outcome"][] = [
    "not_applied",
    "precondition_failed",
    "readback_mismatch",
  ];
  for (const outcome of rejectedOutcomes) {
    const push = fixture({ pushOutcome: outcome });
    assert.equal((await push.mechanics.deliver(request)).kind, "precondition_mismatch");
    assert.equal(push.events.includes("delivery:create"), false);

    const create = fixture({ createOutcome: outcome });
    assert.equal((await create.mechanics.deliver(request)).kind, "precondition_mismatch");
    assert.equal(create.events.some((event) => event.endsWith(":In Review")), false);
  }
});

test("DeliveryMechanics blocks conflicting identity facts and Git drift without duplicate or review effects", async () => {
  const wrongIdentity = createDeliveryIdentity({
    provider: "github",
    root_id: rootId,
    repository_id: parseRepositoryId("repo:other"),
    base_branch: "main",
  });
  const wrongIdentityFixture = fixture({ observedIdentity: wrongIdentity });
  assert.equal((await wrongIdentityFixture.mechanics.deliver(request)).kind, "precondition_mismatch");
  assert.equal(wrongIdentityFixture.events.includes("delivery:push"), false);
  assert.equal(wrongIdentityFixture.events.includes("delivery:create"), false);

  for (const f of [
    fixture({ initialRemote: otherRevision }),
    fixture({ initialRemote: revision, initialPullRequests: [pullRequest(), pullRequest()] }),
    fixture({ initialRemote: revision, initialPullRequests: [pullRequest(revision, "closed")] }),
    fixture({ driftGitAfterDelivery: true }),
  ]) {
    const result = await f.mechanics.deliver(request);
    assert.equal(result.kind, "precondition_mismatch");
    assert.ok(f.events.filter((event) => event === "delivery:create").length <= 1);
    assert.equal(f.events.some((event) => event.endsWith(":In Review")), false);
  }
});

test("DeliveryMechanics returns final actual facts when PR identity drifts after Root review", async () => {
  const f = fixture({ driftFinalDelivery: true });
  const result = await f.mechanics.deliver(request);
  assert.equal(result.kind, "precondition_mismatch");
  assert.equal(result.linear.root_status, "In Review");
  assert.equal(result.delivery.matching_pull_requests.length, 0);
});
