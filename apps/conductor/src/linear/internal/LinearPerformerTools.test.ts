import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseStageIssueId,
} from "../../contracts/identity.js";
import type { LinearObservation } from "../../contracts/observation.js";
import { LinearPerformerTools } from "./LinearPerformerTools.js";

const rootId = parseRootIssueId("ROOT-1");
const cycleId = parseCycleIssueId("CYCLE-1");
const generation = parseRuntimeGeneration(1);
const correlationId = parseCorrelationId("performer:1");

test("Plan binding creates one bounded DAG and accepts only complete fresh read-back", async () => {
  const issueIds = ["PLAN-1", "WORK-1", "WORK-2", "VERIFY-1"];
  const creates: unknown[] = [];
  const relations: unknown[] = [];
  let reads = 0;
  const empty: LinearObservation = {
    root_id: rootId, root_status: "In Progress",
    active_cycle: { issue_id: cycleId, status: "Planning", stages: [] },
  };
  const complete: LinearObservation = {
    root_id: rootId, root_status: "In Progress",
    active_cycle: {
      issue_id: cycleId,
      status: "Planning",
      stages: [
        { issue_id: parseStageIssueId("PLAN-1"), kind: "plan", status: "Done", dependency_issue_ids: [] },
        { issue_id: parseStageIssueId("WORK-1"), kind: "work", status: "Todo", dependency_issue_ids: [] },
        { issue_id: parseStageIssueId("WORK-2"), kind: "work", status: "Todo", dependency_issue_ids: [parseStageIssueId("WORK-1")] },
        { issue_id: parseStageIssueId("VERIFY-1"), kind: "verify", status: "Todo", dependency_issue_ids: [parseStageIssueId("WORK-1"), parseStageIssueId("WORK-2")] },
      ],
    },
  };
  const sdk = {
    workflowStates: ({ filter }: { filter: { name: { eq: string } } }) => Promise.resolve({
      nodes: [{ id: `state-${filter.name.eq}`, name: filter.name.eq, teamId: "team-1" }],
      pageInfo: { hasNextPage: false }, fetchNext: () => Promise.reject(new Error("unexpected_page")),
    }),
    issueLabels: ({ filter }: { filter: { name: { eq: string } } }) => Promise.resolve({
      nodes: [{ id: `label-${filter.name.eq}`, name: filter.name.eq, teamId: "team-1" }],
      pageInfo: { hasNextPage: false }, fetchNext: () => Promise.reject(new Error("unexpected_page")),
    }),
    createIssue: (input: unknown) => { creates.push(input); return Promise.resolve({ success: true, issueId: issueIds[creates.length - 1] }); },
    createIssueRelation: (input: unknown) => { relations.push(input); return Promise.resolve({ success: true }); },
  };
  const tools = new LinearPerformerTools(sdk as never, "team-1", {
    readRoot: () => Promise.resolve(reads++ === 0 ? empty : complete),
  });
  const binding = tools.plan({
    schema_version: 1, root_id: rootId, runtime_generation: generation, correlation_id: correlationId,
    cycle_issue_id: cycleId, role: "plan",
  });
  const result = await binding.execute({
    plan_title: "Plan", plan_description: "Plan description",
    works: [
      { title: "First", description: "First work", depends_on: [] },
      { title: "Second", description: "Second work", depends_on: [0] },
    ],
    verify_title: "Verify", verify_description: "Verify all work",
  });

  assert.deepEqual(result, { plan_issue_id: "PLAN-1", work_issue_ids: ["WORK-1", "WORK-2"], verify_issue_id: "VERIFY-1" });
  assert.equal(creates.length, 4);
  assert.deepEqual(relations, [
    { issueId: "WORK-1", relatedIssueId: "WORK-2", type: "blocks" },
    { issueId: "WORK-1", relatedIssueId: "VERIFY-1", type: "blocks" },
    { issueId: "WORK-2", relatedIssueId: "VERIFY-1", type: "blocks" },
  ]);
});

test("Work binding can update only its bound In Progress stage and requires fresh terminal read-back", async () => {
  const workId = parseStageIssueId("WORK-1");
  let updated = false;
  const observation = (): LinearObservation => ({
    root_id: rootId, root_status: "In Progress",
    active_cycle: {
      issue_id: cycleId, status: "Executing",
      stages: [{ issue_id: workId, kind: "work", status: updated ? "Done" : "In Progress", dependency_issue_ids: [] }],
    },
  });
  const sdk = {
    workflowStates: ({ filter }: { filter: { name: { eq: string } } }) => Promise.resolve({
      nodes: [{ id: `state-${filter.name.eq}`, name: filter.name.eq, teamId: "team-1" }],
      pageInfo: { hasNextPage: false }, fetchNext: () => Promise.reject(new Error("unexpected_page")),
    }),
    updateIssue: (issueId: string) => { updated = true; return Promise.resolve({ success: true, issueId }); },
  };
  const tools = new LinearPerformerTools(sdk as never, "team-1", { readRoot: () => Promise.resolve(observation()) });
  const binding = tools.work({
    schema_version: 1, root_id: rootId, runtime_generation: generation, correlation_id: correlationId,
    cycle_issue_id: cycleId, role: "work", work_issue_id: workId,
  });
  assert.deepEqual(await binding.execute({ outcome: "completed" }), {
    issue_id: workId, status: "Done", outcome: "completed",
  });
  await assert.rejects(binding.execute({ outcome: "completed" }), /linear_stage_precondition_mismatch/u);
});

test("stage identity lookup reads every page and fails closed on a later duplicate", async () => {
  const workId = parseStageIssueId("WORK-1");
  let updates = 0;
  const observation: LinearObservation = {
    root_id: rootId, root_status: "In Progress",
    active_cycle: {
      issue_id: cycleId, status: "Executing",
      stages: [{ issue_id: workId, kind: "work", status: "In Progress", dependency_issue_ids: [] }],
    },
  };
  const secondPage = {
    nodes: [
      { id: "state-done-1", name: "Done", teamId: "team-1" },
      { id: "state-done-2", name: "Done", teamId: "team-1" },
    ],
    pageInfo: { hasNextPage: false },
    fetchNext: () => Promise.reject(new Error("unexpected_page")),
  };
  const sdk = {
    workflowStates: () => Promise.resolve({
      nodes: [secondPage.nodes[0]],
      pageInfo: { hasNextPage: true },
      fetchNext: () => Promise.resolve(secondPage),
    }),
    updateIssue: () => { updates += 1; return Promise.resolve({ success: true, issueId: workId }); },
  };
  const binding = new LinearPerformerTools(sdk as never, "team-1", {
    readRoot: () => Promise.resolve(observation),
  }).work({
    schema_version: 1, root_id: rootId, runtime_generation: generation, correlation_id: correlationId,
    cycle_issue_id: cycleId, role: "work", work_issue_id: workId,
  });

  await assert.rejects(binding.execute({ outcome: "completed" }), /linear_state_identity_ambiguous/u);
  assert.equal(updates, 0);
});
