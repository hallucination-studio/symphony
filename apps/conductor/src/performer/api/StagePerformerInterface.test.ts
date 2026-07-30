import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCycleIssueId,
  parseRootIssueId,
  parseRuntimeGeneration,
} from "../../contracts/identity.js";
import {
  parsePlanRequest,
  parsePlanResult,
  type PlanRequest,
  type PlanTarget,
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
