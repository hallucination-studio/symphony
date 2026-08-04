import assert from "node:assert/strict";
import test from "node:test";

import { parseTaskIssueId } from "../contracts/identity.js";
import type { ConcreteTaskChange } from "../contracts/observation.js";
import { canonicalTaskRevision, parseTaskSnapshot, type TaskIssueSnapshot } from "../contracts/task-management.js";
import { parseTaskWorkflowIdentities } from "../task-management/api/TaskManageCapability.js";
import { routeFreshTask } from "./FreshTaskRouter.js";

const workflow = parseTaskWorkflowIdentities({
  labels: {
    root: "label:root", cycle: "label:cycle", plan: "label:plan", work: "label:work", verify: "label:verify",
  },
  cycle_states: {
    draft: "cycle:draft",
    in_progress: "root:in-progress",
    awaiting_acceptance: "cycle:awaiting",
    succeeded: "cycle:succeeded",
    rejected: "cycle:rejected",
    failed: "cycle:failed",
    canceled: "cycle:canceled",
  },
  stage_states: {
    todo: "stage:todo",
    in_progress: "stage:in-progress",
    done: "stage:done",
    failed: "stage:failed",
    canceled: "stage:canceled",
  },
});

const rootStates = {
  todo: "root:todo",
  in_progress: "root:in-progress",
  in_review: "root:in-review",
  done: "root:done",
  failed: workflow.cycle_states.failed,
} as const;

const states = {
  team_id: "team:router", revision: `symphony:v1:${"0".repeat(64)}`,
  todo_state_id: rootStates.todo, draft_state_id: workflow.cycle_states.draft,
  in_progress_state_id: rootStates.in_progress, awaiting_acceptance_state_id: workflow.cycle_states.awaiting_acceptance,
  in_review_state_id: rootStates.in_review, done_state_id: rootStates.done,
  succeeded_state_id: workflow.cycle_states.succeeded, rejected_state_id: workflow.cycle_states.rejected,
  failed_state_id: workflow.cycle_states.failed, canceled_state_id: workflow.cycle_states.canceled,
} as const;

function canonicalIssue(input: {
  readonly issue_id: string; readonly kind: TaskIssueSnapshot["kind"];
  readonly status_id: string; readonly status: TaskIssueSnapshot["status"];
  readonly title: string; readonly description_markdown: string;
  readonly parent_issue_id: string | null; readonly label_ids: readonly string[];
  readonly delegate_id: string | null; readonly priority: number | null;
}) {
  const fields = {
    ...input, provider_created_at: "2026-08-03T00:00:00.000Z",
    provider_updated_at: "2026-08-03T00:00:00.000Z", creation_actor_id: "actor:agent",
    archived: false, trashed: false,
  };
  return { ...fields, revision: canonicalTaskRevision(fields) };
}

function cycleStatus(status: keyof typeof workflow.cycle_states): TaskIssueSnapshot["status"] {
  return status === "draft" ? "Draft" : status === "in_progress" ? "In Progress"
    : status === "awaiting_acceptance" ? "Awaiting Acceptance" : status === "succeeded" ? "Succeeded"
      : status === "rejected" ? "Rejected" : status === "failed" ? "Failed" : "Canceled";
}

function task(cycles: readonly (keyof typeof workflow.cycle_states)[], options: {
  readonly delegated?: boolean;
  readonly rootStatus?: string;
  readonly records?: readonly unknown[];
  readonly issueHistory?: readonly unknown[];
} = {}) {
  return parseTaskSnapshot({
    root_id: "root-1",
    workflow_state_map: states,
    issues: [canonicalIssue({
      issue_id: "root-1",
      kind: "root", status_id: options.rootStatus ?? rootStates.in_progress,
      status: options.rootStatus === rootStates.done ? "Done"
        : options.rootStatus === rootStates.in_review ? "In Review"
          : options.rootStatus === rootStates.failed ? "Failed"
            : options.rootStatus === rootStates.todo ? "Todo" : "In Progress",
      title: "Root",
      description_markdown: "# Root", parent_issue_id: null, label_ids: [workflow.labels.root],
      delegate_id: options.delegated === false ? null : "actor:agent",
      priority: 1,
    }), ...cycles.map((status, index) => canonicalIssue({
      issue_id: `cycle-${index + 1}`,
      kind: "cycle", status_id: workflow.cycle_states[status], status: cycleStatus(status),
      title: `Cycle ${index + 1}`,
      description_markdown: "# Cycle", parent_issue_id: "root-1", label_ids: [workflow.labels.cycle],
      delegate_id: null,
      priority: null,
    }))],
    relations: [],
    resource_creation_evidence: [], issue_history: options.issueHistory ?? [],
    issue_record_observations: options.records ?? [],
  });
}

function acceptedDeliveryRecords(): readonly unknown[] {
  const digest = (character: string) => character.repeat(64);
  const revision = (character: string) => `symphony:v1:${digest(character)}`;
  const firstRound = {
    linear_snapshot_digest: digest("1"),
    linear_observed_at: "2026-08-03T00:00:00.000Z",
    git_exact_revision: digest("2"),
    git_observed_at: "2026-08-03T00:00:00.000Z",
    root_revision: revision("3"),
  };
  const secondRound = {
    ...firstRound,
    linear_observed_at: "2026-08-03T00:00:01.000Z",
    git_observed_at: "2026-08-03T00:00:01.000Z",
  };
  return [{
    record_id: "record:cycle:approval:1",
    revision: revision("4"),
    issue_id: "cycle-1",
    cycle_id: "cycle-1",
    actor_id: "actor:agent",
    created_at: "2026-08-03T00:00:00.000Z",
    updated_at: "2026-08-03T00:00:00.000Z",
    archived_at: null,
    basis_issue_revision: revision("5"),
    basis_status: "Draft",
    basis_document_digest: digest("6"),
    record_kind: "cycle_approval",
    identity_derivation_version: "symphony-identity:v1",
    predecessor_cycle_issue_id: null,
    predecessor_terminal_record_id: "record:first-cycle",
    plan_issue_id: "plan-1",
    plan_completion_record_id: "record:plan:completion:1",
    plan_invalidation_record_id: "record:plan:invalidation:1",
    cycle_completion_record_id: "record:cycle:completion:1",
    cycle_invalidation_record_id: "record:cycle:invalidation:1",
    delivery_completion_record_id: "record:delivery:completion:1",
    delivery_invalidation_record_id: "record:delivery:invalidation:1",
    specification_seal_digest: digest("7"),
    workspace_base_revision: digest("8"),
  }, {
    record_id: "record:cycle:completion:1",
    revision: revision("9"),
    issue_id: "cycle-1",
    cycle_id: "cycle-1",
    actor_id: "actor:agent",
    created_at: "2026-08-03T00:00:02.000Z",
    updated_at: "2026-08-03T00:00:02.000Z",
    archived_at: null,
    basis_issue_revision: revision("a"),
    basis_status: "Awaiting Acceptance",
    basis_document_digest: digest("b"),
    record_kind: "cycle_completion",
    successor_policy: "not_applicable",
    completion: {
      outcome: "accepted",
      specification_seal_digest: digest("7"),
      graph_seal_digest: digest("c"),
      acceptance_basis_digest: digest("d"),
      stage_revisions: [{ issue_id: "stage-1", revision: revision("e"), terminal_record_digest: digest("f") }],
      stage_completion_digests: [{ issue_id: "stage-1", digest: digest("0") }],
      exact_revision: digest("2"),
      acceptance_convergence_proof: {
        proof_scope: "acceptance",
        first_round: firstRound,
        second_round: secondRound,
        observation_order: "linear -> git -> linear -> git",
        stable_decision_basis_digest: digest("a"),
      },
      acceptance_markdown: "Accepted.",
    },
  }];
}

function deliveryTerminalRecord(kind: "completion" | "invalidation"): Record<string, unknown> {
  const digest = (character: string) => character.repeat(64);
  const revision = (character: string) => `symphony:v1:${digest(character)}`;
  const common = {
    record_id: kind === "completion" ? "record:delivery:completion:1" : "record:delivery:invalidation:1",
    revision: revision("1"),
    issue_id: "root-1",
    cycle_id: "cycle-1",
    actor_id: "actor:agent",
    created_at: "2026-08-03T00:00:03.000Z",
    updated_at: "2026-08-03T00:00:03.000Z",
    archived_at: null,
    basis_issue_revision: revision("2"),
    basis_status: "In Review",
    basis_document_digest: digest("3"),
    record_kind: kind === "completion" ? "delivery_completion" : "delivery_invalidation",
    root_id: "root-1",
    accepted_cycle_id: "cycle-1",
    exact_revision: digest("4"),
    accepted_record_digest: digest("5"),
    acceptance_basis_digest: digest("6"),
    observed_root_status: "In Review",
  };
  if (kind === "completion") {
    return {
      ...common,
      observed_remote_revision: digest("4"),
      observed_pull_request_identity: "https://github.example/pull/1",
      observed_pull_request_head: digest("4"),
      convergence_proof: {
        proof_scope: "delivery",
        first_round: {
          linear_snapshot_digest: digest("7"),
          linear_observed_at: "2026-08-03T00:00:03.000Z",
          root_revision: revision("2"),
          git_exact_revision: digest("4"),
          git_observed_at: "2026-08-03T00:00:03.000Z",
          remote_ref_revision: digest("4"),
          pull_request_identity: "https://github.example/pull/1",
          pull_request_revision: revision("8"),
          pull_request_head: digest("4"),
          pull_request_state: "open",
          delivery_provider_observed_at: "2026-08-03T00:00:03.000Z",
        },
        second_round: {
          linear_snapshot_digest: digest("7"),
          linear_observed_at: "2026-08-03T00:00:04.000Z",
          root_revision: revision("2"),
          git_exact_revision: digest("4"),
          git_observed_at: "2026-08-03T00:00:04.000Z",
          remote_ref_revision: digest("4"),
          pull_request_identity: "https://github.example/pull/1",
          pull_request_revision: revision("8"),
          pull_request_head: digest("4"),
          pull_request_state: "open",
          delivery_provider_observed_at: "2026-08-03T00:00:04.000Z",
        },
        observation_order: "linear -> git -> delivery -> linear -> git -> delivery",
        stable_decision_basis_digest: digest("9"),
      },
    };
  }
  return {
    ...common,
    observed_remote_revision: null,
    observed_pull_request_identity: null,
    observed_pull_request_head: null,
    invalidation_evidence: {
      kind: "root_done_before_completion",
      observed_root_revision: revision("2"),
      observed_delivery_facts_digest: digest("a"),
    },
    resolution_policy: "permanently_quarantined",
    reason_code: "root_done_before_completion",
    reason_markdown: "The Root reached Done before delivery completion.",
  };
}

function route(
  cycles: readonly (keyof typeof workflow.cycle_states)[],
  options: Parameters<typeof task>[1] = {},
  changes: readonly ConcreteTaskChange[] = [],
  origins: Parameters<typeof routeFreshTask>[0]["task_change_origins"] = [],
) {
  return routeFreshTask({
    task: task(cycles, options),
    task_changes: changes,
    task_change_origins: origins,
    agent_actor_id: "actor:agent",
    root_states: rootStates,
    workflow,
  });
}

function routeWithRecords(
  cycles: readonly (keyof typeof workflow.cycle_states)[],
  records: readonly unknown[],
  options: Parameters<typeof task>[1] = {},
) {
  return route(cycles, { ...options, records });
}

test("bounded origin routes external Root edits at least once without treating service writes as external", () => {
  const external = route(["in_progress"], {}, [], [{
    issue_id: parseTaskIssueId("root-1"),
    change_origin: "external",
    changed_fields: ["title"],
  }]);
  assert.equal(external.matches.some(({ route_id }) => route_id === "WF-ROUTE-005"), true);
  assert.equal(external.selected.route_id, "WF-ROUTE-005");

  const symphony = route(["in_progress"], {}, [], [{
    issue_id: parseTaskIssueId("root-1"),
    change_origin: "symphony",
    changed_fields: ["title"],
  }]);
  assert.equal(symphony.matches.some(({ route_id }) => route_id === "WF-ROUTE-005"), false);
});

test("unknown sealed-subtree origin fails closed while service writeback remains mechanical", () => {
  const stageChange: ConcreteTaskChange = {
    kind: "field_changed",
    issue_id: parseTaskIssueId("stage-1"),
    field: "description",
    before: "before",
    after: "after",
  };
  const taskWithStage = parseTaskSnapshot({
    ...task(["in_progress"]),
    issues: [...task(["in_progress"]).issues, canonicalIssue({
      issue_id: "stage-1", kind: "work", status_id: states.in_progress_state_id, status: "In Progress",
      title: "Stage", description_markdown: "after", parent_issue_id: "cycle-1", label_ids: [workflow.labels.work],
      delegate_id: null, priority: null,
    })],
  });
  const input = {
    task: taskWithStage,
    task_changes: [stageChange],
    agent_actor_id: "actor:agent",
    root_states: rootStates,
    workflow,
  } as const;
  assert.equal(routeFreshTask({ ...input, task_change_origins: [{
    issue_id: parseTaskIssueId("stage-1"), change_origin: "unknown", changed_fields: ["description"],
  }] }).selected.route_id, "WF-ROUTE-006");
  assert.equal(routeFreshTask({ ...input, task_change_origins: [{
    issue_id: parseTaskIssueId("stage-1"), change_origin: "symphony", changed_fields: ["description"],
  }] }).matches.some(({ route_id }) => route_id === "WF-ROUTE-006"), false);
});

test("routing evaluates all rows and selects the unique lowest numeric priority", () => {
  const rootEdit: ConcreteTaskChange = {
    kind: "field_changed",
    issue_id: parseTaskIssueId("root-1"),
    field: "title",
    before: "Before",
    after: "After",
  };
  const cycleWrite: ConcreteTaskChange = {
    kind: "field_changed",
    issue_id: parseTaskIssueId("cycle-1"),
    field: "description",
    before: "Before",
    after: "After",
  };
  const selected = route(["in_progress"], {}, [rootEdit, cycleWrite], [{
    issue_id: parseTaskIssueId("root-1"), change_origin: "external", changed_fields: ["title"],
  }, {
    issue_id: parseTaskIssueId("cycle-1"), change_origin: "symphony", changed_fields: ["description"],
  }]);

  assert.deepEqual(selected.matches.map(({ route_id, priority }) => [route_id, priority]), [
    ["WF-ROUTE-004", 80],
    ["WF-ROUTE-005", 130],
  ]);
  assert.equal(selected.selected.route_id, "WF-ROUTE-004");
  assert.equal(selected.selected.consumer, "cycle_machine");
});

test("family overlap and admission loss outrank ordinary mechanics without selecting Root", () => {
  const family = route(["draft", "in_progress"]);
  assert.equal(family.selected.route_id, "WF-ROUTE-009");
  assert.equal(family.selected.consumer, "family_guard");
  assert.equal(family.selected.cycle_id, null);

  const admission = route(["in_progress"], { delegated: false });
  assert.deepEqual(admission.matches.map(({ route_id }) => route_id), ["WF-ROUTE-015", "WF-ROUTE-004"]);
  assert.equal(admission.selected.route_id, "WF-ROUTE-015");
  assert.equal(admission.selected.consumer, "cycle_machine");
});

test("fresh boundary states and park have deterministic owners", () => {
  assert.equal(route([]).selected.route_id, "WF-ROUTE-001");
  assert.equal(route(["draft"]).selected.route_id, "WF-ROUTE-002");
  assert.equal(route(["awaiting_acceptance"]).selected.route_id, "WF-ROUTE-007");
  assert.equal(route(["succeeded"]).selected.route_id, "WF-ROUTE-008");
  assert.equal(route([], { delegated: false }).selected.route_id, "WF-ROUTE-014");
});

test("an accepted Cycle without a delivery terminal record selects the DeliveryFinalizer", () => {
  const routing = routeWithRecords(["succeeded"], acceptedDeliveryRecords());

  assert.equal(routing.selected.route_id, "WF-ROUTE-010");
  assert.equal(routing.selected.consumer, "delivery_finalizer");
  assert.equal(routing.selected.cycle_id, "cycle-1");
});

test("Root Done with an accepted Cycle and no delivery terminal record persists delivery invalidation first", () => {
  const routing = routeWithRecords(["succeeded"], acceptedDeliveryRecords(), { rootStatus: rootStates.done });

  assert.equal(routing.selected.route_id, "WF-ROUTE-012");
  assert.equal(routing.selected.consumer, "delivery_finalizer");
  assert.equal(routing.selected.cycle_id, "cycle-1");
});

test("delivery terminal records close the gap and do not re-enter delivery or successor routing", () => {
  for (const terminal of ["completion", "invalidation"] as const) {
    const routing = routeWithRecords(
      ["succeeded"],
      [...acceptedDeliveryRecords(), deliveryTerminalRecord(terminal)],
    );
    assert.equal(routing.selected.route_id, terminal === "completion" ? "WF-ROUTE-014" : "WF-ROUTE-010");
    assert.equal(routing.selected.consumer, terminal === "completion" ? "park" : "delivery_finalizer");
    assert.equal(routing.matches.some(({ route_id }) => route_id === "WF-ROUTE-008"), false);
  }
});

test("Root Done with a valid delivery invalidation is cleanup-ready, while a gap is not", () => {
  const invalidated = routeWithRecords(
    ["succeeded"],
    [...acceptedDeliveryRecords(), deliveryTerminalRecord("invalidation")],
    { rootStatus: rootStates.done },
  );
  assert.equal(invalidated.selected.route_id, "WF-ROUTE-013");

  const gap = routeWithRecords(["succeeded"], acceptedDeliveryRecords(), { rootStatus: rootStates.done });
  assert.equal(gap.selected.route_id, "WF-ROUTE-012");
});

test("a Root projected Failed is parked and cannot re-enter semantic or delivery work", () => {
  const routing = route([], { rootStatus: rootStates.failed });

  assert.deepEqual(routing.matches.map(({ route_id, consumer }) => [route_id, consumer]), [
    ["WF-ROUTE-014", "park"],
  ]);
});

test("external terminal Cycle routing requires external status-origin evidence", () => {
  const change: ConcreteTaskChange = {
    kind: "field_changed",
    issue_id: parseTaskIssueId("cycle-1"),
    field: "status",
    before: workflow.cycle_states.in_progress,
    after: workflow.cycle_states.failed,
  };

  for (const origin of [undefined, "symphony", "unknown"] as const) {
    const routing = route(
      ["failed"],
      {},
      [change],
      origin === undefined ? [] : [{
        issue_id: parseTaskIssueId("cycle-1"),
        change_origin: origin,
        changed_fields: ["status"],
      }],
    );
    assert.equal(routing.matches.some(({ route_id }) => route_id === "WF-ROUTE-018"), false);
    assert.equal(routing.selected.route_id, "WF-ROUTE-008");
  }

  const external = route(["failed"], {}, [change], [{
    issue_id: parseTaskIssueId("cycle-1"),
    change_origin: "external",
    changed_fields: ["status"],
  }]);
  assert.equal(external.selected.route_id, "WF-ROUTE-018");
});

test("restart routes an externally terminal Cycle from fresh history without notification changes", () => {
  const routing = route(["failed"], {
    issueHistory: [{
      history_id: "history:cycle-terminal",
      issue_id: "cycle-1",
      provider_created_at: "2026-08-03T00:00:01.000Z",
      provider_updated_at: "2026-08-03T00:00:01.000Z",
      actor_id: "actor:external",
      change_origin: "external",
      changed_fields: ["status"],
      from_status: "In Progress",
      to_status: "Failed",
      from_parent_issue_id: "root-1",
      to_parent_issue_id: "root-1",
      added_label_ids: [],
      removed_label_ids: [],
      archived: null,
      trashed: null,
      relation_changes: [],
    }],
  });

  assert.deepEqual(routing.matches.map(({ route_id }) => route_id), ["WF-ROUTE-018", "WF-ROUTE-008"]);
  assert.equal(routing.selected.route_id, "WF-ROUTE-018");
});
