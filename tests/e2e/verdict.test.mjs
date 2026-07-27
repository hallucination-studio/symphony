import assert from "node:assert/strict";
import test from "node:test";

import { FOREGROUND_E2E_CASE_IDS, FOREGROUND_E2E_CASES } from "../../tools/e2e/cases.mjs";
import {
  evaluateForegroundE2EAssertions,
  runForegroundE2ECases,
  validateForegroundE2EAssertionCatalog,
} from "../../tools/e2e/verdict.mjs";

test("the closed assertion evaluator accepts the frozen catalog and rejects unknown or duplicate records", () => {
  assert.doesNotThrow(() => validateForegroundE2EAssertionCatalog(FOREGROUND_E2E_CASES));

  const duplicate = structuredClone(FOREGROUND_E2E_CASES);
  duplicate[0].assertions.push(structuredClone(duplicate[0].assertions[0]));
  assert.throws(
    () => validateForegroundE2EAssertionCatalog(duplicate),
    hasCode("foreground_e2e_assertion_catalog_invalid"),
  );

  const unknown = structuredClone(FOREGROUND_E2E_CASES);
  unknown[0].assertions[0].assertionId = "unknown_assertion";
  assert.throws(
    () => validateForegroundE2EAssertionCatalog(unknown),
    hasCode("foreground_e2e_assertion_catalog_invalid"),
  );

  const widenedScope = structuredClone(FOREGROUND_E2E_CASES);
  widenedScope[0].assertions[0].factScope.push("foreign_case_root");
  assert.throws(
    () => validateForegroundE2EAssertionCatalog(widenedScope),
    hasCode("foreground_e2e_assertion_catalog_invalid"),
  );

  const replacementOperation = structuredClone(FOREGROUND_E2E_CASES);
  replacementOperation[0].declaredUserInteractions[0].kind = "select_workflow_next_step";
  assert.throws(
    () => validateForegroundE2EAssertionCatalog(replacementOperation),
    hasCode("foreground_e2e_assertion_catalog_invalid"),
  );
});

test("the evaluator emits only frozen contradiction or coverage reason codes", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "approved_happy_path");
  const results = evaluateForegroundE2EAssertions({
    definition,
    evidence: incompleteEvidence("approved_happy_path", ["root-approved"]),
  });

  assert.equal(results.length, definition.assertions.length);
  for (const result of results) {
    assert.ok(["satisfied", "contradicted", "coverage_missing"].includes(result.outcome));
    if (result.outcome === "satisfied") {
      assert.equal(result.reasonCode, undefined);
    } else {
      assert.equal(
        result.reasonCode,
        `${result.reasonCodePrefix}.${result.outcome}`,
      );
    }
  }
});

test("every frozen condition has a final-evidence satisfied fixture and an independent coverage-missing fixture", () => {
  for (const definition of FOREGROUND_E2E_CASES) {
    const fixture = satisfiedFixture(definition);
    const satisfied = evaluateForegroundE2EAssertions({ definition, ...fixture });
    assert.deepEqual(
      satisfied.map(({ assertionId, outcome }) => `${assertionId}:${outcome}`),
      definition.assertions.map(({ assertionId }) => `${assertionId}:satisfied`),
      `${definition.caseId}: satisfied`,
    );

    const incomplete = evaluateForegroundE2EAssertions({
      definition,
      ...fixture,
      evidence: {
        ...fixture.evidence,
        coverage: {
          isComplete: false,
          omissions: [{
            rootIssueId: fixture.evidence.rootIssueIds[0],
            sourceId: fixture.evidence.rootIssueIds[0],
            scope: "tree",
            code: "foreground_e2e_evidence_pagination_failed",
          }],
        },
      },
    });
    assert.deepEqual(
      incomplete.map(({ assertionId, outcome }) => `${assertionId}:${outcome}`),
      definition.assertions.map(({ assertionId }) => `${assertionId}:coverage_missing`),
      `${definition.caseId}: coverage_missing`,
    );
  }
});

test("every frozen condition has a durable contradictory fixture", () => {
  for (const definition of FOREGROUND_E2E_CASES) {
    for (const assertion of definition.assertions) {
      const input = satisfiedFixture(definition);
      const contrary = contradictoryFixture(definition, assertion.assertionId, input);
      const result = evaluateForegroundE2EAssertions({ definition, ...contrary })
        .find((candidate) => candidate.assertionId === assertion.assertionId);
      assert.equal(result.outcome, "contradicted", `${definition.caseId}.${assertion.assertionId}`);
      assert.equal(result.reasonCode, `${assertion.reasonCode}.contradicted`);
    }
  }
});

test("the scheduler starts every Case, preserves all settlements, and final-reads failed Cases", async () => {
  const started = [];
  const finalReads = [];
  const observations = [];
  const scopes = new Map();
  const definitionById = new Map(FOREGROUND_E2E_CASES.map((definition) => [definition.caseId, definition]));

  const summary = await runForegroundE2ECases({
    definitions: FOREGROUND_E2E_CASES,
    runCase: async ({ definition, scope }) => {
      started.push(definition.caseId);
      scopes.set(definition.caseId, scope);
      if (definition.caseId === "plan_rejected_and_replanned") throw stableError("driver_failed");
      return { deadlineExceeded: false };
    },
    readFinalEvidence: async ({ definition, scope }) => {
      finalReads.push(definition.caseId);
      assert.equal(scope, scopes.get(definition.caseId));
      return incompleteEvidence(definition.caseId, [`root-${definition.caseId}`]);
    },
    reporter: {
      caseObservation(input) {
        observations.push(input);
      },
    },
    now: sequencedClock(),
  });

  assert.deepEqual(started.sort(), FOREGROUND_E2E_CASES.map(({ caseId }) => caseId).sort());
  assert.deepEqual(finalReads.sort(), started.sort());
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.cases.length, FOREGROUND_E2E_CASES.length);
  const rejectedPlan = summary.cases.find(({ caseId }) => caseId === "plan_rejected_and_replanned");
  assert.equal(rejectedPlan.verdict, "incomplete");
  assert.equal(rejectedPlan.driverFailureCode, "driver_failed");
  assert.deepEqual(observations.find(({ caseId, observation }) =>
    caseId === "plan_rejected_and_replanned" && observation === "failed"), {
    caseId: "plan_rejected_and_replanned",
    observation: "failed",
    detail: "driver_failed",
  });
  assert.equal(new Set(scopes.values()).size, FOREGROUND_E2E_CASES.length);
  assert.ok([...scopes.values()].every(({ signal }) => signal.aborted === false));
  for (const item of summary.cases) {
    assert.equal(item.caseId, definitionById.get(item.caseId).caseId);
    assert.ok(["passed", "failed", "incomplete"].includes(item.verdict));
    assert.equal(Array.isArray(item.assertions), true);
  }
});

test("the scheduler settles an unresponsive Case driver when its scope deadline aborts", async () => {
  const controllers = [];
  const finalReads = [];
  const pending = runForegroundE2ECases({
    definitions: FOREGROUND_E2E_CASES,
    runCase: () => new Promise(() => {}),
    readFinalEvidence: async ({ definition }) => {
      finalReads.push(definition.caseId);
      return incompleteEvidence(definition.caseId, [`root-${definition.caseId}`]);
    },
    createCaseScope: ({ definition }) => {
      const controller = new AbortController();
      controllers.push(controller);
      queueMicrotask(() => controller.abort("deadline"));
      return {
        caseId: definition.caseId,
        signal: controller.signal,
        deadlineExceeded: () => true,
        dispose() {},
      };
    },
    now: sequencedClock(),
  });

  const outcome = await Promise.race([
    pending.then((summary) => ({ kind: "settled", summary })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: "timed_out" }), 50)),
  ]);

  assert.equal(outcome.kind, "settled");
  assert.equal(outcome.summary.exitCode, 1);
  assert.deepEqual(finalReads.sort(), FOREGROUND_E2E_CASE_IDS.slice().sort());
  assert.ok(outcome.summary.cases.every((item) =>
    item.verdict === "incomplete" && item.driverFailureCode === "foreground_e2e_case_deadline_exceeded"));
  assert.ok(controllers.every((controller) => controller.signal.aborted));
});

test("an unexpected required process exit releases the affected driver, final-reads it, and cannot become success", async () => {
  const fixtures = new Map(FOREGROUND_E2E_CASES.map((definition) => [definition.caseId, satisfiedFixture(definition)]));
  const controllers = [];
  const finalReads = [];
  const summary = await runForegroundE2ECases({
    definitions: FOREGROUND_E2E_CASES,
    runCase: ({ definition }) => {
      if (definition.caseId !== "approved_happy_path") return fixtures.get(definition.caseId).context;
      queueMicrotask(() => controllers[0].abort());
      return new Promise(() => {});
    },
    readFinalEvidence: async ({ definition }) => {
      finalReads.push(definition.caseId);
      return fixtures.get(definition.caseId);
    },
    createCaseScope: ({ definition }) => {
      const controller = new AbortController();
      controllers.push(controller);
      return {
        caseId: definition.caseId,
        signal: controller.signal,
        deadlineExceeded: () => false,
        processFault: () => definition.caseId === "approved_happy_path"
          ? "foreground_e2e_process_conductor_exited"
          : undefined,
        dispose() {},
      };
    },
    now: sequencedClock(),
  });

  assert.deepEqual(finalReads.sort(), FOREGROUND_E2E_CASE_IDS.slice().sort());
  const affected = summary.cases.find(({ caseId }) => caseId === "approved_happy_path");
  assert.equal(affected.verdict, "failed");
  assert.deepEqual(affected.reasonCodes, ["foreground_e2e_process_conductor_exited"]);
  assert.equal(affected.driverFailureCode, "foreground_e2e_process_conductor_exited");
  assert.equal(summary.exitCode, 1);
});

test("a Case deadline cannot turn complete evidence into success", async () => {
  const fixtures = new Map(FOREGROUND_E2E_CASES.map((definition) => [definition.caseId, satisfiedFixture(definition)]));
  const summary = await runForegroundE2ECases({
    definitions: FOREGROUND_E2E_CASES,
    runCase: async ({ definition }) => ({
      deadlineExceeded: definition.caseId === "approved_happy_path",
      context: fixtures.get(definition.caseId).context,
    }),
    readFinalEvidence: async ({ definition }) => fixtures.get(definition.caseId).evidence,
    now: sequencedClock(),
  });

  assert.equal(summary.exitCode, 1);
  const approved = summary.cases.find(({ caseId }) => caseId === "approved_happy_path");
  assert.equal(approved.verdict, "incomplete");
  assert.deepEqual(approved.reasonCodes, []);
});

test("driver and reporter failures cannot suppress final reads or override final Linear and Git evidence", async () => {
  const fixtures = new Map(FOREGROUND_E2E_CASES.map((definition) => [definition.caseId, satisfiedFixture(definition)]));
  const finalReads = [];
  const summary = await runForegroundE2ECases({
    definitions: FOREGROUND_E2E_CASES,
    runCase: async ({ definition }) => {
      if (definition.caseId === "plan_rejected_and_replanned") throw stableError("driver_failed");
      return { context: fixtures.get(definition.caseId).context };
    },
    readFinalEvidence: async ({ definition }) => {
      finalReads.push(definition.caseId);
      return fixtures.get(definition.caseId).evidence;
    },
    reporter: { caseObservation() { throw stableError("reporter_failed"); } },
    now: sequencedClock(),
  });

  assert.deepEqual(finalReads.sort(), FOREGROUND_E2E_CASE_IDS.slice().sort());
  assert.equal(summary.exitCode, 0);
  assert.ok(summary.cases.every(({ verdict }) => verdict === "passed"));
});

test("an incomplete child-tree read is coverage-missing for every dependent assertion", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "approved_happy_path");
  const fixture = satisfiedFixture(definition);
  fixture.evidence.coverage = {
    isComplete: false,
    omissions: [{ rootIssueId: fixture.evidence.rootIssueIds[0], sourceId: "plan-issue", scope: "children", code: "foreground_e2e_evidence_pagination_failed" }],
  };

  assert.ok(evaluateForegroundE2EAssertions({ definition, ...fixture }).every(({ outcome }) => outcome === "coverage_missing"));
});

test("a fresh Plan review must link one Plan contract, Plan execution/result, and Action", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "plan_rejected_and_replanned");
  const fixture = satisfiedFixture(definition);
  const root = fixture.evidence.roots[0];
  findRecord(root, "human_action_request", (record) => record.action_id === "new-action-id").record.related_issue_ids = [];

  const assertion = evaluateForegroundE2EAssertions({ definition, ...fixture })
    .find(({ assertionId }) => assertionId === "boundary_fresh_plan_review");
  assert.equal(assertion.outcome, "contradicted");
});

test("revision verdict binds the driver-recorded initial and successor Plan gates instead of borrowing another Cycle", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "root_revision_and_comment");
  for (const mutate of [
    (fixture) => { fixture.context.successorPlan.planReviewActionIssueId = fixture.context.initialPlan.planReviewActionIssueId; },
    (fixture) => { fixture.context.initialPlan.planContractSourceCommentId = fixture.context.successorPlan.planContractSourceCommentId; },
    (fixture) => { fixture.context.successorPlan.planIssueId = fixture.context.initialPlan.planIssueId; },
    (fixture) => {
      const root = fixture.evidence.roots[0];
      recordSource(root, findRecord(root, "plan_contract", (record) => record.plan_contract_digest === "revision-new-contract")).authorId = "human";
    },
  ]) {
    const fixture = satisfiedFixture(definition);
    mutate(fixture);
    const assertions = evaluateForegroundE2EAssertions({ definition, ...fixture });
    assert.equal(assertions.find(({ assertionId }) => assertionId === "revision_supersedes_cycle").outcome, "contradicted");
    assert.equal(assertions.find(({ assertionId }) => assertionId === "boundary_successor_plan_review").outcome, "contradicted");
  }
});

test("revision verdict rejects a Symphony timeline or managed comment consumed alongside a frozen input", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "root_revision_and_comment");
  const fixture = satisfiedFixture(definition);
  const root = fixture.evidence.roots[0];
  appendHumanComment(root, "revision-timeline", "System timeline", "symphony");
  findRecord(root, "root_directive").record.consumed_input_ids.push("revision-timeline");

  const assertions = evaluateForegroundE2EAssertions({ definition, ...fixture });
  assert.equal(assertions.find(({ assertionId }) => assertionId === "system_comment_treated_as_input").outcome, "contradicted");
  assert.equal(assertions.find(({ assertionId }) => assertionId === "undeclared_revision_or_conductor_interpretation").outcome, "contradicted");
});

test("revision verdict requires each comment-body receipt to retain its closed thread action", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "root_revision_and_comment");
  const fixture = satisfiedFixture(definition);
  const root = fixture.evidence.roots[0];
  delete findRecord(root, "root_reconciler_reply", (record) => record.source_input_id === "revision-comment-create").record.thread_action;

  const assertion = evaluateForegroundE2EAssertions({ definition, ...fixture })
    .find(({ assertionId }) => assertionId === "ordinary_inputs_consumed_once");
  assert.equal(assertion.outcome, "contradicted");
});

test("revision verdict rejects a comment receipt reaction not written by its Reconciler reply actor", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "root_revision_and_comment");
  const fixture = satisfiedFixture(definition);
  const root = fixture.evidence.roots[0];
  root.comments.find(({ id }) => id === "revision-comment").reactions[0].actorId = "observer";

  const assertion = evaluateForegroundE2EAssertions({ definition, ...fixture })
    .find(({ assertionId }) => assertionId === "ordinary_inputs_consumed_once");
  assert.equal(assertion.outcome, "contradicted");
});

test("rejected Plan verdict cannot borrow a Root comment, another rejection, or a replacement Action", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "plan_rejected_and_replanned");
  for (const mutate of [
    (fixture) => { fixture.evidence.roots[0].comments.find(({ id }) => id === "rejection-reason").issueId = fixture.evidence.rootIssueIds[0]; },
    (fixture) => { fixture.evidence.roots[0].managedRecords.find(({ record }) => record.kind === "root_directive").record.consumed_input_ids = ["unrelated-comment"]; },
    (fixture) => { fixture.context.replacementActionIssueId = fixture.context.rejectedActionIssueId; },
  ]) {
    const fixture = satisfiedFixture(definition);
    mutate(fixture);
    const assertion = evaluateForegroundE2EAssertions({ definition, ...fixture })
      .find(({ assertionId }) => assertionId === "rejection_consumed_and_replied");
    assert.equal(assertion.outcome, "contradicted");
  }
});

test("rejected Plan retains its historical lineage independently from the supersession requirement", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "plan_rejected_and_replanned");
  const fixture = satisfiedFixture(definition);
  const root = fixture.evidence.roots[0];
  root.managedRecords = root.managedRecords.filter(({ record }) => record.kind !== "plan_contract_supersession");

  const assertions = evaluateForegroundE2EAssertions({ definition, ...fixture });
  assert.equal(assertions.find(({ assertionId }) => assertionId === "rejected_lineage_retained").outcome, "satisfied");
  assert.equal(assertions.find(({ assertionId }) => assertionId === "rejected_contract_superseded").outcome, "contradicted");
});

test("information-answer verdict binds the frozen Action, answer, reply, and replacement Action to the driver context", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "information_requested_and_answered");
  for (const { mutate, assertionIds } of [
    {
      mutate: (fixture) => { fixture.evidence.roots[0].comments.find(({ id }) => id === "separator-answer").issueId = fixture.evidence.rootIssueIds[0]; },
      assertionIds: ["answer_consumed_and_receipted"],
    },
    {
      mutate: (fixture) => { fixture.evidence.roots[0].managedRecords.find(({ record }) => record.kind === "root_reconciler_reply").record.target_issue_id = fixture.evidence.rootIssueIds[0]; },
      assertionIds: ["answer_consumed_and_receipted"],
    },
    {
      mutate: (fixture) => { fixture.context.replacementActionIssueId = fixture.context.answeredActionIssueId; },
      assertionIds: ["answer_consumed_and_receipted", "boundary_fresh_plan_review"],
    },
    {
      mutate: (fixture) => { fixture.context.inputReferences = []; },
      assertionIds: ["answer_consumed_and_receipted", "boundary_fresh_plan_review"],
    },
  ]) {
    const fixture = satisfiedFixture(definition);
    mutate(fixture);
    const assertions = evaluateForegroundE2EAssertions({ definition, ...fixture });
    for (const assertionId of assertionIds) {
      assert.equal(assertions.find((candidate) => candidate.assertionId === assertionId).outcome, "contradicted", assertionId);
    }
  }
});

test("information-answer verdict requires a matching Answer before any Plan continuation", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "information_requested_and_answered");
  const fixture = satisfiedFixture(definition);
  const root = fixture.evidence.roots[0];
  root.managedRecords = root.managedRecords.filter(({ record }) => record.kind !== "human_action_resolution");

  const assertion = evaluateForegroundE2EAssertions({ definition, ...fixture })
    .find(({ assertionId }) => assertionId === "missing_answer_assumed");
  assert.equal(assertion.outcome, "contradicted");
});

test("information-answer verdict rejects an ambiguous replacement Plan Review lineage", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "information_requested_and_answered");
  const fixture = satisfiedFixture(definition);
  const root = fixture.evidence.roots[0];
  addRecord(root, humanActionRequest(root.rootIssueId, "duplicate-information-review", "information-review", "plan_review", "information-cycle", ["information-plan"]), {
    sourceIssueId: "information-review",
  });

  const assertion = evaluateForegroundE2EAssertions({ definition, ...fixture })
    .find(({ assertionId }) => assertionId === "boundary_fresh_plan_review");
  assert.equal(assertion.outcome, "contradicted");
});

test("information-answer verdict rejects a Human-created continuation fact", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "information_requested_and_answered");
  for (const mutate of [
    (fixture) => { fixture.evidence.roots[0].issues.find(({ id }) => id === fixture.context.replacementActionIssueId).creatorId = "human"; },
    (fixture) => {
      const root = fixture.evidence.roots[0];
      appendRecord(root, stageExecution(root.rootIssueId, "information-cycle", "human-work", "human-work-execution", "work", "information-contract", 50));
      recordSource(root, root.managedRecords.at(-1)).authorId = "human";
    },
  ]) {
    const fixture = satisfiedFixture(definition);
    mutate(fixture);
    const assertion = evaluateForegroundE2EAssertions({ definition, ...fixture })
      .find(({ assertionId }) => assertionId === "test_unblocks_or_mutates_stage");
    assert.equal(assertion.outcome, "contradicted");
  }
});

test("parallel verdict binds durable ownership to the driver-recorded frozen routing, Profile, and repository topology", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "parallel_multi_conductor");
  const fixture = satisfiedFixture(definition);
  bindParallelContext(fixture, definition);
  findRecord(fixture.evidence.roots[0], "root_ownership").record.conductor_id = "unexpected-conductor";

  const assertion = evaluateForegroundE2EAssertions({ definition, ...fixture })
    .find(({ assertionId }) => assertionId === "root_ownership_and_workspace_isolated");
  assert.equal(assertion.outcome, "contradicted");
});

test("parallel verdict treats a missing durable Stage completion timestamp as coverage-missing, never as inferred overlap", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "parallel_multi_conductor");
  const fixture = satisfiedFixture(definition);
  delete findRecord(fixture.evidence.roots[0], "stage_result", (record) => record.stage === "work").record.completed_at;

  const assertions = evaluateForegroundE2EAssertions({ definition, ...fixture });
  assert.equal(assertions.find(({ assertionId }) => assertionId === "cross_conductor_stage_overlap").outcome, "coverage_missing");
  assert.equal(assertions.find(({ assertionId }) => assertionId === "telemetry_substitutes_overlap").outcome, "coverage_missing");
});

test("preemption verdict requires one owner, equal priority, and a strictly ordered native boundary", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "same_conductor_preemption");
  for (const mutate of [
    (fixture) => { findRecord(fixture.evidence.roots[1], "root_ownership").record.conductor_id = "other-conductor"; },
    (fixture) => { fixture.evidence.roots[1].issues.find(({ depth }) => depth === 0).priority = 1; },
    (fixture) => {
      const remaining = fixture.evidence.roots.find(({ rootIssueId }) => rootIssueId === fixture.context.preemption.remainingRootId);
      findRecord(remaining, "stage_execution", (record) => record.stage === "plan").record.started_at = at(30);
    },
    (fixture) => {
      const remaining = fixture.evidence.roots.find(({ rootIssueId }) => rootIssueId === fixture.context.preemption.remainingRootId);
      findRecord(remaining, "stage_execution", (record) => record.stage === "plan").record.started_at = at(16);
    },
  ]) {
    const fixture = satisfiedFixture(definition);
    mutate(fixture);
    const assertion = evaluateForegroundE2EAssertions({ definition, ...fixture })
      .find(({ assertionId }) => assertionId === "latest_ready_root_runs_next");
    assert.equal(assertion.outcome, "contradicted");
  }
});

test("recovery verdict derives the old role session from its terminal Result and binds both Roots to their declared ownership", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "conductor_restart_recovery");
  const staleSession = satisfiedFixture(definition);
  const affected = staleSession.evidence.roots.find(({ rootIssueId }) => rootIssueId === staleSession.context.recovery.affectedRootId);
  findRecord(affected, "stage_result", ({ result_id }) => result_id === "verify-execution").record.role_session_id = "old-session";
  let assertions = evaluateForegroundE2EAssertions({ definition, ...staleSession });
  assert.equal(assertions.find(({ assertionId }) => assertionId === "recovery_uses_fresh_execution").outcome, "contradicted");
  assert.equal(assertions.find(({ assertionId }) => assertionId === "late_old_session_success").outcome, "contradicted");

  const changedOwnership = satisfiedFixture(definition);
  const changedAffected = changedOwnership.evidence.roots.find(({ rootIssueId }) => rootIssueId === changedOwnership.context.recovery.affectedRootId);
  findRecord(changedAffected, "root_ownership").record.conductor_id = "replacement-conductor";
  assertions = evaluateForegroundE2EAssertions({ definition, ...changedOwnership });
  assert.equal(assertions.find(({ assertionId }) => assertionId === "ownership_persists").outcome, "contradicted");

  const interruptedContinuous = satisfiedFixture(definition);
  const continuous = interruptedContinuous.evidence.roots.find(({ rootIssueId }) => rootIssueId === interruptedContinuous.context.recovery.continuousRootId);
  continuous.managedRecords = continuous.managedRecords.filter(({ record }) => record.kind !== "delivery");
  assertions = evaluateForegroundE2EAssertions({ definition, ...interruptedContinuous });
  assert.equal(assertions.find(({ assertionId }) => assertionId === "unaffected_root_continues").outcome, "contradicted");
  assert.equal(assertions.find(({ assertionId }) => assertionId === "boundary_recovered_and_continuous_delivered").outcome, "contradicted");

  const unrelatedDelivery = satisfiedFixture(definition);
  const unrelatedAffected = unrelatedDelivery.evidence.roots.find(({ rootIssueId }) => rootIssueId === unrelatedDelivery.context.recovery.affectedRootId);
  appendRecord(unrelatedAffected, stageExecution(unrelatedAffected.rootIssueId, "cycle-id", "verify-issue", "unrelated-execution", "verify", "contract-id", 60));
  appendRecord(unrelatedAffected, stageResult(unrelatedAffected.rootIssueId, "cycle-id", "verify-issue", "unrelated-execution", "verify", "verify_passed", {
    session: "old-session", revision: "unrelated-revision", at: 61,
  }));
  appendRecord(unrelatedAffected, verifyResult(unrelatedAffected.rootIssueId, "cycle-id", "verify-issue", "unrelated-execution"));
  appendRecord(unrelatedAffected, delivery(unrelatedAffected.rootIssueId, "cycle-id", "unrelated-execution", "unrelated-revision"));
  unrelatedDelivery.evidence.git.find(({ rootIssueId }) => rootIssueId === unrelatedAffected.rootIssueId).headRevision = "unrelated-revision";
  assertions = evaluateForegroundE2EAssertions({ definition, ...unrelatedDelivery });
  assert.equal(assertions.find(({ assertionId }) => assertionId === "recovery_uses_fresh_execution").outcome, "contradicted");
});

test("information-answer verdict reconstructs a unique final Linear lineage only when T10 driver context is absent", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "information_requested_and_answered");
  const fixture = satisfiedFixture(definition);
  delete fixture.context.inputReferences;
  delete fixture.context.answeredActionIssueId;
  delete fixture.context.replacementActionIssueId;

  const assertions = evaluateForegroundE2EAssertions({ definition, ...fixture });
  assert.ok(assertions.every(({ outcome }) => outcome === "satisfied"));
});

test("approved happy path rejects unrendered Stage, Cycle, or Root usage aggregates", () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "approved_happy_path");
  const fixture = approvedFixture(definition);
  for (const entry of fixture.evidence.roots[0].managedRecords) {
    if (entry.record.kind === "stage_result" || entry.record.kind === "workflow_timeline") delete entry.markdown;
  }
  const assertion = evaluateForegroundE2EAssertions({ definition, ...fixture })
    .find(({ assertionId }) => assertionId === "turn_usage_aggregated");

  assert.equal(assertion.outcome, "contradicted");
});

function incompleteEvidence(caseId, rootIssueIds) {
  return {
    caseId,
    observedAt: "2026-07-26T00:00:00.000Z",
    rootIssueIds,
    roots: rootIssueIds.map((rootIssueId) => ({
      rootIssueId,
      issues: [],
      comments: [],
      relations: [],
      activity: [],
      managedRecords: [],
    })),
    statusCatalog: [],
    git: [],
    coverage: {
      isComplete: false,
      omissions: [{
        rootIssueId: rootIssueIds[0],
        sourceId: rootIssueIds[0],
        scope: "root",
        code: "foreground_e2e_evidence_linear_read_failed",
      }],
    },
  };
}

function sequencedClock() {
  let tick = 0;
  return () => `2026-07-26T00:00:${String(tick += 1).padStart(2, "0")}.000Z`;
}

function hasCode(code) {
  return (error) => error?.code === code;
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function contradictoryFixture(definition, assertionId, fixtureInput) {
  const value = structuredClone(fixtureInput);
  const { evidence } = value;
  const root = evidence.roots[0];
  switch (assertionId) {
    case "case_scope_isolated":
      evidence.git.pop();
      return value;
    case "requirement_input_preserved":
      root.issues.find(({ id }) => id === root.rootIssueId).description = "Unrelated requirement.";
      return value;
    case "durable_facts_correlated":
      root.managedRecords[0].record.root_issue_id = "foreign-root";
      return value;
    case "final_evidence_complete":
      evidence.statusCatalog = [];
      return value;
    case "no_e2e_control_facts":
      appendRecord(root, structuredClone(findRecord(root, "plan_contract").record));
      recordSource(root, root.managedRecords.at(-1)).authorId = "human";
      return value;
    case "work_before_approval":
      findRecord(root, "stage_execution", (record) => record.stage === "work").record.started_at = at(1);
      return value;
    case "cycle_plan_work_verify_tree_materialized":
      root.issues.find(({ id }) => id === "plan-issue").parentId = root.rootIssueId;
      return value;
    case "duplicate_or_synthetic_completion":
      appendRecord(root, structuredClone(findRecord(root, "delivery").record));
      return value;
    case "usage_missing_or_double_counted":
      appendRecord(root, structuredClone(findRecord(root, "stage_result", (record) => record.stage === "work").record));
      return value;
    case "work_against_rejected_contract":
      appendRecord(root, stageExecution(root.rootIssueId, "old-cycle", "forbidden-work", "forbidden-execution", "work", "old-contract", 50));
      return value;
    case "contract_overwritten_or_history_deleted": {
      const old = findRecord(root, "plan_contract", (record) => record.plan_contract_digest === "old-contract");
      removeSource(root, old.source.id);
      return value;
    }
    case "test_created_replacement":
      recordSource(root, findRecord(root, "plan_contract", (record) => record.plan_contract_digest === "new-contract")).authorId = "human";
      return value;
    case "missing_answer_assumed":
      appendRecord(root, stageExecution(root.rootIssueId, "information-cycle", "assumed-plan", "assumed-execution", "plan", undefined, 1));
      return value;
    case "test_unblocks_or_mutates_stage":
      recordSource(root, findRecord(root, "plan_contract")).authorId = "human";
      return value;
    case "system_comment_treated_as_input": {
      appendHumanComment(root, "system-comment", "System timeline comment", "symphony");
      findRecord(root, "root_directive").record.consumed_input_ids.push("system-comment");
      return value;
    }
    case "thread_history_lost":
      root.comments.find(({ id }) => id === "revision-comment").editedAt = null;
      return value;
    case "undeclared_revision_or_conductor_interpretation":
      findRecord(root, "root_directive").record.consumed_input_ids.push("undeclared-input");
      return value;
    case "root_ownership_and_workspace_isolated":
      findRecord(root, "root_ownership").record.conductor_id = "wrong-conductor";
      return value;
    case "independent_delivery_chains":
      root.managedRecords = root.managedRecords.filter(({ record }) => record.kind !== "human_action_resolution");
      return value;
    case "cross_conductor_stage_overlap":
      separateParallelStageIntervals(evidence.roots);
      return value;
    case "boundary_all_roots_delivered":
      root.issues.find(({ id }) => id === root.rootIssueId).state.name = "Todo";
      return value;
    case "cross_conductor_takeover":
      appendRecord(root, rootOwnership(root.rootIssueId, "wrong-conductor"));
      return value;
    case "shared_workspace_writer": {
      const second = evidence.roots[1];
      findRecord(second, "root_ownership").record.delivery_branch = findRecord(root, "root_ownership").record.delivery_branch;
      return value;
    }
    case "telemetry_substitutes_overlap": {
      const execution = findRecord(root, "stage_execution", (record) => record.stage === "plan").record;
      const result = structuredClone(findRecord(root, "stage_result", (record) => record.stage === "plan").record);
      result.result_id = "unmatched-plan-result";
      result.model_turn.stage_execution_id = "unmatched-plan-execution";
      result.context_digest = execution.context_digest;
      appendRecord(root, result);
      return value;
    }
    case "inflight_stage_completes":
      findRecord(root, "stage_result", (record) => record.result_id === value.context.preemption?.inflightExecutionId).record.outcome_kind = "canceled";
      return value;
    case "inflight_turn_interrupted":
      findRecord(root, "stage_result", (record) => record.result_id === value.context.preemption?.inflightExecutionId).record.outcome_kind = "canceled";
      return value;
    case "latest_ready_root_runs_next": {
      const remaining = evidence.roots.find(({ rootIssueId }) => rootIssueId === value.context.preemption?.remainingRootId);
      findRecord(remaining, "stage_execution", (record) => record.stage === "plan").record.started_at = at(30);
      return value;
    }
    case "higher_priority_roots_run_before_lower_priority_root": {
      const low = evidence.roots.find(({ rootIssueId }) => rootIssueId === value.context.preemption?.lowPriorityRootId);
      findRecord(low, "stage_execution", (record) => record.stage === "plan").record.started_at = at(0);
      return value;
    }
    case "remaining_ready_root_progresses": {
      const remaining = evidence.roots.find(({ rootIssueId }) => rootIssueId === value.context.preemption?.remainingRootId);
      remaining.managedRecords = remaining.managedRecords.filter(({ record }) => record.kind !== "delivery");
      return value;
    }
    case "test_selects_next_root":
      root.activity.push(activity("test-schedule-mutation", root.rootIssueId, "human", 16, { toPriority: 1 }));
      return value;
    case "semantic_requirement_touch": {
      const touched = evidence.roots.find(({ rootIssueId }) => rootIssueId === value.context.preemption?.touchedRootId);
      touched.issues.find(({ id }) => id === touched.rootIssueId).description = "A different business requirement.";
      return value;
    }
    case "late_old_session_success":
      appendRecord(root, stageResult(root.rootIssueId, "cycle-id", "plan-issue", "old-success", "verify", "verify_passed", { session: "old-session", revision: "git-revision", at: 60 }));
      return value;
    case "checkpoint_or_linear_rewrite":
      appendRecord(root, structuredClone(findRecord(root, "plan_contract").record));
      recordSource(root, root.managedRecords.at(-1)).authorId = "human";
      return value;
    case "unaffected_conductor_reconfigured": {
      const continuous = evidence.roots.find(({ rootIssueId }) => rootIssueId === value.context.recovery?.continuousRootId);
      appendRecord(continuous, rootOwnership(continuous.rootIssueId, "replacement-conductor"));
      return value;
    }
    default:
      if (["plan_approval_precedes_work", "stage_chain_delivered", "turn_usage_aggregated", "boundary_in_review_delivery",
        "rejection_consumed_and_replied", "rejected_lineage_retained", "rejected_contract_superseded", "boundary_fresh_plan_review",
        "information_action_actionable", "answer_consumed_and_receipted", "answer_drives_fresh_plan", "ordinary_inputs_consumed_once",
        "thread_transitions_receipted", "revision_supersedes_cycle", "boundary_successor_plan_review",
        "inflight_stage_completes", "latest_ready_root_runs_next", "remaining_ready_root_progresses", "old_execution_terminal_once",
        "recovery_uses_fresh_execution", "ownership_persists", "unaffected_root_continues", "boundary_recovered_and_continuous_delivered"].includes(assertionId)) {
        for (const rootValue of evidence.roots) rootValue.managedRecords = [];
        return value;
      }
      throw new Error(`missing contradictory fixture: ${definition.caseId}.${assertionId}`);
  }
}

function separateParallelStageIntervals(roots) {
  for (const [rootIndex, root] of roots.entries()) {
    const base = rootIndex === 0 ? 1 : 30;
    const executions = root.managedRecords.filter(({ record }) => record.kind === "stage_execution");
    for (const [index, { record: execution }] of executions.entries()) {
      execution.started_at = at(base + index * 2);
      findRecord(root, "stage_result", ({ model_turn }) => model_turn?.stage_execution_id === execution.stage_execution_id)
        .record.completed_at = at(base + index * 2 + 1);
    }
  }
}

function findRecord(root, kind, predicate = () => true) {
  const entry = root.managedRecords.find((candidate) => candidate.record.kind === kind && predicate(candidate.record));
  assert.ok(entry, `${root.rootIssueId}.${kind}`);
  return entry;
}

function recordSource(root, entry) {
  const source = root.comments.find(({ id }) => id === entry.source.id);
  assert.ok(source, entry.source.id);
  return source;
}

function removeSource(root, sourceId) {
  root.comments = root.comments.filter(({ id }) => id !== sourceId);
}

function appendRecord(root, record) {
  const sourceId = `contradiction-${root.managedRecords.length + 1}`;
  root.comments.push({
    id: sourceId, issueId: root.rootIssueId, parentId: null, authorId: "symphony", body: "managed", archivedAt: null,
    createdAt: DATE, updatedAt: DATE, remoteVersion: DATE, editedAt: null, resolvedAt: null, reactions: [], thread: { rootCommentId: sourceId, state: "unresolved" },
  });
  root.managedRecords.push({ issueId: root.rootIssueId, source: { kind: "comment", id: sourceId, remoteVersion: DATE }, record });
}

function appendHumanComment(root, id, body, authorId) {
  root.comments.push({ id, issueId: root.rootIssueId, parentId: null, authorId, body, archivedAt: null, createdAt: DATE, updatedAt: DATE, remoteVersion: DATE, editedAt: null, resolvedAt: null, reactions: [], thread: { rootCommentId: id, state: "unresolved" } });
}

function satisfiedFixture(definition) {
  switch (definition.caseId) {
    case "approved_happy_path": return approvedFixture(definition);
    case "plan_rejected_and_replanned": return rejectedFixture(definition);
    case "information_requested_and_answered": return informationFixture(definition);
    case "root_revision_and_comment": return revisionFixture(definition);
    case "parallel_multi_conductor": return parallelFixture(definition);
    case "same_conductor_preemption": return preemptionFixture(definition);
    case "conductor_restart_recovery": return recoveryFixture(definition);
    default: throw new Error(`unknown fixture: ${definition.caseId}`);
  }
}

function approvedFixture(definition) {
  const root = deliveredRoot(definition, definition.rootTopology[0].rootKey, "approved-root-id");
  return fixture(definition, [root]);
}

function rejectedFixture(definition) {
  const root = rootFacts(definition, "rejected-plan-root", "rejected-root-id", { rootStatus: "Planning" });
  const oldCycle = addIssue(root, "old-cycle", "Changes Required");
  const oldPlan = addIssue(root, "old-plan", "Succeeded");
  const oldAction = addIssue(root, "old-action", "Rejected", { archivedAt: DATE });
  const newCycle = addIssue(root, "new-cycle", "Planning");
  const newPlan = addIssue(root, "new-plan", "Planning");
  const newAction = addIssue(root, "new-action", "Todo");
  addWorkflowIssue(root, oldCycle, "cycle");
  addWorkflowIssue(root, oldPlan, "plan");
  addWorkflowIssue(root, oldAction, "human");
  addWorkflowIssue(root, newCycle, "cycle");
  addWorkflowIssue(root, newPlan, "plan");
  addWorkflowIssue(root, newAction, "human");
  addRecord(root, planContract(root.id, oldCycle, "old-contract"), { archived: true, sourceIssueId: oldPlan });
  addRecord(root, stageExecution(root.id, oldCycle, oldPlan, "plan-old", "plan", undefined, 10), { sourceIssueId: oldPlan });
  addRecord(root, stageResult(root.id, oldCycle, oldPlan, "plan-old", "plan", "plan_completed", { planContract: "old-contract", at: 20 }), { sourceIssueId: oldPlan });
  addRecord(root, humanActionRequest(root.id, "old-action-id", oldAction, "plan_review", oldCycle, [oldPlan]), { sourceIssueId: oldAction });
  addRecord(root, humanActionResolution(root.id, "old-action-id", oldAction, "rejected", "Rejected", ["rejection-reason"]), { sourceIssueId: oldAction });
  addHumanComment(root, "rejection-reason", "The plan should preserve the existing utility contract before adding the new behavior.", { issueId: oldAction });
  addRecord(root, rootDirective(root.id, ["rejection-reason"], 25));
  addRecord(root, reply(root.id, "rejection-reason", { targetIssueId: oldAction }), { sourceIssueId: oldAction });
  addRecord(root, {
    kind: "plan_contract_supersession", version: 1, supersession_id: "supersession-1", root_issue_id: root.id,
    cycle_issue_id: oldCycle, superseded_plan_contract_digest: "old-contract", source_root_directive_id: "directive-1",
    fresh_plan_issue_id: newPlan, superseded_at: at(26),
  });
  addRecord(root, planContract(root.id, newCycle, "new-contract"), { sourceIssueId: newPlan });
  addRecord(root, stageExecution(root.id, newCycle, newPlan, "plan-new", "plan", undefined, 30), { sourceIssueId: newPlan });
  addRecord(root, stageResult(root.id, newCycle, newPlan, "plan-new", "plan", "plan_completed", { planContract: "new-contract", at: 40 }), { sourceIssueId: newPlan });
  addRecord(root, humanActionRequest(root.id, "new-action-id", newAction, "plan_review", newCycle, [newPlan]), { sourceIssueId: newAction });
  return fixture(definition, [root], {
    inputReferences: [{ sourceId: "rejection-reason", kind: "comment_create", binding: "rejection_reason", commentId: "rejection-reason" }],
    rejectedActionIssueId: oldAction,
    replacementActionIssueId: newAction,
  });
}

function informationFixture(definition) {
  const root = rootFacts(definition, "information-root", "information-root-id", { rootStatus: "Planning" });
  const cycle = addIssue(root, "information-cycle", "Planning");
  const plan = addIssue(root, "information-plan", "Planning");
  const clarification = addIssue(root, "information-action", "Answered", {
    description: "## Question\nWhich separator should be used?\n\n## Required\nProvide the separator.\n\n## Submit\nReply on this Action.\n\n## Next\nA fresh Plan Review will be created.",
  });
  const review = addIssue(root, "information-review", "Todo");
  addWorkflowIssue(root, cycle, "cycle");
  addWorkflowIssue(root, plan, "plan");
  addWorkflowIssue(root, clarification, "human");
  addWorkflowIssue(root, review, "human");
  addRecord(root, humanActionRequest(root.id, "clarification-id", clarification, "clarification", cycle), { sourceIssueId: clarification });
  addHumanComment(root, "separator-answer", "Use a colon as the identifier separator.", { issueId: clarification });
  addRecord(root, humanActionResolution(root.id, "clarification-id", clarification, "answered", "Answered", ["separator-answer"]), { sourceIssueId: clarification });
  addRecord(root, rootDirective(root.id, ["separator-answer"], 20));
  addRecord(root, reply(root.id, "separator-answer", { reaction: "check", targetIssueId: clarification }), { sourceIssueId: clarification });
  addRecord(root, planContract(root.id, cycle, "information-contract", { constraints: ["Use a colon separator."] }), { sourceIssueId: plan });
  addRecord(root, stageExecution(root.id, cycle, plan, "information-plan-execution", "plan", undefined, 30), { sourceIssueId: plan });
  addRecord(root, stageResult(root.id, cycle, plan, "information-plan-execution", "plan", "plan_completed", { planContract: "information-contract", at: 40 }), { sourceIssueId: plan });
  addRecord(root, humanActionRequest(root.id, "information-review-id", review, "plan_review", cycle, [plan]));
  return fixture(definition, [root], {
    inputReferences: [{ sourceId: "separator-answer", kind: "comment_create", binding: "separator_answer", commentId: "separator-answer" }],
    answeredActionIssueId: clarification,
    replacementActionIssueId: review,
  });
}

function revisionFixture(definition) {
  const root = rootFacts(definition, "revision-root", "revision-root-id", {
    rootStatus: "Planning",
    description: "Replace the uppercase helper with a lowercase identifier helper and focused tests.\n\n## Acceptance Criteria\n- The initial requirement is planned before the revision.\n- The revised requirement starts a successor Cycle with a fresh Plan review.",
  });
  const oldCycle = addIssue(root, "revision-old-cycle", "Changes Required");
  const newCycle = addIssue(root, "revision-new-cycle", "Planning");
  const oldPlan = addIssue(root, "revision-old-plan", "Planning");
  const oldReview = addIssue(root, "revision-initial-review", "Todo", { archivedAt: DATE });
  const plan = addIssue(root, "revision-successor-plan", "Planning");
  const review = addIssue(root, "revision-successor-review", "Todo");
  const commentId = addHumanComment(root, "revision-comment", "The original helper name no longer matches the revised requirement.", {
    editedAt: DATE,
    reactions: [{ id: "revision-comment-receipt", emoji: "❌", actorId: "symphony", archivedAt: null, createdAt: DATE, updatedAt: DATE, remoteVersion: DATE }],
    thread: { rootCommentId: "revision-comment", state: "unresolved" },
  });
  addWorkflowIssue(root, oldCycle, "cycle");
  addWorkflowIssue(root, newCycle, "cycle");
  addWorkflowIssue(root, oldPlan, "plan");
  addWorkflowIssue(root, plan, "plan");
  addWorkflowIssue(root, oldReview, "human");
  addWorkflowIssue(root, review, "human");
  addRecord(root, planContract(root.id, oldCycle, "revision-old-contract"), { archived: true, sourceIssueId: oldPlan });
  addRecord(root, stageExecution(root.id, oldCycle, oldPlan, "revision-old-plan-execution", "plan", undefined, 5));
  addRecord(root, stageResult(root.id, oldCycle, oldPlan, "revision-old-plan-execution", "plan", "plan_completed", { planContract: "revision-old-contract", at: 6 }));
  addRecord(root, humanActionRequest(root.id, "revision-initial-review-id", oldReview, "plan_review", oldCycle, [oldPlan]));
  addRecord(root, rootDirective(root.id, ["revision-description", "revision-comment-create", "revision-comment-edit", "revision-thread-resolve", "revision-thread-reopen"], 15));
  addRecord(root, reply(root.id, "revision-comment-create", {
    reaction: "check",
    source: { kind: "comment_body", comment_id: commentId, comment_body_digest: "revision-create-digest" },
  }));
  addRecord(root, reply(root.id, "revision-comment-edit", {
    reaction: "cross",
    source: { kind: "comment_body", comment_id: commentId, comment_body_digest: "revision-edit-digest" },
  }));
  addRecord(root, reply(root.id, "revision-thread-resolve", {
    reaction: "none",
    threadAction: "resolve",
    source: { kind: "comment_thread_state", comment_id: commentId, comment_remote_version: at(21), thread_root_comment_id: commentId, thread_state: "resolved" },
  }));
  addRecord(root, reply(root.id, "revision-thread-reopen", {
    reaction: "none",
    threadAction: "reopen", source: { kind: "comment_thread_state", comment_id: commentId, comment_remote_version: at(22), thread_root_comment_id: commentId, thread_state: "unresolved" },
  }));
  addRecord(root, planContract(root.id, newCycle, "revision-new-contract"), { sourceIssueId: plan });
  addRecord(root, stageExecution(root.id, newCycle, plan, "revision-plan-execution", "plan", undefined, 30));
  addRecord(root, stageResult(root.id, newCycle, plan, "revision-plan-execution", "plan", "plan_completed", { planContract: "revision-new-contract", at: 40 }));
  addRecord(root, humanActionRequest(root.id, "revision-review-id", review, "plan_review", newCycle, [plan]));
  return fixture(definition, [root], {
    inputReferences: [
      { sourceId: "revision-description", kind: "description", remoteVersion: at(14) },
      { sourceId: "revision-comment-create", kind: "comment_body", binding: "revision_comment", commentId, commentBodyDigest: "revision-create-digest", remoteVersion: at(16) },
      { sourceId: "revision-comment-edit", kind: "comment_body", commentId, commentBodyDigest: "revision-edit-digest", remoteVersion: at(17) },
      { sourceId: "revision-thread-resolve", kind: "comment_thread_state", commentId, threadRootCommentId: commentId, expectedThreadState: "resolved", remoteVersion: at(21) },
      { sourceId: "revision-thread-reopen", kind: "comment_thread_state", commentId, threadRootCommentId: commentId, expectedThreadState: "unresolved", remoteVersion: at(22) },
    ],
    initialPlan: {
      cycleIssueId: oldCycle,
      planIssueId: oldPlan,
      planContractDigest: "revision-old-contract",
      planContractSourceCommentId: "record-7",
      planReviewActionIssueId: oldReview,
    },
    successorPlan: {
      cycleIssueId: newCycle,
      planIssueId: plan,
      planContractDigest: "revision-new-contract",
      planContractSourceCommentId: "record-16",
      planReviewActionIssueId: review,
    },
  });
}

function parallelFixture(definition) {
  const roots = definition.rootTopology.map(({ rootKey }, index) => deliveredRoot(definition, rootKey, `parallel-root-${index + 1}`, {
    conductorId: `conductor-${index + 1}`,
    started: 10 + index,
    completed: 50 + index,
  }));
  const value = fixture(definition, roots);
  bindParallelContext(value, definition);
  return value;
}

function bindParallelContext(value, definition) {
  value.context.parallel = {
    roots: definition.rootTopology.map((topology, index) => {
      const root = value.evidence.roots[index];
      const ownership = findRecord(root, "root_ownership").record;
      const git = value.evidence.git.find(({ rootIssueId }) => rootIssueId === root.rootIssueId);
      root.issues.find(({ id }) => id === root.rootIssueId).labels = [{ id: `route-${index + 1}` }];
      return {
        rootKey: topology.rootKey,
        conductorRef: topology.conductorRef,
        repositoryRef: topology.repositoryRef,
        rootIssueId: root.rootIssueId,
        planReviewActionIssueId: `plan-review-${root.rootIssueId}`,
        routingLabelId: `route-${index + 1}`,
        conductorId: ownership.conductor_id,
        performerProfileId: ownership.performer_profile_id,
        repositoryRoot: git.repositoryRootCanonical,
      };
    }),
  };
}

function preemptionFixture(definition) {
  const byKey = Object.fromEntries(definition.rootTopology.map(({ rootKey }, index) => [rootKey, `preemption-root-${index + 1}`]));
  const roots = definition.rootTopology.map(({ rootKey }) => deliveredRoot(definition, rootKey, byKey[rootKey], {
    conductorId: "shared-conductor",
    started: rootKey === "inflight-root" ? 1 : rootKey === "remaining-root" ? 30 : rootKey === "touched-root" ? 60 : 90,
    completed: rootKey === "inflight-root" ? 20 : rootKey === "remaining-root" ? 50 : rootKey === "touched-root" ? 80 : 110,
    rootUpdatedAt: at(rootKey === "remaining-root" ? 25 : rootKey === "touched-root" ? 24 : rootKey === "inflight-root" ? 22 : 21),
  }));
  const inflight = roots.find(({ id }) => id === byKey["inflight-root"]);
  const touched = roots.find(({ id }) => id === byKey["remaining-root"]);
  const remaining = roots.find(({ id }) => id === byKey["touched-root"]);
  findRecord(inflight, "stage_result", (record) => record.stage === "plan").record.completed_at = at(20);
  findRecord(inflight, "stage_execution", (record) => record.stage === "work").record.started_at = at(21);
  findRecord(inflight, "stage_result", (record) => record.stage === "work").record.completed_at = at(22);
  findRecord(inflight, "stage_execution", (record) => record.stage === "verify").record.started_at = at(23);
  findRecord(inflight, "stage_result", (record) => record.stage === "verify").record.completed_at = at(24);
  const touchDescription = definition.declaredUserInteractions.find(({ kind }) => kind === "touch_bound_root_description").descriptionsByRootKey["remaining-root"];
  touched.issues.find(({ id }) => id === touched.id).description = touchDescription;
  touched.activity.push(activity("touch-activity", touched.id, "human", 15, { updatedDescription: true }));
  remaining.activity.push(activity("remaining-ready-activity", remaining.id, "human", 14));
  return fixture(definition, roots, {
    preemption: {
      inflightRootId: inflight.id,
      touchedRootId: touched.id,
      remainingRootId: remaining.id,
      inflightExecutionId: "plan-execution",
      touchedExecutionId: "plan-execution",
      touchedRootKey: "remaining-root",
      touchActivityId: "touch-activity",
      conductorId: "shared-conductor",
      lowPriorityRootId: byKey["low-priority-root"],
    },
  });
}

function recoveryFixture(definition) {
  const affected = deliveredRoot(definition, "affected-root", "affected-root-id", { conductorId: "affected-conductor" });
  const continuous = deliveredRoot(definition, "continuous-root", "continuous-root-id", { conductorId: "continuous-conductor" });
  affected.issues.find(({ id }) => id === affected.id).labels = [{ id: "affected-route" }];
  continuous.issues.find(({ id }) => id === continuous.id).labels = [{ id: "continuous-route" }];
  addRecord(affected, stageResult(affected.id, "cycle-id", "plan-issue", "old-execution", "plan", "execution_failed", {
    session: "old-session", at: 5,
  }));
  return fixture(definition, [affected, continuous], {
    recovery: {
      affectedRootId: affected.id,
      continuousRootId: continuous.id,
      oldExecutionId: "old-execution",
      affectedConductorId: "affected-conductor",
      continuousConductorId: "continuous-conductor",
      affectedRoutingLabelId: "affected-route",
      continuousRoutingLabelId: "continuous-route",
      affectedPerformerProfileId: "affected-conductor-profile",
      continuousPerformerProfileId: "continuous-conductor-profile",
      affectedRepositoryRoot: `/repository/${affected.id}`,
      continuousRepositoryRoot: `/repository/${continuous.id}`,
    },
  });
}

function deliveredRoot(definition, rootKey, rootId, {
  conductorId = "conductor-1",
  started = 10,
  completed = 50,
  rootUpdatedAt = at(50),
} = {}) {
  const root = rootFacts(definition, rootKey, rootId, { rootStatus: "In Review", rootUpdatedAt });
  const cycle = addIssue(root, "cycle-id", "Succeeded");
  const plan = addIssue(root, "plan-issue", "Succeeded", { parentId: cycle, depth: 2 });
  const work = addIssue(root, "work-issue", "Succeeded", { parentId: cycle, depth: 2 });
  const verify = addIssue(root, "verify-issue", "Succeeded", { parentId: cycle, depth: 2 });
  const action = addIssue(root, `plan-review-${rootId}`, "Approved", { parentId: cycle, depth: 2 });
  addWorkflowIssue(root, cycle, "cycle");
  addWorkflowIssue(root, plan, "plan", cycle);
  addWorkflowIssue(root, work, "work", cycle);
  addWorkflowIssue(root, verify, "verify", cycle);
  addWorkflowIssue(root, action, "human", cycle);
  addRecord(root, rootOwnership(root.id, conductorId));
  addRecord(root, rootDirective(root.id, [], 5));
  addRecord(root, planContract(root.id, cycle, "contract-id"), { sourceIssueId: plan });
  addRecord(root, stageExecution(root.id, cycle, plan, "plan-execution", "plan", undefined, started));
  addRecord(root, stageResult(root.id, cycle, plan, "plan-execution", "plan", "plan_completed", { planContract: "contract-id", at: started + 1 }), { sourceIssueId: plan });
  addRecord(root, humanActionRequest(root.id, "plan-action", action, "plan_review", cycle, [plan]));
  addRecord(root, humanActionResolution(root.id, "plan-action", action, "approved", "Approved", []));
  addRecord(root, stageExecution(root.id, cycle, work, "work-execution", "work", "contract-id", started + 2));
  addRecord(root, stageResult(root.id, cycle, work, "work-execution", "work", "work_completed", { planContract: "contract-id", at: completed - 3 }), { sourceIssueId: work });
  addRecord(root, stageExecution(root.id, cycle, verify, "verify-execution", "verify", "contract-id", completed - 2));
  addRecord(root, stageResult(root.id, cycle, verify, "verify-execution", "verify", "verify_passed", { planContract: "contract-id", revision: "git-revision", at: completed }), { sourceIssueId: verify });
  addRecord(root, verifyResult(root.id, cycle, verify, "verify-execution"));
  addRecord(root, delivery(root.id, cycle, "verify-execution", "git-revision"));
  addRecord(root, cycleOutcome(root.id, cycle, 30));
  addRecord(root, workflowTimeline(root.id, cycle, "cycle"), {
    sourceIssueId: cycle,
    markdown: "Usage\n- Cycle cumulative (complete): Plan · gpt-5 · 10 tokens; Work · gpt-5 · 10 tokens; Verify · gpt-5 · 10 tokens",
  });
  addRecord(root, workflowTimeline(root.id, root.id, "root"), {
    markdown: "Usage\n- Root cumulative (complete): Root Reconciler · gpt-5 · 10 tokens; Plan · gpt-5 · 10 tokens; Work · gpt-5 · 10 tokens; Verify · gpt-5 · 10 tokens",
  });
  return root;
}

function rootFacts(definition, rootKey, id, {
  rootStatus = "In Review",
  description,
  rootUpdatedAt = at(50),
} = {}) {
  const input = definition.rootCreationInputs.find((candidate) => candidate.rootKey === rootKey);
  const root = {
    id,
    rootIssueId: id,
    issues: [issue(id, id, rootStatus, {
      depth: 0,
      description: description ?? input.description,
      priority: linearPriority(input.priority),
      updatedAt: rootUpdatedAt,
    })],
    comments: [], relations: [], activity: [], managedRecords: [],
  };
  return root;
}

function fixture(definition, roots, extraContext = {}) {
  const rootIssueIds = roots.map(({ id }) => id);
  return {
    context: {
      humanActorId: "human",
      rootIssueIdsByKey: Object.fromEntries(definition.rootTopology.map(({ rootKey }, index) => [rootKey, rootIssueIds[index]])),
      ...extraContext,
    },
    evidence: {
      caseId: definition.caseId,
      observedAt: DATE,
      rootIssueIds,
      roots: roots.map(({ id, ...root }) => ({ rootIssueId: id, ...root })),
      statusCatalog: [{ id: "status-review", name: "In Review", type: "started", position: 1, archivedAt: null, createdAt: DATE, updatedAt: DATE, remoteVersion: DATE }],
      git: rootIssueIds.map((rootIssueId) => ({ rootIssueId, repositoryRoot: `/repository/${rootIssueId}`, repositoryRootCanonical: `/repository/${rootIssueId}`, branch: "main", headRevision: "git-revision", status: "", headChangedPaths: ["src/helper.ts"] })),
      coverage: { isComplete: true, omissions: [] },
    },
  };
}

function addIssue(root, id, stateName, options = {}) {
  root.issues.push(issue(id, root.id, stateName, { depth: 1, parentId: root.id, ...options }));
  return id;
}

function addWorkflowIssue(root, issueKey, issueKind, parentIssueId = root.id) {
  addRecord(root, { kind: "workflow_issue", version: 1, issue_key: issueKey, root_issue_id: root.id, parent_issue_id: parentIssueId, issue_kind: issueKind });
}

function addHumanComment(root, id, body, options = {}) {
  root.comments.push({
    id, issueId: options.issueId ?? root.id, parentId: null, authorId: "human", body, archivedAt: null,
    createdAt: DATE, updatedAt: options.updatedAt ?? DATE, remoteVersion: options.remoteVersion ?? DATE,
    editedAt: options.editedAt ?? null, resolvedAt: null, reactions: options.reactions ?? [], thread: options.thread ?? { rootCommentId: id, state: "unresolved" },
  });
  return id;
}

function addRecord(root, record, { archived = false, sourceIssueId = root.id, markdown = undefined } = {}) {
  const sourceId = `record-${root.managedRecords.length + 1}`;
  root.comments.push({
    id: sourceId, issueId: sourceIssueId, parentId: null, authorId: "symphony", body: "managed", archivedAt: archived ? DATE : null,
    createdAt: DATE, updatedAt: DATE, remoteVersion: DATE, editedAt: null, resolvedAt: null, reactions: [], thread: { rootCommentId: sourceId, state: "unresolved" },
  });
  root.managedRecords.push({
    issueId: sourceIssueId,
    source: { kind: "comment", id: sourceId, remoteVersion: DATE },
    ...(markdown === undefined && record.kind === "stage_result" ? { markdown: stageUsageMarkdown(record) } : markdown === undefined ? {} : { markdown }),
    record,
  });
}

function issue(id, rootIssueId, stateName, { depth, parentId = depth === 0 ? null : rootIssueId, description = "", archivedAt = null, updatedAt = DATE, priority = 2 } = {}) {
  return { id, identifier: id, rootIssueId, parentId, projectId: "project", teamId: "team", creatorId: depth === 0 ? "human" : "symphony", title: id, description, priority, state: { id: `state-${stateName}`, name: stateName, type: "started" }, archivedAt, createdAt: DATE, updatedAt, remoteVersion: updatedAt, depth };
}

function linearPriority(priority) {
  return {
    no_priority: 0,
    urgent: 1,
    high: 2,
    normal: 3,
    low: 4,
  }[priority];
}

function rootOwnership(rootIssueId, conductorId) {
  return { kind: "root_ownership", version: 1, root_issue_id: rootIssueId, conductor_id: conductorId, performer_profile_id: `${conductorId}-profile`, delivery_branch: `branch-${conductorId}-${rootIssueId}`, owner_generation: "generation" };
}

function rootDirective(rootIssueId, consumedInputIds, moment) {
  return {
    kind: "root_directive", version: 1, root_directive_id: `directive-${moment}`, root_issue_id: rootIssueId, reconciler_session_id: "root-session", reconciler_turn_id: `root-turn-${moment}`,
    based_on_target_root_digest: "digest", consumed_input_ids: consumedInputIds, directive: { kind: "acknowledge" }, accepted_at: at(moment),
    model_turn: modelTurn(rootIssueId, "root_reconciler", `root-turn-record-${moment}`, moment),
  };
}

function planContract(rootIssueId, cycleIssueId, digest, { constraints = [] } = {}) {
  return { kind: "plan_contract", version: 1, root_issue_id: rootIssueId, cycle_issue_id: cycleIssueId, plan_contract_digest: digest, objective: "Objective", included_scope: ["scope"], excluded_scope: [], assumptions: [], constraints, acceptance_criteria: [], verification_requirements: [], proposed_work_dag: { work_nodes: [], dependency_edges: [], verify_node: {} } };
}

function stageExecution(rootIssueId, cycleIssueId, nodeIssueId, executionId, stage, planContractDigest, moment) {
  return { kind: "stage_execution", version: 1, stage_execution_id: executionId, root_issue_id: rootIssueId, cycle_issue_id: cycleIssueId, node_issue_id: nodeIssueId, stage, ...(planContractDigest ? { plan_contract_digest: planContractDigest } : {}), context_digest: `context-${executionId}`, source_manifest: [], coverage: { is_complete: true, omissions: [] }, instruction_set_id: "instruction", execution_policy_id: "policy", limits: {}, repository_revision: "git-base", started_at: at(moment), deadline_at: at(moment + 100) };
}

function stageResult(rootIssueId, cycleIssueId, nodeIssueId, executionId, stage, outcome, { planContract, revision, session = `${stage}-session`, at: moment } = {}) {
  return { kind: "stage_result", version: 1, result_id: executionId, root_issue_id: rootIssueId, cycle_issue_id: cycleIssueId, node_issue_id: nodeIssueId, stage, role_session_id: session, role_turn_id: `${executionId}-turn`, observed_tree_digest: "tree", context_digest: `context-${executionId}`, outcome_kind: outcome, summary: "result", source_manifest: [], completed_at: at(moment), model_turn: modelTurn(rootIssueId, stage, `${executionId}-turn-record`, moment, { cycleIssueId, nodeIssueId, executionId, outcome, session }), ...(planContract ? { plan_contract_digest: planContract } : {}), ...(stage === "plan" && planContract ? { plan_contract: {}, proposed_work_dag: {} } : {}), ...(stage === "verify" && revision ? { verify_conclusion: "passed", verified_revision: revision } : {}) };
}

function modelTurn(rootIssueId, role, turnRecordId, moment, { cycleIssueId = undefined, nodeIssueId = undefined, executionId = undefined, outcome = "directive_accepted", session = "root-session" } = {}) {
  return { turn_record_id: turnRecordId, role, root_issue_id: rootIssueId, ...(cycleIssueId ? { cycle_issue_id: cycleIssueId, target_issue_id: nodeIssueId, stage_execution_id: executionId, role_session_id: session, role_turn_id: `${turnRecordId}-role` } : { reconciler_session_id: session, reconciler_turn_id: `${turnRecordId}-role` }), invocation_state: "confirmed", model: "gpt-5", outcome, usage: { status: "measured", input_tokens: 5, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 10 }, terminal_at: at(moment) };
}

function humanActionRequest(rootIssueId, actionId, actionIssueId, actionKind, cycleIssueId, relatedIssueIds = []) {
  return { kind: "human_action_request", version: 1, action_id: actionId, action_issue_id: actionIssueId, action_kind: actionKind, parent_scope: "cycle", root_issue_id: rootIssueId, cycle_issue_id: cycleIssueId, related_issue_ids: relatedIssueIds, proposal_digest: "proposal", expected_parent_remote_version: DATE, created_at: DATE };
}

function humanActionResolution(rootIssueId, actionId, actionIssueId, outcome, terminalStatus, sourceCommentIds, moment = 11) {
  return { kind: "human_action_resolution", version: 1, resolution_id: `${actionId}-resolution`, root_issue_id: rootIssueId, action_id: actionId, action_issue_id: actionIssueId, action_kind: actionId.includes("clarification") ? "clarification" : "plan_review", outcome, terminal_status: terminalStatus, terminal_remote_version: DATE, source_comment_ids: sourceCommentIds, source_comment_versions: sourceCommentIds.map(() => DATE), actor_kind: "human", proposal_digest: "proposal", resolved_at: at(moment) };
}

function reply(rootIssueId, sourceInputId, { reaction = "check", threadAction = "keep_open", targetIssueId = rootIssueId, source = { kind: "comment_body", comment_id: sourceInputId, comment_body_digest: "digest" } } = {}) {
  return { kind: "root_reconciler_reply", version: 1, reply_id: `reply-${sourceInputId}`, reply_write_id: `write-${sourceInputId}`, root_directive_id: "directive-1", source_input_id: sourceInputId, source, target_issue_id: targetIssueId, disposition: "accepted", reaction, thread_action: threadAction, materialized_outcome_refs: [], rendered_schema_version: "1", replied_at: DATE };
}

function verifyResult(rootIssueId, cycleIssueId, nodeIssueId, stageExecutionId) {
  return { kind: "verify_result", version: 1, stage_execution_id: stageExecutionId, root_issue_id: rootIssueId, cycle_issue_id: cycleIssueId, node_issue_id: nodeIssueId, conclusion: "passed", criteria_results: [], checks: [], verified_revision: "git-revision" };
}

function delivery(rootIssueId, cycleIssueId, verifyResultId, revision) {
  return { kind: "delivery", version: 1, root_issue_id: rootIssueId, cycle_issue_id: cycleIssueId, verify_result_id: verifyResultId, verified_revision: revision, delivery_kind: "local_branch", delivery_branch: `delivery-${rootIssueId}`, delivered_at: DATE };
}

function cycleOutcome(rootIssueId, cycleIssueId, totalTokens) {
  return { kind: "cycle_outcome", version: 1, cycle_outcome_id: `outcome-${cycleIssueId}`, root_issue_id: rootIssueId, cycle_issue_id: cycleIssueId, source_root_directive_id: "directive-1", conclusion: "succeeded", completed_work_ids: [], unresolved_finding_ids: [], attempted_approach_refs: [], verification_evidence_refs: [], git_revision: "git-revision", budget_usage: { scope: "cycle", source_record_count: 3, source_digest: "digest", is_complete: true, unknown_turn_count: 0, groups: ["plan", "work", "verify"].map((role) => ({ cycle_issue_id: cycleIssueId, role, model: "gpt-5", input_tokens: 5, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: totalTokens / 3, unavailable_turn_count: 0 })) }, concluded_at: DATE };
}

function workflowTimeline(rootIssueId, targetIssueId, timelineKind) {
  return { kind: "workflow_timeline", version: 1, timeline_event_id: `${timelineKind}-${targetIssueId}-timeline`, timeline_kind: timelineKind, root_issue_id: rootIssueId, target_issue_id: targetIssueId, source_record_ids: ["source-record"], source_versions: [DATE], write_id: `${timelineKind}-${targetIssueId}-timeline`, rendered_schema_version: "1", occurred_at: DATE };
}

function stageUsageMarkdown(record) {
  return `**Usage**\n- Model: \`${record.model_turn.model}\`\n- This turn: ${record.model_turn.usage.total_tokens} tokens\n- This Issue:`;
}

function activity(id, issueId, actorId, moment, extra = {}) {
  return { id, issueId, actorId, createdAt: at(moment), updatedAt: at(moment), remoteVersion: at(moment), archived: false, fromStateId: null, toStateId: null, fromPriority: null, toPriority: null, updatedDescription: false, ...extra };
}

function at(seconds) { return new Date(Date.parse("2026-07-26T00:00:00.000Z") + seconds * 1_000).toISOString(); }

const DATE = at(0);
