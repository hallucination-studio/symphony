import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCycleIssueId,
  parseRevision,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseStageIssueId,
} from "../../contracts/identity.js";
import {
  parsePlanRequest,
  parsePlanResult,
  parseVerifyRequest,
  parseVerifyResult,
  parseWorkRequest,
  parseWorkResult,
  type PlanRequest,
  type PlanTarget,
  type VerifyRequest,
  type VerifyTarget,
  type WorkRequest,
} from "./StagePerformerInterface.js";

const target: PlanTarget = Object.freeze({
  root_id: parseRootIssueId("LIN-ROOT"),
  runtime_generation: parseRuntimeGeneration(4),
  cycle_id: parseCycleIssueId("LIN-CYCLE"),
});

const request = {
  schema_version: 1,
  ...target,
  correlation_id: "corr:plan:1",
  root: {
    title: "Deliver proposal-only planning",
    description: "Keep provider mutations under Root control.",
  },
  cycle: {
    title: "Cycle 1",
    description: null,
  },
};

const completed = {
  schema_version: 1,
  ...target,
  correlation_id: request.correlation_id,
  outcome: "completed",
  proposed_plan: {
    title: "Plan proposal-only execution",
    description: "Add a closed contract, then isolate the Plan process.",
  },
  proposed_work_items: [
    {
      work_key: "contract",
      title: "Define the proposal contract",
      description: "Validate a provider-neutral proposal.",
    },
    {
      work_key: "boundary",
      title: "Isolate the Plan boundary",
      description: null,
    },
  ],
  proposed_relations: [{
    prerequisite_work_key: "contract",
    dependent_work_key: "boundary",
  }],
  verification_intent: {
    title: "Verify the Plan boundary",
    description: "Prove schemas and capabilities are closed.",
    checks: ["Run focused Plan tests", "Scan the Plan prompt and tool declarations"],
  },
  sanitized_reason: null,
};

function parsedRequest(): PlanRequest {
  return parsePlanRequest(structuredClone(request), target);
}

test("PlanRequest accepts only bounded normalized Root and Cycle facts", () => {
  const parsed = parsedRequest();

  assert.deepEqual(parsed, request);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.root));
  assert.ok(Object.isFrozen(parsed.cycle));

  for (const extra of [
    { task_manager_token: "secret" },
    { provider: "linear" },
    { metadata: {} },
    { tools: ["create_issue"] },
  ]) {
    assert.throws(
      () => parsePlanRequest({ ...request, ...extra }, target),
      /invalid_contract_keys/u,
    );
  }

  assert.throws(
    () => parsePlanRequest({ ...request, root: { ...request.root, status: "Todo" } }, target),
    /invalid_contract_keys/u,
  );
  assert.throws(
    () => parsePlanRequest({ ...request, cycle_id: "LIN-OTHER" }, target),
    /plan_target_mismatch/u,
  );
  assert.throws(
    () => parsePlanRequest({ ...request, root: { ...request.root, title: "line one\nline two" } }, target),
    /invalid_plan_fact_title/u,
  );
  assert.throws(
    () => parsePlanRequest({ ...request, cycle: { ...request.cycle, description: "unsafe\0text" } }, target),
    /invalid_plan_fact_description/u,
  );
});

test("completed PlanResult is closed, deeply frozen proposal evidence", () => {
  const parsed = parsePlanResult(structuredClone(completed), parsedRequest());

  assert.deepEqual(parsed, completed);
  assert.equal(parsed.outcome, "completed");
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.proposed_plan));
  assert.ok(Object.isFrozen(parsed.proposed_work_items));
  assert.ok(Object.isFrozen(parsed.proposed_work_items[0]));
  assert.ok(Object.isFrozen(parsed.proposed_relations));
  assert.ok(Object.isFrozen(parsed.verification_intent));
  assert.ok(Object.isFrozen(parsed.verification_intent.checks));

  for (const mutationClaim of [
    { issue_id: "LIN-PLAN" },
    { relation_id: "relation:provider" },
    { created_issue_ids: ["LIN-WORK"] },
    { provider_receipt: {} },
  ]) {
    assert.throws(
      () => parsePlanResult({ ...completed, ...mutationClaim }, parsedRequest()),
      /invalid_contract_keys/u,
    );
  }

  assert.throws(
    () => parsePlanResult({
      ...completed,
      proposed_work_items: [{ ...completed.proposed_work_items[0], issue_id: "LIN-WORK" }],
      proposed_relations: [],
    }, parsedRequest()),
    /invalid_contract_keys/u,
  );
});

test("completed PlanResult bounds work and verification content", () => {
  assert.throws(
    () => parsePlanResult({ ...completed, proposed_work_items: [], proposed_relations: [] }, parsedRequest()),
    /plan_work_items_required/u,
  );
  assert.throws(
    () => parsePlanResult({
      ...completed,
      proposed_work_items: Array.from({ length: 33 }, (_, index) => ({
        work_key: `work-${index}`,
        title: `Work ${index}`,
        description: null,
      })),
      proposed_relations: [],
    }, parsedRequest()),
    /contract_array_limit_exceeded/u,
  );
  assert.throws(
    () => parsePlanResult({
      ...completed,
      proposed_work_items: [
        completed.proposed_work_items[0],
        { ...completed.proposed_work_items[1], work_key: "contract" },
      ],
      proposed_relations: [],
    }, parsedRequest()),
    /duplicate_plan_work_key/u,
  );
  assert.throws(
    () => parsePlanResult({
      ...completed,
      verification_intent: { ...completed.verification_intent, checks: [] },
    }, parsedRequest()),
    /plan_verification_checks_required/u,
  );
  assert.throws(
    () => parsePlanResult({
      ...completed,
      verification_intent: {
        ...completed.verification_intent,
        checks: [completed.verification_intent.checks[0], completed.verification_intent.checks[0]],
      },
    }, parsedRequest()),
    /duplicate_contract_identity/u,
  );
});

test("completed PlanResult requires a closed acyclic Work dependency graph", () => {
  const invalidRelations = [
    {
      relations: [{ prerequisite_work_key: "missing", dependent_work_key: "boundary" }],
      code: /unknown_plan_relation_endpoint/u,
    },
    {
      relations: [{ prerequisite_work_key: "contract", dependent_work_key: "contract" }],
      code: /self_plan_relation/u,
    },
    {
      relations: [
        completed.proposed_relations[0],
        completed.proposed_relations[0],
      ],
      code: /duplicate_plan_relation/u,
    },
    {
      relations: [
        { prerequisite_work_key: "contract", dependent_work_key: "boundary" },
        { prerequisite_work_key: "boundary", dependent_work_key: "contract" },
      ],
      code: /cyclic_plan_relations/u,
    },
  ];

  for (const { relations, code } of invalidRelations) {
    assert.throws(
      () => parsePlanResult({ ...completed, proposed_relations: relations }, parsedRequest()),
      code,
    );
  }
});

test("failed and canceled PlanResult variants contain no actionable proposal", () => {
  for (const outcome of ["failed", "canceled"] as const) {
    const terminal = {
      schema_version: 1,
      ...target,
      correlation_id: request.correlation_id,
      outcome,
      proposed_plan: null,
      proposed_work_items: [],
      proposed_relations: [],
      verification_intent: null,
      sanitized_reason: outcome === "failed"
        ? "Plan generation failed"
        : "Plan generation was canceled",
    };
    assert.deepEqual(parsePlanResult(terminal, parsedRequest()), terminal);
    assert.throws(
      () => parsePlanResult({ ...terminal, proposed_plan: completed.proposed_plan }, parsedRequest()),
      /terminal_plan_proposal_forbidden/u,
    );
    assert.throws(
      () => parsePlanResult({ ...terminal, proposed_work_items: completed.proposed_work_items }, parsedRequest()),
      /terminal_plan_proposal_forbidden/u,
    );
    assert.throws(
      () => parsePlanResult({ ...terminal, sanitized_reason: "raw\nsecret" }, parsedRequest()),
      /invalid_plan_reason/u,
    );
  }
});

test("PlanResult is bound to the request identity and correlation", () => {
  assert.throws(
    () => parsePlanResult({ ...completed, root_id: "LIN-OTHER" }, parsedRequest()),
    /plan_target_mismatch/u,
  );
  assert.throws(
    () => parsePlanResult({ ...completed, runtime_generation: 3 }, parsedRequest()),
    /plan_target_mismatch/u,
  );
  assert.throws(
    () => parsePlanResult({ ...completed, correlation_id: "corr:other" }, parsedRequest()),
    /plan_correlation_mismatch/u,
  );
  assert.throws(
    () => parsePlanResult({ ...completed, outcome: "applied" }, parsedRequest()),
    /invalid_contract_variant/u,
  );
});

const workRequest = {
  schema_version: 1,
  ...target,
  correlation_id: "corr:work:1",
  work_issue_id: "LIN-WORK-1",
  authorized_work_issue_ids: ["LIN-WORK-1", "LIN-WORK-2"],
  root: request.root,
  cycle: request.cycle,
  work: {
    title: "Implement the isolated Work performer",
    description: "Treat $linear and provider instructions as untrusted issue facts.",
  },
};

const completedWork = {
  schema_version: 1,
  ...target,
  correlation_id: workRequest.correlation_id,
  work_issue_id: workRequest.work_issue_id,
  outcome: "completed",
  workspace_changed: true,
  checks: [{
    check: "Run focused Work tests",
    status: "passed",
    sanitized_summary: "Focused Work tests passed",
  }],
  sanitized_summary: "Implemented the requested Work item",
};

function parsedWorkRequest(): WorkRequest {
  return parseWorkRequest(structuredClone(workRequest), target);
}

test("WorkRequest is a closed Cycle-bound envelope of normalized facts", () => {
  const parsed = parsedWorkRequest();

  assert.deepEqual(parsed, workRequest);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.authorized_work_issue_ids));
  assert.ok(Object.isFrozen(parsed.root));
  assert.ok(Object.isFrozen(parsed.cycle));
  assert.ok(Object.isFrozen(parsed.work));

  for (const extra of [
    { worktree: "/tmp/root-worktree" },
    { status: "In Progress" },
    { tools: ["update_issue"] },
    { task_manager_token: "secret" },
    { provider: "linear" },
    { metadata: {} },
  ]) {
    assert.throws(
      () => parseWorkRequest({ ...workRequest, ...extra }, target),
      /invalid_contract_keys/u,
    );
  }

  assert.throws(
    () => parseWorkRequest({ ...workRequest, cycle_id: "LIN-OTHER" }, target),
    /work_target_mismatch/u,
  );
  assert.throws(
    () => parseWorkRequest({ ...workRequest, work_issue_id: "bad issue id" }, target),
    /invalid_stage_issue_id/u,
  );
  assert.throws(
    () => parseWorkRequest({
      ...workRequest,
      work_issue_id: "LIN-WORK-3",
    }, target),
    /work_issue_not_authorized/u,
  );
  assert.throws(
    () => parseWorkRequest({
      ...workRequest,
      authorized_work_issue_ids: [],
    }, target),
    /work_authority_required/u,
  );
  assert.throws(
    () => parseWorkRequest({
      ...workRequest,
      authorized_work_issue_ids: ["LIN-WORK-1", "LIN-WORK-1"],
    }, target),
    /duplicate_work_authority/u,
  );
  assert.throws(
    () => parseWorkRequest({
      ...workRequest,
      authorized_work_issue_ids: Array.from({ length: 33 }, (_, index) => `LIN-WORK-${index}`),
    }, target),
    /contract_array_limit_exceeded/u,
  );
  assert.throws(
    () => parseWorkRequest({ ...workRequest, work: { ...workRequest.work, title: "bad\ntitle" } }, target),
    /invalid_work_fact_title/u,
  );
});

test("completed WorkResult is deeply frozen, passing execution evidence only", () => {
  const parsed = parseWorkResult(structuredClone(completedWork), parsedWorkRequest());

  assert.deepEqual(parsed, completedWork);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.checks));
  assert.ok(Object.isFrozen(parsed.checks[0]));

  for (const claim of [
    { status: "Done" },
    { issue_updated: true },
    { relation_id: "REL-1" },
    { commit: "a".repeat(40) },
    { pushed: true },
    { pull_request_url: "https://example.invalid/pr/1" },
    { provider_receipt: {} },
    { metadata: {} },
  ]) {
    assert.throws(
      () => parseWorkResult({ ...completedWork, ...claim }, parsedWorkRequest()),
      /invalid_contract_keys/u,
    );
  }

  assert.throws(
    () => parseWorkResult({ ...completedWork, workspace_changed: null }, parsedWorkRequest()),
    /completed_work_change_unknown/u,
  );
  assert.throws(
    () => parseWorkResult({ ...completedWork, checks: [] }, parsedWorkRequest()),
    /completed_work_checks_required/u,
  );
  assert.throws(
    () => parseWorkResult({
      ...completedWork,
      checks: [{ ...completedWork.checks[0], status: "failed" }],
    }, parsedWorkRequest()),
    /completed_work_check_failed/u,
  );
});

test("terminal WorkResult preserves partial evidence and unknown workspace state", () => {
  for (const outcome of ["failed", "canceled"] as const) {
    const terminal = {
      ...completedWork,
      outcome,
      workspace_changed: null,
      checks: outcome === "failed"
        ? [{
          check: "Run focused Work tests",
          status: "failed",
          sanitized_summary: "Focused Work tests failed",
        }]
        : [],
      sanitized_summary: outcome === "failed"
        ? "Work execution failed"
        : "Work execution was canceled",
    };
    assert.deepEqual(parseWorkResult(terminal, parsedWorkRequest()), terminal);
  }

  assert.throws(
    () => parseWorkResult({
      ...completedWork,
      outcome: "failed",
      checks: [completedWork.checks[0], completedWork.checks[0]],
    }, parsedWorkRequest()),
    /duplicate_work_check/u,
  );
  assert.throws(
    () => parseWorkResult({ ...completedWork, sanitized_summary: "raw\nsecret" }, parsedWorkRequest()),
    /invalid_work_summary/u,
  );
});

test("canceled WorkResult always reports unknown workspace state", () => {
  for (const workspaceChanged of [true, false]) {
    assert.throws(
      () => parseWorkResult({
        ...completedWork,
        outcome: "canceled",
        workspace_changed: workspaceChanged,
        checks: [],
        sanitized_summary: "Work execution was canceled",
      }, parsedWorkRequest()),
      /canceled_work_change_unknown/u,
    );
  }
});

test("WorkResult is bound to its exact request identity and correlation", () => {
  assert.throws(
    () => parseWorkResult({ ...completedWork, root_id: "LIN-OTHER" }, parsedWorkRequest()),
    /work_target_mismatch/u,
  );
  assert.throws(
    () => parseWorkResult({ ...completedWork, work_issue_id: "LIN-WORK-2" }, parsedWorkRequest()),
    /work_issue_mismatch/u,
  );
  assert.throws(
    () => parseWorkResult({ ...completedWork, correlation_id: "corr:other" }, parsedWorkRequest()),
    /work_correlation_mismatch/u,
  );
});

const verifyTarget: VerifyTarget = Object.freeze({
  ...target,
  verify_issue_id: parseStageIssueId("LIN-VERIFY"),
  revision: parseRevision("0123456789abcdef0123456789abcdef01234567"),
});

const verifyRequest = {
  schema_version: 1,
  ...verifyTarget,
  correlation_id: "corr:verify:1",
  root: request.root,
  cycle: request.cycle,
  verify: {
    title: "Verify the exact revision",
    description: "Inspect only the immutable revision and report evidence.",
  },
  requested_checks: ["Run focused tests", "Run typecheck"],
};

const passedVerify = {
  schema_version: 1,
  ...verifyTarget,
  correlation_id: verifyRequest.correlation_id,
  conclusion: "passed",
  checks: [
    {
      check: "Run focused tests",
      status: "passed",
      sanitized_summary: "Focused tests passed",
    },
    {
      check: "Run typecheck",
      status: "passed",
      sanitized_summary: "Typecheck passed",
    },
  ],
  sanitized_summary: "The requested checks passed at the bound revision",
};

function parsedVerifyRequest(): VerifyRequest {
  return parseVerifyRequest(structuredClone(verifyRequest), verifyTarget);
}

test("VerifyRequest binds normalized facts and requested checks to one revision", () => {
  const parsed = parsedVerifyRequest();

  assert.deepEqual(parsed, verifyRequest);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.root));
  assert.ok(Object.isFrozen(parsed.cycle));
  assert.ok(Object.isFrozen(parsed.verify));
  assert.ok(Object.isFrozen(parsed.requested_checks));

  for (const extra of [
    { cwd: "/tmp/revision" },
    { branch: "main" },
    { tools: ["create_commit"] },
    { git_token: "secret" },
    { provider: "github" },
    { metadata: {} },
  ]) {
    assert.throws(
      () => parseVerifyRequest({ ...verifyRequest, ...extra }, verifyTarget),
      /invalid_contract_keys/u,
    );
  }

  assert.throws(
    () => parseVerifyRequest({ ...verifyRequest, revision: "f".repeat(40) }, verifyTarget),
    /verify_target_mismatch/u,
  );
  assert.throws(
    () => parseVerifyRequest({ ...verifyRequest, requested_checks: [] }, verifyTarget),
    /verify_checks_required/u,
  );
  assert.throws(
    () => parseVerifyRequest({
      ...verifyRequest,
      requested_checks: [verifyRequest.requested_checks[0], verifyRequest.requested_checks[0]],
    }, verifyTarget),
    /duplicate_contract_identity/u,
  );
});

test("passed VerifyResult covers every requested check exactly once", () => {
  const parsed = parseVerifyResult(structuredClone(passedVerify), parsedVerifyRequest());

  assert.deepEqual(parsed, passedVerify);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.checks));
  assert.ok(Object.isFrozen(parsed.checks[0]));

  assert.throws(
    () => parseVerifyResult({ ...passedVerify, checks: passedVerify.checks.slice(0, 1) }, parsedVerifyRequest()),
    /passed_verify_check_coverage/u,
  );
  assert.throws(
    () => parseVerifyResult({
      ...passedVerify,
      checks: [passedVerify.checks[0], { ...passedVerify.checks[1], status: "failed" }],
    }, parsedVerifyRequest()),
    /passed_verify_check_failed/u,
  );
  assert.throws(
    () => parseVerifyResult({
      ...passedVerify,
      checks: [...passedVerify.checks, {
        check: "Publish a pull request",
        status: "passed",
        sanitized_summary: "Forbidden delivery claim",
      }],
    }, parsedVerifyRequest()),
    /unknown_verify_check/u,
  );
});

test("failed and inconclusive VerifyResult variants remain non-mutating evidence", () => {
  const failed = {
    ...passedVerify,
    conclusion: "failed",
    checks: [
      passedVerify.checks[0],
      { ...passedVerify.checks[1], status: "failed", sanitized_summary: "Typecheck failed" },
    ],
    sanitized_summary: "A requested verification check failed",
  };
  assert.deepEqual(parseVerifyResult(failed, parsedVerifyRequest()), failed);

  const inconclusive = {
    ...passedVerify,
    conclusion: "inconclusive",
    checks: [],
    sanitized_summary: "Verification boundary was unavailable",
  };
  assert.deepEqual(parseVerifyResult(inconclusive, parsedVerifyRequest()), inconclusive);

  assert.throws(
    () => parseVerifyResult({ ...failed, checks: passedVerify.checks }, parsedVerifyRequest()),
    /failed_verify_check_required/u,
  );
  for (const claim of [
    { repaired: true },
    { workspace_changed: true },
    { diff: "patch" },
    { status: "Done" },
    { issue_updated: true },
    { commit: verifyTarget.revision },
    { provider_receipt: {} },
  ]) {
    assert.throws(
      () => parseVerifyResult({ ...passedVerify, ...claim }, parsedVerifyRequest()),
      /invalid_contract_keys/u,
    );
  }
});

test("VerifyResult is bound to exact Stage, revision, and correlation identity", () => {
  assert.throws(
    () => parseVerifyResult({ ...passedVerify, verify_issue_id: "LIN-OTHER" }, parsedVerifyRequest()),
    /verify_target_mismatch/u,
  );
  assert.throws(
    () => parseVerifyResult({ ...passedVerify, revision: "f".repeat(40) }, parsedVerifyRequest()),
    /verify_target_mismatch/u,
  );
  assert.throws(
    () => parseVerifyResult({ ...passedVerify, correlation_id: "corr:other" }, parsedVerifyRequest()),
    /verify_correlation_mismatch/u,
  );
});
