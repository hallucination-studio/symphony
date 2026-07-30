import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseStageIssueId,
} from "../../contracts/identity.js";
import type { LinearObservation } from "../api/LinearObservation.js";
import type { LinearMutation } from "../api/LinearGatewayInterface.js";
import {
  LinearMutations,
  type LinearMutationClient,
  type LinearMutationReader,
  type LinearTargetObservation,
} from "./LinearMutations.js";

const ROOT_ID = parseRootIssueId("root-1");
const CYCLE_ID = parseCycleIssueId("cycle-1");
const WORK_ID = parseStageIssueId("work-1");

function rootObservation(
  rootStatus: LinearObservation["root_status"] = "Todo",
  cycleStatus: NonNullable<LinearObservation["active_cycle"]>["status"] | null = null,
  stageStatus: "Todo" | "In Progress" | "Done" | "Failed" | "Canceled" = "Todo",
): LinearObservation {
  return {
    root_id: ROOT_ID,
    root_status: rootStatus,
    active_cycle: cycleStatus === null ? null : {
      issue_id: CYCLE_ID,
      status: cycleStatus,
      stages: [{ issue_id: WORK_ID, kind: "work", status: stageStatus, dependency_issue_ids: [] }],
    },
  };
}

function target(
  id: string,
  kind: LinearTargetObservation["kind"],
  status: string,
  parentId: string | null,
): LinearTargetObservation {
  return { issue_id: id, team_id: "team-1", parent_id: parentId, kind, status };
}

class FakeReader implements LinearMutationReader {
  readonly roots: LinearObservation[] = [];
  readonly targets: LinearTargetObservation[] = [];
  rootReads = 0;
  targetReads = 0;

  async readRoot() {
    this.rootReads += 1;
    const value = this.roots.shift();
    if (!value) throw new Error("missing_root_fixture");
    return value;
  }

  async readTarget() {
    this.targetReads += 1;
    const value = this.targets.shift();
    if (!value) throw new Error("missing_target_fixture");
    return value;
  }
}

function page(nodes: readonly unknown[]) {
  return { nodes, page_info: { has_next_page: false, end_cursor: null } };
}

class FakeMutationClient implements LinearMutationClient {
  readonly effects: Array<{ kind: string; input: unknown }> = [];
  lookupCount = 0;
  response: unknown = { success: true, issue_id: "root-1" };
  statePage: unknown | null = null;
  labelPage: unknown | null = null;
  failure: Error | null = null;

  async listWorkflowStates(_teamId: string, name: string) {
    this.lookupCount += 1;
    return this.statePage ?? page([{ id: `state:${name}`, name, team_id: "team-1" }]);
  }

  async listNamedIssueLabels(name: string) {
    this.lookupCount += 1;
    return this.labelPage ?? page([{ id: "label:cycle", name, team_id: null, is_group: false }]);
  }

  async createCycle(input: unknown) {
    this.effects.push({ kind: "create_cycle", input });
    if (this.failure) throw this.failure;
    return this.response;
  }

  async updateIssueStatus(issueId: string, stateId: string) {
    this.effects.push({ kind: "update_status", input: { issue_id: issueId, state_id: stateId } });
    if (this.failure) throw this.failure;
    return this.response;
  }
}

function mutations(reader: FakeReader, client = new FakeMutationClient()) {
  return { client, mutations: new LinearMutations(reader, client, { team_id: "team-1" }) };
}

const commands = {
  create: {
    schema_version: 1,
    kind: "create_cycle",
    root_id: ROOT_ID,
    correlation_id: parseCorrelationId("corr:create"),
    expected_root_status: "Todo",
    expected_no_active_cycle: true,
  } as const,
  root: {
    schema_version: 1,
    kind: "set_root_status",
    root_id: ROOT_ID,
    correlation_id: parseCorrelationId("corr:root"),
    expected_status: "Todo",
    desired_status: "In Progress",
  } as const,
  cycle: {
    schema_version: 1,
    kind: "set_cycle_status",
    root_id: ROOT_ID,
    cycle_issue_id: CYCLE_ID,
    correlation_id: parseCorrelationId("corr:cycle"),
    expected_status: "Planning",
    desired_status: "Executing",
  } as const,
  stage: {
    schema_version: 1,
    kind: "set_stage_status",
    root_id: ROOT_ID,
    cycle_issue_id: CYCLE_ID,
    stage_issue_id: WORK_ID,
    expected_kind: "work",
    correlation_id: parseCorrelationId("corr:stage"),
    expected_status: "Todo",
    desired_status: "In Progress",
  } as const,
} satisfies Record<string, LinearMutation>;

test("all four commands perform one exact effect only after a fresh precondition and accept fresh postconditions", async () => {
  const cases: Array<{
    command: LinearMutation;
    before: LinearObservation;
    afterRoot?: LinearObservation;
    afterTarget?: LinearTargetObservation;
    expectedEffect: unknown;
    expectedTarget: string;
  }> = [
    {
      command: commands.create,
      before: rootObservation("Todo"),
      afterRoot: rootObservation("Todo", "Planning"),
      expectedEffect: {
        team_id: "team-1", parent_issue_id: "root-1", title: "Symphony Cycle",
        state_id: "state:Planning", label_id: "label:cycle",
      },
      expectedTarget: "cycle-1",
    },
    {
      command: commands.root,
      before: rootObservation("Todo"),
      afterTarget: target("root-1", "root", "In Progress", null),
      expectedEffect: { issue_id: "root-1", state_id: "state:In Progress" },
      expectedTarget: "root-1",
    },
    {
      command: commands.cycle,
      before: rootObservation("In Progress", "Planning"),
      afterTarget: target("cycle-1", "cycle", "Executing", "root-1"),
      expectedEffect: { issue_id: "cycle-1", state_id: "state:Executing" },
      expectedTarget: "cycle-1",
    },
    {
      command: commands.stage,
      before: rootObservation("In Progress", "Executing", "Todo"),
      afterTarget: target("work-1", "work", "In Progress", "cycle-1"),
      expectedEffect: { issue_id: "work-1", state_id: "state:In Progress" },
      expectedTarget: "work-1",
    },
  ];

  for (const entry of cases) {
    const reader = new FakeReader();
    reader.roots.push(entry.before, ...(entry.afterRoot ? [entry.afterRoot] : []));
    if (entry.afterTarget) reader.targets.push(entry.afterTarget);
    const fixture = mutations(reader);
    fixture.client.response = { success: true, issue_id: entry.expectedTarget };

    const result = await fixture.mutations.mutate(entry.command);

    assert.deepEqual(result, {
      schema_version: 1,
      outcome: "applied",
      target_id: entry.expectedTarget,
      correlation_id: entry.command.correlation_id,
    });
    assert.equal(fixture.client.effects.length, 1);
    assert.deepEqual(fixture.client.effects[0]?.input, entry.expectedEffect);
  }
});

test("stale preconditions return precondition_failed before lookup or effect", async () => {
  const staleFacts = [
    rootObservation("In Progress"),
    rootObservation("In Progress", "Executing"),
    rootObservation("In Progress", "Executing"),
    rootObservation("In Progress", "Executing", "Done"),
  ];
  for (const [index, command] of Object.values(commands).entries()) {
    const reader = new FakeReader();
    reader.roots.push(staleFacts[index] as LinearObservation);
    const fixture = mutations(reader);

    const result = await fixture.mutations.mutate(command);

    assert.equal(result.outcome, "precondition_failed");
    assert.equal(result.schema_version, 1);
    assert.equal(fixture.client.lookupCount, 0);
    assert.equal(fixture.client.effects.length, 0);
  }
});

test("provider acknowledgement, rejection, uncertainty, and readback produce all closed outcomes without retry", async () => {
  const cases: Array<{
    response?: unknown;
    failure?: Error;
    after: LinearTargetObservation;
    outcome: "applied" | "not_applied" | "acceptance_unknown" | "readback_mismatch";
  }> = [
    { response: { success: true, issue_id: "root-1" }, after: target("root-1", "root", "In Progress", null), outcome: "applied" },
    { response: { success: false, issue_id: "root-1" }, after: target("root-1", "root", "Todo", null), outcome: "not_applied" },
    { failure: new Error("provider-sensitive-value"), after: target("root-1", "root", "Todo", null), outcome: "acceptance_unknown" },
    { response: { success: true, issue_id: "root-1" }, after: target("root-1", "root", "Todo", null), outcome: "readback_mismatch" },
    { failure: new Error("provider-sensitive-value"), after: target("root-1", "root", "In Progress", null), outcome: "applied" },
  ];

  for (const entry of cases) {
    const reader = new FakeReader();
    reader.roots.push(rootObservation("Todo"));
    reader.targets.push(entry.after);
    const fixture = mutations(reader);
    if (entry.response) fixture.client.response = entry.response;
    if (entry.failure) fixture.client.failure = entry.failure;

    const result = await fixture.mutations.mutate(commands.root);

    assert.equal(result.outcome, entry.outcome);
    assert.equal(fixture.client.effects.length, 1);
    assert.equal(JSON.stringify(result).includes("sensitive"), false);
  }
});

test("malformed possible-success responses force readback_mismatch and expose no provider payload", async () => {
  const reader = new FakeReader();
  reader.roots.push(rootObservation("Todo"));
  reader.targets.push(target("root-1", "root", "Todo", null));
  const fixture = mutations(reader);
  fixture.client.response = { success: "yes", private_payload: "provider-sensitive-value" };

  const result = await fixture.mutations.mutate(commands.root);

  assert.equal(result.outcome, "readback_mismatch");
  assert.equal(JSON.stringify(result).includes("sensitive"), false);
  assert.equal(fixture.client.effects.length, 1);
});

test("incomplete identity lookup performs no effect and readback loss after one effect is acceptance_unknown", async () => {
  const beforeEffect = new FakeReader();
  beforeEffect.roots.push(rootObservation("Todo"));
  const incomplete = mutations(beforeEffect);
  incomplete.client.statePage = {
    nodes: [{ id: "state:In Progress", name: "In Progress", team_id: "team-1" }],
    page_info: { has_next_page: true, end_cursor: null },
  };
  const notApplied = await incomplete.mutations.mutate(commands.root);
  assert.equal(notApplied.outcome, "not_applied");
  assert.equal(incomplete.client.effects.length, 0);

  const afterEffect = new FakeReader();
  afterEffect.roots.push(rootObservation("Todo"));
  const unavailable = mutations(afterEffect);
  const unknown = await unavailable.mutations.mutate(commands.root);
  assert.equal(unknown.outcome, "acceptance_unknown");
  assert.equal(unavailable.client.effects.length, 1);
  assert.equal(JSON.stringify(unknown).includes("missing_target_fixture"), false);
});
