import assert from "node:assert/strict";
import test from "node:test";

import { FOREGROUND_E2E_CASES } from "../../tools/e2e/cases.mjs";
import {
  deriveForegroundE2EVerdict,
  evaluateForegroundE2EAssertions,
  runForegroundE2ECases,
  validateForegroundE2EAssertionCatalog,
} from "../../tools/e2e/verdict.mjs";

const DATE = "2026-07-28T00:00:00.000Z";
const LATER = "2026-07-28T00:00:01.000Z";
const DONE = "2026-07-28T00:00:02.000Z";

test("the assertion catalog is the frozen Case catalog and has no second allowlist", () => {
  assert.doesNotThrow(() => validateForegroundE2EAssertionCatalog(FOREGROUND_E2E_CASES));
  const changed = structuredClone(FOREGROUND_E2E_CASES);
  changed[0].assertions[0].predicate = "invented";
  assert.throws(
    () => validateForegroundE2EAssertionCatalog(changed),
    hasCode("foreground_e2e_assertion_catalog_invalid"),
  );
});

test("approved happy path is proven only by native Linear and Git evidence", () => {
  const fixture = approvedFixture();
  const assertions = evaluateForegroundE2EAssertions(fixture);

  assert.ok(assertions.every(({ outcome }) => outcome === "satisfied"), JSON.stringify(assertions, null, 2));
  assert.deepEqual(deriveForegroundE2EVerdict(assertions), { verdict: "passed", reasonCodes: [] });
  assert.equal(Object.hasOwn(fixture.evidence.roots[0], "managedRecords"), false);
});

test("incomplete native pagination makes every dependent assertion incomplete", () => {
  const fixture = approvedFixture();
  fixture.evidence.coverage = {
    isComplete: false,
    omissions: [{ rootIssueId: "root-1", sourceId: "cycle-1", scope: "children", code: "foreground_e2e_evidence_pagination_failed" }],
  };
  const assertions = evaluateForegroundE2EAssertions(fixture);

  assert.ok(assertions.every(({ outcome }) => outcome === "coverage_missing"));
  assert.equal(deriveForegroundE2EVerdict(assertions).verdict, "incomplete");
});

test("machine serialization in Symphony content contradicts human_content_only", () => {
  const fixture = approvedFixture();
  fixture.evidence.roots[0].comments[0].body = 'Approval\n\n```json\n{"kind":"plan_contract"}\n```';

  const assertions = evaluateForegroundE2EAssertions(fixture);
  assert.equal(outcome(assertions, "human_content_only"), "contradicted");
  assert.equal(deriveForegroundE2EVerdict(assertions).verdict, "failed");
});

test("a terminal native Issue cannot transition back to started", () => {
  const fixture = approvedFixture();
  fixture.evidence.roots[0].activity.push(activity({
    id: "work-redispatched",
    issueId: "work-1",
    fromStateId: "done-state",
    toStateId: "started-state",
    createdAt: "2026-07-28T00:00:03.000Z",
  }));

  const assertions = evaluateForegroundE2EAssertions(fixture);
  assert.equal(outcome(assertions, "terminal_nodes_not_dispatched"), "contradicted");
});

test("a Human-created descendant is a prohibited test control fact", () => {
  const fixture = approvedFixture();
  fixture.evidence.roots[0].issues.find(({ id }) => id === "work-1").creatorId = "human-1";

  const assertions = evaluateForegroundE2EAssertions(fixture);
  assert.equal(outcome(assertions, "no_test_control_facts"), "contradicted");
});

test("missing-worktree verdict derives fresh generation IDs from the final native Cycle subtree", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "missing_worktree_recovery");
  const oldIds = ["cycle-old", "plan-old", "work-old", "verify-old"];
  const freshIds = ["cycle-fresh", "plan-fresh", "work-fresh", "verify-fresh"];
  const invalidIssues = [
    issue({ id: "root-invalid", identifier: "SYM-20", description: definition.rootCreationInputs[1].description, stateId: "review-state", stateName: "In Review", stateType: "started", depth: 0, labels: [label("Root"), { id: "route-b", name: "symphony:conductor/b" }], creatorId: "human-1" }),
    issue({ id: "cycle-old", identifier: "SYM-21", parentId: "root-invalid", description: "Invalid old cycle.", stateId: "canceled-state", stateName: "Canceled", stateType: "canceled", depth: 1, labels: [label("Cycle")] }),
    issue({ id: "plan-old", identifier: "SYM-22", parentId: "cycle-old", description: "Old Plan.", stateId: "done-state", stateName: "Done", stateType: "completed", depth: 2, labels: [label("Plan")] }),
    issue({ id: "work-old", identifier: "SYM-23", parentId: "cycle-old", description: "Old Work.", stateId: "done-state", stateName: "Done", stateType: "completed", depth: 2, labels: [label("Work")] }),
    issue({ id: "verify-old", identifier: "SYM-24", parentId: "cycle-old", description: "Old Verify.", stateId: "done-state", stateName: "Done", stateType: "completed", depth: 2, labels: [label("Verify")] }),
    issue({ id: "cycle-fresh", identifier: "SYM-25", parentId: "root-invalid", description: "Fresh cycle.", stateId: "succeeded-state", stateName: "Succeeded", stateType: "completed", depth: 1, labels: [label("Cycle")] }),
    issue({ id: "plan-fresh", identifier: "SYM-26", parentId: "cycle-fresh", description: "Fresh Plan.", stateId: "done-state", stateName: "Done", stateType: "completed", depth: 2, labels: [label("Plan")] }),
    issue({ id: "work-fresh", identifier: "SYM-27", parentId: "cycle-fresh", description: "Fresh Work.", stateId: "done-state", stateName: "Done", stateType: "completed", depth: 2, labels: [label("Work")] }),
    issue({ id: "verify-fresh", identifier: "SYM-28", parentId: "cycle-fresh", description: "Fresh Verify passed.", stateId: "done-state", stateName: "Done", stateType: "completed", depth: 2, labels: [label("Verify")] }),
  ].map((value) => ({ ...value, rootIssueId: "root-invalid" }));
  invalidIssues.filter(({ id }) => oldIds.includes(id)).forEach((value) => { value.archivedAt = DONE; });
  const fixture = {
    definition,
    context: {
      humanActorId: "human-1",
      missingWorktree: {
        recoverableRootId: "root-recoverable",
        invalidRootId: "root-invalid",
        oldCycleId: "cycle-old",
        oldNativeIssueIds: oldIds,
        freshCycleIssueId: "cycle-fresh",
        freshPlanIssueId: "plan-fresh",
        freshApprovalCommentId: "approval-fresh",
        oldApprovalCommentId: "approval-old",
      },
    },
    evidence: {
      caseId: definition.caseId,
      observedAt: DONE,
      rootIssueIds: ["root-recoverable", "root-invalid"],
      statusCatalog: statusCatalog(),
      roots: [
        { rootIssueId: "root-recoverable", issues: [], comments: [], relations: [], attachments: [], activity: [] },
        { rootIssueId: "root-invalid", issues: invalidIssues, comments: [comment({ id: "approval-fresh", issueId: "root-invalid", authorId: "human-1", body: "Approved.", createdAt: DONE })], relations: [], attachments: [], activity: [] },
      ],
      git: [
        { rootIssueId: "root-recoverable", branch: "symphony/runs/sym-10", headRevision: "commit-a" },
        { rootIssueId: "root-invalid", branch: "symphony/runs/sym-20", headRevision: "commit-b" },
      ],
      coverage: { isComplete: true, omissions: [] },
    },
  };

  const assertions = evaluateForegroundE2EAssertions(fixture);
  assert.equal(outcome(assertions, "fresh_generation_uses_new_native_ids"), "satisfied");
  assert.deepEqual(freshIds, invalidIssues.filter(({ id }) => freshIds.includes(id)).map(({ id }) => id));
});

test("contradiction outranks incomplete and process faults never become success", () => {
  const assertions = [
    assertionOutcome("native_identity_consistent", "contradicted"),
    assertionOutcome("complete_native_coverage", "coverage_missing"),
  ];
  assert.deepEqual(deriveForegroundE2EVerdict(assertions), {
    verdict: "failed",
    reasonCodes: ["e2e.test.native_identity_consistent.contradicted"],
  });
  assert.deepEqual(deriveForegroundE2EVerdict([assertionOutcome("native_identity_consistent", "satisfied")], {
    processFault: "foreground_e2e_required_process_exited",
  }), {
    verdict: "failed",
    reasonCodes: ["foreground_e2e_required_process_exited"],
  });
});

test("scheduler settles every Case, quiesces writers once, then final-reads every Case", async () => {
  const started = [];
  const settled = [];
  const finalReads = [];
  const reportedAssertions = [];
  let writersQuiesced = 0;
  const result = await runForegroundE2ECases({
    definitions: FOREGROUND_E2E_CASES,
    runCase: async ({ definition }) => {
      started.push(definition.caseId);
      try {
        if (definition.caseId === "plan_rejected_and_replanned") {
          throw Object.assign(new Error("driver failed"), { code: "foreground_e2e_driver_failed" });
        }
        return { context: {} };
      } finally {
        settled.push(definition.caseId);
      }
    },
    quiesce: async () => {
      assert.equal(settled.length, FOREGROUND_E2E_CASES.length);
      writersQuiesced += 1;
    },
    readFinalEvidence: async ({ definition }) => {
      assert.equal(writersQuiesced, 1);
      finalReads.push(definition.caseId);
      return { evidence: emptyEvidence(definition), context: { humanActorId: "human-1", rootIssueIdsByKey: {} } };
    },
    reporter: {
      caseObservation() {},
      caseAssertion(assertion) { reportedAssertions.push(assertion); },
    },
  });

  assert.deepEqual(started.sort(), FOREGROUND_E2E_CASES.map(({ caseId }) => caseId).sort());
  assert.deepEqual(settled.sort(), FOREGROUND_E2E_CASES.map(({ caseId }) => caseId).sort());
  assert.equal(writersQuiesced, 1);
  assert.deepEqual(finalReads.sort(), FOREGROUND_E2E_CASES.map(({ caseId }) => caseId).sort());
  assert.equal(reportedAssertions.length, FOREGROUND_E2E_CASES
    .reduce((total, definition) => total + definition.assertions.length, 0));
  assert.equal(reportedAssertions.every(({ caseId, assertionId, outcome: value, reasonCode }) =>
    typeof caseId === "string" && typeof assertionId === "string" && value === "coverage_missing" &&
      reasonCode === `e2e.${caseId}.${assertionId}.coverage_missing`), true);
  assert.equal(result.exitCode, 1);
  assert.equal(result.cases.length, FOREGROUND_E2E_CASES.length);
  assert.ok(result.cases.every(({ verdict }) => verdict === "incomplete"));
});

test("scheduler cannot pass a Case whose driver scope failed even when final evidence looks complete", async () => {
  const approved = approvedFixture();
  const finalReads = [];
  const result = await runForegroundE2ECases({
    definitions: FOREGROUND_E2E_CASES,
    createCaseScope: ({ definition }) => {
      if (definition.caseId === "approved_happy_path") {
        throw Object.assign(new Error("scope failed"), { code: "foreground_e2e_case_scope_failed" });
      }
      return { caseId: definition.caseId, signal: new AbortController().signal };
    },
    runCase: async () => ({ context: {} }),
    quiesce: async () => {},
    readFinalEvidence: async ({ definition }) => {
      finalReads.push(definition.caseId);
      return definition.caseId === "approved_happy_path"
        ? { evidence: approved.evidence, context: approved.context }
        : { evidence: emptyEvidence(definition), context: { humanActorId: "human-1", rootIssueIdsByKey: {} } };
    },
  });

  assert.deepEqual(finalReads.sort(), FOREGROUND_E2E_CASES.map(({ caseId }) => caseId).sort());
  assert.equal(result.cases.find(({ caseId }) => caseId === "approved_happy_path")?.verdict, "incomplete");
});

function approvedFixture() {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "approved_happy_path");
  const rootDescription = definition.rootCreationInputs[0].description;
  const issues = [
    issue({ id: "root-1", identifier: "SYM-1", description: rootDescription, stateId: "review-state", stateName: "In Review", stateType: "started", depth: 0, labels: [label("Root"), { id: "route-1", name: "symphony:conductor/a" }], creatorId: "human-1" }),
    issue({ id: "cycle-1", identifier: "SYM-2", parentId: "root-1", title: "Cycle 1", description: "Execute the approved plan.", stateId: "succeeded-state", stateName: "Succeeded", stateType: "completed", depth: 1, labels: [label("Cycle")] }),
    issue({ id: "plan-1", identifier: "SYM-3", parentId: "cycle-1", title: "Plan", description: "Approved plan with acceptance criteria.", stateId: "done-state", stateName: "Done", stateType: "completed", depth: 2, labels: [label("Plan")] }),
    issue({ id: "work-1", identifier: "SYM-4", parentId: "cycle-1", title: "Implement helper", description: "Implemented and checked at commit-1.", stateId: "done-state", stateName: "Done", stateType: "completed", depth: 2, labels: [label("Work")] }),
    issue({ id: "verify-1", identifier: "SYM-5", parentId: "cycle-1", title: "Verify", description: "Verification completed.", stateId: "done-state", stateName: "Done", stateType: "completed", depth: 2, labels: [label("Verify"), label("Passed")] }),
  ];
  const comments = [
    comment({ id: "approval-request", issueId: "root-1", authorId: "symphony-1", body: "Please approve Plan SYM-3 (plan-1).", createdAt: DATE }),
    comment({ id: "approval-reply", issueId: "root-1", parentId: "approval-request", authorId: "human-1", body: "Approved.", createdAt: LATER, reactions: [reaction()] }),
  ];
  const activities = [
    activity({ id: "work-start", issueId: "work-1", fromStateId: "todo-state", toStateId: "started-state", createdAt: "2026-07-28T00:00:01.500Z" }),
    activity({ id: "work-done", issueId: "work-1", fromStateId: "started-state", toStateId: "done-state", createdAt: DONE }),
    activity({ id: "verify-done", issueId: "verify-1", fromStateId: "started-state", toStateId: "done-state", createdAt: DONE }),
  ];
  return {
    definition,
    context: { humanActorId: "human-1", rootIssueIdsByKey: { "approved-root": "root-1" } },
    evidence: {
      caseId: definition.caseId,
      observedAt: DONE,
      rootIssueIds: ["root-1"],
      statusCatalog: statusCatalog(),
      roots: [{
        rootIssueId: "root-1",
        issues,
        comments,
        relations: [],
        attachments: [
          { id: "revision-1", issueId: "verify-1", title: "Verified Git revision", url: "https://github.com/acme/repo/commit/commit-1", sourceType: "github", createdAt: DONE, updatedAt: DONE, remoteVersion: DONE, archivedAt: null },
          { id: "pr-1", issueId: "root-1", title: "Delivery pull request", url: "https://github.com/acme/repo/pull/1", sourceType: "github", createdAt: DONE, updatedAt: DONE, remoteVersion: DONE, archivedAt: null },
        ],
        activity: activities,
      }],
      git: [{ rootIssueId: "root-1", repositoryRoot: "/repo/root-1", repositoryRootCanonical: "/repo/root-1", branch: "symphony/runs/sym-1", headRevision: "commit-1", status: "", headChangedPaths: ["src/helper.ts"] }],
      coverage: { isComplete: true, omissions: [] },
    },
  };
}

function emptyEvidence(definition) {
  return {
    caseId: definition.caseId,
    observedAt: DONE,
    rootIssueIds: [],
    roots: [],
    statusCatalog: [],
    git: [],
    coverage: { isComplete: false, omissions: [{ rootIssueId: "unknown", sourceId: "unknown", scope: "root", code: "foreground_e2e_evidence_linear_read_failed" }] },
  };
}

function issue({
  id,
  identifier,
  parentId = null,
  title = id,
  description,
  stateId,
  stateName,
  stateType,
  depth,
  labels,
  creatorId = "symphony-1",
}) {
  return { id, identifier, rootIssueId: "root-1", parentId, projectId: "project-1", teamId: "team-1", creatorId, title, description, priority: 2, labels, state: { id: stateId, name: stateName, type: stateType, position: 1, archivedAt: null, createdAt: DATE, updatedAt: DONE, remoteVersion: DONE }, archivedAt: null, createdAt: DATE, updatedAt: DONE, remoteVersion: DONE, depth };
}

function comment({ id, issueId, parentId = null, authorId, body, createdAt, reactions = [] }) {
  return { id, issueId, parentId, authorId, body, archivedAt: null, createdAt, updatedAt: createdAt, remoteVersion: createdAt, editedAt: null, resolvedAt: parentId ? DONE : null, reactions, thread: { rootCommentId: parentId ?? id, state: "resolved" } };
}

function activity({ id, issueId, fromStateId, toStateId, createdAt }) {
  return { id, issueId, actorId: "symphony-1", createdAt, updatedAt: createdAt, remoteVersion: createdAt, archived: null, fromStateId, toStateId, fromParentId: null, toParentId: null, fromPriority: null, toPriority: null, updatedDescription: false };
}

function reaction() { return { id: "receipt-1", emoji: "white_check_mark", actorId: "symphony-1", archivedAt: null, createdAt: DONE, updatedAt: DONE, remoteVersion: DONE }; }
function label(name) {
  const kind = ["Root", "Cycle", "Plan", "Work", "Verify", "Finding"].includes(name);
  return { id: `${name.toLowerCase()}-label`, name: kind ? `symphony:kind/${name.toLowerCase()}` : name };
}
function statusCatalog() { return [
  { id: "todo-state", name: "Todo", type: "unstarted", position: 1, archivedAt: null, createdAt: DATE, updatedAt: DATE, remoteVersion: DATE },
  { id: "started-state", name: "In Progress", type: "started", position: 2, archivedAt: null, createdAt: DATE, updatedAt: DATE, remoteVersion: DATE },
  { id: "review-state", name: "In Review", type: "started", position: 3, archivedAt: null, createdAt: DATE, updatedAt: DATE, remoteVersion: DATE },
  { id: "done-state", name: "Done", type: "completed", position: 4, archivedAt: null, createdAt: DATE, updatedAt: DATE, remoteVersion: DATE },
  { id: "succeeded-state", name: "Succeeded", type: "completed", position: 5, archivedAt: null, createdAt: DATE, updatedAt: DATE, remoteVersion: DATE },
]; }
function outcome(assertions, assertionId) { return assertions.find((assertion) => assertion.assertionId === assertionId)?.outcome; }
function assertionOutcome(assertionId, value) { return { assertionId, outcome: value, reasonCodePrefix: `e2e.test.${assertionId}`, ...(value === "satisfied" ? {} : { reasonCode: `e2e.test.${assertionId}.${value}` }), evidenceReferences: [] }; }
function hasCode(code) { return (error) => error?.code === code; }
