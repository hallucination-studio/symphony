import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  parseCorrelationId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseTaskIssueId,
  parseTaskRevision,
} from "../contracts/identity.js";
import { deriveCycleUuid } from "../contracts/cycle-identities.js";
import { prepareCycleApproval } from "../cycle/internal/CycleApproval.js";
import {
  parseRootDefinition,
} from "../contracts/cycle.js";
import {
  canonicalTaskRevision,
  parseTaskIssueSnapshotChange,
  parseTaskRelationSnapshot,
  parseTaskSnapshot,
  type TaskIssueSnapshot,
  type TaskKind,
  type TaskRelationSnapshot,
  type TaskSnapshot,
  type TaskWorkflowStatus,
} from "../contracts/task-management.js";
import type { TaskManageCommandInterface } from "../task-management/api/TaskManageCommandInterface.js";
import {
  createTaskManageCallerAuthority,
  parseTaskWorkflowIdentities,
} from "../task-management/api/TaskManageCapability.js";
import {
  TASK_MCP_CAPABILITIES,
  TASK_MCP_FUNCTIONS,
  parseTaskMcpResult,
} from "../task-management/mcp/TaskMcpSchemas.js";
import {
  RootTools,
  type DeclaredRootTool,
} from "./RootTools.js";
import {
  bindRootTaskManageCommand,
  type RootTaskManageCommandBinding,
} from "./RootTaskManageCommand.js";
import { createAcceptedRevisionAuthority } from "./RootAcceptedRevision.js";
import { RootToolCallError, RootToolFatalError } from "./RootToolBoundary.js";

const rootId = parseRootIssueId("LIN-1");
const identityVersion = "symphony-identity:v1";
const cycleTaskId = parseTaskIssueId(deriveCycleUuid(
  identityVersion, "cycle_issue", rootId, "first_cycle", "first_cycle",
));
const derivedCycleId = (kind: string) => deriveCycleUuid(identityVersion, kind, cycleTaskId);
const generation = parseRuntimeGeneration(3);
const correlationId = parseCorrelationId("corr:turn:1");
const callerAuthority = createTaskManageCallerAuthority();
const acceptedRevisionAuthority = createAcceptedRevisionAuthority();
const recordComments = new WeakMap<TaskManageCommandInterface, Array<{
  readonly comment_id: string;
  readonly issue_id: ReturnType<typeof parseTaskIssueId>;
  readonly provider_created_at: string;
  readonly provider_updated_at: string;
  readonly provider_edited_at: null;
  readonly provider_archived_at: null;
  readonly actor_id: string;
  readonly body_markdown: string;
  readonly body_digest: string;
}>>();
const workflow = parseTaskWorkflowIdentities({
  labels: {
    root: "label:root", cycle: "label:cycle", plan: "label:plan",
    work: "label:work", verify: "label:verify",
  },
  cycle_states: {
    draft: "state:draft", in_progress: "state:cycle-in-progress",
    awaiting_acceptance: "state:awaiting-acceptance", succeeded: "state:succeeded",
    rejected: "state:rejected", failed: "state:cycle-failed", canceled: "state:cycle-canceled",
  },
  stage_states: {
    todo: "state:stage-todo", in_progress: "state:stage-in-progress", done: "state:stage-done",
    failed: "state:stage-failed", canceled: "state:stage-canceled",
  },
});
const workflowStateFields = {
  team_id: "team:root-tools",
  todo_state_id: "state:todo",
  draft_state_id: workflow.cycle_states.draft,
  in_progress_state_id: workflow.cycle_states.in_progress,
  awaiting_acceptance_state_id: workflow.cycle_states.awaiting_acceptance,
  in_review_state_id: "state:in-review",
  done_state_id: "state:done",
  succeeded_state_id: workflow.cycle_states.succeeded,
  rejected_state_id: workflow.cycle_states.rejected,
  failed_state_id: workflow.cycle_states.failed,
  canceled_state_id: workflow.cycle_states.canceled,
} as const;

interface TaskIssueFixtureFields {
  readonly issue_id: string;
  readonly kind: TaskKind;
  readonly status_id: string;
  readonly status: TaskWorkflowStatus;
  readonly title: string;
  readonly description_markdown: string;
  readonly parent_issue_id: string | null;
  readonly label_ids: readonly string[];
  readonly delegate_id: string | null;
  readonly priority: number | null;
  readonly provider_created_at?: string;
  readonly provider_updated_at?: string;
  readonly creation_actor_id?: string;
  readonly archived?: boolean;
  readonly trashed?: boolean;
}

function taskIssueResource(input: TaskIssueFixtureFields): TaskIssueSnapshot {
  const fields = {
    ...input,
    provider_created_at: input.provider_created_at ?? "2026-08-01T00:00:00.000Z",
    provider_updated_at: input.provider_updated_at ?? input.provider_created_at ?? "2026-08-01T00:00:00.000Z",
    creation_actor_id: input.creation_actor_id ?? "actor:symphony",
    archived: input.archived ?? false,
    trashed: input.trashed ?? false,
  };
  return parseTaskIssueSnapshotChange({
    ...fields,
    revision: canonicalTaskRevision(fields),
  });
}

function changedTaskIssueResource(
  current: TaskIssueSnapshot,
  changes: Partial<Omit<TaskIssueFixtureFields, "issue_id">>,
  providerUpdatedAt: string,
): TaskIssueSnapshot {
  const { revision: _revision, provider_updated_at: _providerUpdatedAt, ...unchanged } = current;
  void _revision;
  void _providerUpdatedAt;
  return taskIssueResource({
    ...unchanged,
    ...changes,
    provider_updated_at: providerUpdatedAt,
  });
}

function taskRelationResource(input: {
  readonly relation_id: string;
  readonly type: string;
  readonly source_issue_id: string;
  readonly target_issue_id: string;
  readonly provider_created_at?: string;
  readonly provider_updated_at?: string;
  readonly creation_actor_id?: string;
  readonly creation_evidence_id?: string;
}): TaskRelationSnapshot {
  const fields = {
    ...input,
    provider_created_at: input.provider_created_at ?? "2026-08-01T00:00:00.000Z",
    provider_updated_at: input.provider_updated_at ?? input.provider_created_at ?? "2026-08-01T00:00:00.000Z",
    creation_actor_id: input.creation_actor_id ?? "actor:symphony",
    creation_evidence_id: input.creation_evidence_id ?? `evidence:${input.relation_id}`,
  };
  return parseTaskRelationSnapshot({
    ...fields,
    revision: canonicalTaskRevision(fields),
  });
}

const rootDescription = [
  "# Root",
  "",
  "## Requirement",
  "",
  "Implement the Root semantic boundary.",
  "",
  "## Domain Knowledge",
  "",
  "Task Manager Markdown is durable fact.",
  "",
  "## Root ADR",
  "",
  "Seal one complete Cycle Draft before execution.",
  "",
  "## Acceptance",
  "",
  "Approval returns the digest of the fresh exact revision.",
].join("\n");

function rootIssueResource(issueId = "LIN-1", description = rootDescription): TaskIssueSnapshot {
  return taskIssueResource({
    issue_id: issueId,
    kind: "root",
    status_id: workflowStateFields.todo_state_id,
    status: "Todo",
    title: issueId,
    description_markdown: description,
    parent_issue_id: null,
    label_ids: [workflow.labels.root],
    delegate_id: null,
    priority: null,
  });
}

const canonicalRootRevision = rootIssueResource().revision;

const cycleDescription = [
  "# Cycle Draft",
  "",
  "## Root Definition Revision",
  "",
  `\`${canonicalRootRevision}\``,
  "",
  "## Requirement",
  "",
  "Implement the Root semantic boundary.",
  "",
  "## Domain Knowledge",
  "",
  "Task Manager Markdown is durable fact.",
  "",
  "## Root ADR",
  "",
  "Seal one complete Cycle Draft before execution.",
  "",
  "## Acceptance",
  "",
  "Approval returns the digest of the fresh exact revision.",
  "",
  "## Architecture",
  "",
  "Keep semantic approval in the Root boundary.",
  "",
  "## Feature Design",
  "",
  "Define, review, correct, and approve one Draft.",
  "",
  "## Code Design",
  "",
  "Derive the seal only from fresh read-back.",
  "",
  "## Boundaries",
  "",
  "Do not mutate approved Cycle content.",
  "",
  "## Acceptance Mapping",
  "",
  "### Execution Anchors", "",
  `- Cycle ID: \`${cycleTaskId}\``,
  "- Predecessor Cycle ID: None",
  "- Predecessor Terminal Record ID: `first_cycle`",
  `- Approval Record ID: \`${derivedCycleId("cycle_approval_record")}\``,
  `- Plan Issue ID: \`${derivedCycleId("plan_issue")}\``,
  `- Plan Completion Record ID: \`${derivedCycleId("plan_completion_record")}\``,
  `- Plan Invalidation Record ID: \`${derivedCycleId("plan_invalidation_record")}\``,
  `- Cycle Completion Record ID: \`${derivedCycleId("cycle_completion_record")}\``,
  `- Cycle Invalidation Record ID: \`${derivedCycleId("cycle_invalidation_record")}\``,
  `- Delivery Completion Record ID: \`${derivedCycleId("delivery_completion_record")}\``,
  `- Delivery Invalidation Record ID: \`${derivedCycleId("delivery_invalidation_record")}\``,
  `- Identity Derivation Version: \`${identityVersion}\``,
  `- Workspace Base Revision: \`${"3".repeat(64)}\``, "",
  "### Execution Directives", "", "#### Directive: `directive:approval`", "",
  "Implement exact approval persistence.", "", "##### Dependencies", "", "- None", "",
  "##### Acceptance Criteria", "", "- `acceptance:approval`", "",
  "### Approved Work Groups", "", "#### Work Group: `group:approval`", "",
  "##### Directives", "", "- `directive:approval`", "", "##### Dependencies", "", "- None", "",
  "### Verification Directives", "", "#### Verification Directive: `verify:approval`", "",
  "Verify exact approval persistence.", "", "##### Acceptance Criteria", "", "- `acceptance:approval`",
  "",
  "## Failure Strategy",
  "",
  "Reject malformed, stale, or substituted facts.",
].join("\n");

function cycleIssueResource(
  description = cycleDescription,
  status: TaskWorkflowStatus = "Draft",
  statusId = workflow.cycle_states.draft,
  providerUpdatedAt?: string,
): TaskIssueSnapshot {
  return taskIssueResource({
    issue_id: cycleTaskId,
    kind: "cycle",
    status_id: statusId,
    status,
    title: cycleTaskId,
    description_markdown: description,
    parent_issue_id: rootId,
    label_ids: [workflow.labels.cycle],
    delegate_id: null,
    priority: null,
    ...(providerUpdatedAt === undefined ? {} : { provider_updated_at: providerUpdatedAt }),
  });
}

const canonicalDraftRevision = cycleIssueResource().revision;
const correctedCycleDescription = cycleDescription.replace(
  "Derive the seal only from fresh read-back.",
  "Derive and return the seal only from fresh read-back.",
);
const correctedDraftResource = cycleIssueResource(
  correctedCycleDescription,
  "Draft",
  workflow.cycle_states.draft,
  "2026-08-01T00:00:01.000Z",
);
const sealedDraftResource = cycleIssueResource(
  cycleDescription,
  "In Progress",
  workflow.cycle_states.in_progress,
  "2026-08-01T00:00:02.000Z",
);

function rootTaskSnapshot(
  relations: readonly TaskRelationSnapshot[] = [
    taskRelationResource({
      relation_id: "REL-1",
      type: "blocks",
      source_issue_id: cycleTaskId,
      target_issue_id: "LIN-3",
    }),
    taskRelationResource({
      relation_id: "REL-OTHER",
      type: "blocks",
      source_issue_id: cycleTaskId,
      target_issue_id: "LIN-4",
    }),
  ],
  includeCycle = true,
): TaskSnapshot {
  const issues = [
    rootIssueResource(),
    cycleIssueResource(),
    taskIssueResource({
      issue_id: "LIN-3",
      kind: "cycle",
      status_id: workflow.cycle_states.succeeded,
      status: "Succeeded",
      title: "LIN-3",
      description_markdown: "## LIN-3\n\nFixture facts.",
      parent_issue_id: rootId,
      label_ids: [workflow.labels.cycle],
      delegate_id: null,
      priority: null,
    }),
    taskIssueResource({
      issue_id: "LIN-4",
      kind: "cycle",
      status_id: workflow.cycle_states.rejected,
      status: "Rejected",
      title: "LIN-4",
      description_markdown: "## LIN-4\n\nFixture facts.",
      parent_issue_id: rootId,
      label_ids: [workflow.labels.cycle],
      delegate_id: null,
      priority: null,
    }),
  ];
  return parseTaskSnapshot({
    root_id: rootId,
    workflow_state_map: {
      ...workflowStateFields,
      revision: canonicalTaskRevision(workflowStateFields),
    },
    issues: includeCycle ? issues : [issues[0]],
    relations: includeCycle ? relations : [],
    resource_creation_evidence: [],
    issue_history: [],
    issue_record_observations: [],
  });
}

function bindTaskManager(
  manager: TaskManageCommandInterface,
  readRootSnapshot: () => Promise<TaskSnapshot> = async () => rootTaskSnapshot(),
): RootTaskManageCommandBinding {
  return bindRootTaskManageCommand({
    target: { root_id: rootId, runtime_generation: generation },
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: manager,
    snapshot_reader: { readRootSnapshot },
    record_reader: { readIssueRecordComments: async (issueId) => (
      recordComments.get(manager)?.filter(({ issue_id }) => issue_id === issueId) ?? []
    ) },
    service_actor_id: "actor:symphony",
    approved_cycle_reader: { readApprovedCycle: async () => null },
    accepted_revision_issuer: acceptedRevisionAuthority.issuer,
  });
}

function taskManager(calls: string[]): TaskManageCommandInterface {
  const unexpected = (name: string) => () => Promise.reject(new Error(`unexpected_${name}`));
  const manager = {
    get_issue: async (call) => {
      calls.push(call.function);
      return {
        schema_version: 1,
        function: call.function,
        root_id: call.root_id,
        runtime_generation: call.runtime_generation,
        correlation_id: call.correlation_id,
        capability: call.capability,
        output: { issue: null },
      };
    },
    list_issues: unexpected("list_issues"),
    list_children: unexpected("list_children"),
    create_issue: unexpected("create_issue"),
    update_issue: unexpected("update_issue"),
    archive_issue: unexpected("archive_issue"),
    list_relations: unexpected("list_relations"),
    create_relation: unexpected("create_relation"),
    delete_relation: unexpected("delete_relation"),
    list_states: unexpected("list_states"),
    list_labels: unexpected("list_labels"),
  } as TaskManageCommandInterface;
  const comments: NonNullable<ReturnType<typeof recordComments.get>> = [];
  recordComments.set(manager, comments);
  manager.create_issue_comment = async (call) => {
    calls.push(call.function);
    const createdAt = "2026-08-02T01:00:00.000Z";
    const comment = Object.freeze({
      comment_id: call.input.comment_id,
      issue_id: call.input.issue_id,
      provider_created_at: createdAt,
      provider_updated_at: createdAt,
      provider_edited_at: null,
      provider_archived_at: null,
      actor_id: "actor:symphony",
      body_markdown: call.input.body_markdown,
      body_digest: createHash("sha256").update(call.input.body_markdown, "utf8").digest("hex"),
    });
    comments.push(comment);
    const freshComment = Object.freeze({
      comment_id: comment.comment_id,
      issue_id: comment.issue_id,
      provider_created_at: comment.provider_created_at,
      provider_updated_at: comment.provider_updated_at,
      provider_edited_at: comment.provider_edited_at,
      provider_archived_at: comment.provider_archived_at,
      actor_id: comment.actor_id,
      body_digest: comment.body_digest,
    });
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome: "applied",
        effect_may_have_occurred: true,
        target: { kind: "comment", comment_id: comment.comment_id, issue_id: comment.issue_id },
        fresh_comment: freshComment,
        sanitized_reason: null,
      },
    }, call);
  };
  return manager;
}

function serveSnapshotIssues(
  manager: TaskManageCommandInterface,
  readSnapshot: () => TaskSnapshot = () => rootTaskSnapshot(),
  observe: (issueId: string) => void = () => undefined,
): void {
  manager.get_issue = async (call) => {
    observe(call.input.issue_id);
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        issue: readSnapshot().issues.find(({ issue_id }) => issue_id === call.input.issue_id) ?? null,
      },
    }, call);
  };
}

function expectedApprovalSeal(): string {
  const definitionTarget = Object.freeze({
    root_id: rootId,
    root_revision: parseTaskRevision(canonicalRootRevision),
    correlation_id: correlationId,
  });
  const definition = parseRootDefinition({
    schema_version: 1,
    ...definitionTarget,
    root_description_markdown: rootDescription,
  }, definitionTarget);
  return prepareCycleApproval({
    root_id: rootId,
    cycle_id: cycleTaskId,
    cycle_revision: parseTaskRevision(canonicalDraftRevision),
    cycle_status: "Draft",
    cycle_description_markdown: cycleDescription,
    root_definition: definition,
  }).specification.specification_seal_digest!;
}

function getIssueCall(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    function: "get_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.get_issue,
    input: { issue_id: cycleTaskId },
    ...overrides,
  };
}

function updateIssueCall(issueId: string, expectedRevision: string): Record<string, unknown> {
  return {
    schema_version: 1,
    function: "update_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.update_issue,
    input: {
      issue_id: issueId,
      expected_revision: expectedRevision,
      desired: {
        description: issueId === "LIN-1" ? `${rootDescription}\n` : correctedCycleDescription,
      },
    },
  };
}

function archiveIssueCall(issueId: string): Record<string, unknown> {
  return {
    schema_version: 1,
    function: "archive_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.archive_issue,
    input: { issue_id: issueId, expected_revision: canonicalDraftRevision },
  };
}

function createIssueCall(expectedParentRevision: string): Record<string, unknown> {
  return {
    schema_version: 1,
    function: "create_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.create_issue,
    input: {
      issue_id: "11111111-1111-4111-8111-111111111111",
      parent_issue_id: "LIN-1",
      expected_parent_revision: expectedParentRevision,
      desired: {
        title: "Created issue",
        description: cycleDescription,
        state_id: workflow.cycle_states.draft,
        label_ids: [workflow.labels.cycle],
        delegate_id: null,
        priority: null,
      },
    },
  };
}

function createRelationCall(expectedSourceRevision: string): Record<string, unknown> {
  return {
    schema_version: 1,
    function: "create_relation",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.create_relation,
    input: {
      relation_id: "22222222-2222-4222-8222-222222222222",
      relation_type: "blocks",
      source_issue_id: cycleTaskId,
      expected_source_revision: expectedSourceRevision,
      target_issue_id: "LIN-3",
      expected_target_revision: "revision:target:1",
    },
  };
}

function deleteRelationCall(): Record<string, unknown> {
  return {
    schema_version: 1,
    function: "delete_relation",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.delete_relation,
    input: {
      relation_id: "REL-1",
      expected_relation_revision: "revision:relation:1",
      source_issue_id: cycleTaskId,
      expected_source_revision: "revision:source:1",
      target_issue_id: "LIN-3",
      expected_target_revision: "revision:target:1",
    },
  };
}

function listRelationsCall(issueId: string, cursor: string | null, pageSize = 32): Record<string, unknown> {
  return {
    schema_version: 1,
    function: "list_relations",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.list_relations,
    input: { issue_id: issueId, cursor, page_size: pageSize },
  };
}

function isAcceptanceUnknown(error: unknown): boolean {
  return error instanceof RootToolCallError && error.code === "acceptance_unknown";
}

function declaredReadTool(
  family: "git" | "delivery",
  name: "get_status" | "get_remote_ref",
  calls: string[],
): DeclaredRootTool<Record<string, unknown>, { readonly outcome: "completed" }> {
  const capability = `${family}:${name}` as const;
  return {
    family,
    capability,
    spec: {
      type: "function",
      name,
      description: "Read one typed boundary fact",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["schema_version", "root_id", "runtime_generation", "correlation_id", "capability"],
      },
    },
    parseCall: (value) => value as Record<string, unknown>,
    execute: (call) => {
      calls.push(String(call.capability));
      return Promise.resolve({ outcome: "completed" });
    },
    parseResult: (value) => {
      if ((value as { outcome?: unknown }).outcome !== "completed") throw new Error("invalid_plan_result");
      return Object.freeze({ outcome: "completed" as const });
    },
  };
}

test("Root tools expose only capability-approved generic schemas", () => {
  const calls: string[] = [];
  const git = declaredReadTool("git", "get_status", calls);
  const delivery = declaredReadTool("delivery", "get_remote_ref", calls);
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [
      TASK_MCP_CAPABILITIES.get_issue,
      "git:get_status",
      "delivery:get_remote_ref",
    ],
    task_manager: bindTaskManager(taskManager(calls)),
    declared_tools: [git, delivery],
  });

  assert.deepEqual(tools.specs.map(({ name }) => name), [
    "get_issue", "get_status", "get_remote_ref",
  ]);
  const getIssueSchema = tools.specs[0]?.inputSchema as {
    properties?: Record<string, { const?: unknown }>;
  };
  assert.equal(getIssueSchema.properties?.root_id?.const, rootId);
  assert.equal(getIssueSchema.properties?.runtime_generation?.const, generation);
  assert.equal(getIssueSchema.properties?.capability?.const, TASK_MCP_CAPABILITIES.get_issue);
  const surface = JSON.stringify(tools.specs).toLowerCase();
  for (const forbidden of ["linear", "shell", "sdk", "lifecycle", "credential", "authorization"]) {
    assert.equal(surface.includes(forbidden), false, forbidden);
  }
});

test("Root tools generate every generic Task MCP schema with an exact bound function and capability", () => {
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: TASK_MCP_FUNCTIONS.map((functionName) => TASK_MCP_CAPABILITIES[functionName]),
    task_manager: bindTaskManager(taskManager([])),
  });
  assert.deepEqual(tools.specs.map(({ name }) => name), TASK_MCP_FUNCTIONS);
  for (const spec of tools.specs) {
    const schema = spec.inputSchema as {
      additionalProperties?: unknown;
      properties?: Record<string, { const?: unknown }>;
    };
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties?.function?.const, spec.name);
    assert.equal(
      schema.properties?.capability?.const,
      TASK_MCP_CAPABILITIES[spec.name as keyof typeof TASK_MCP_CAPABILITIES],
    );
  }

  const createIssue = tools.specs.find(({ name }) => name === "create_issue");
  assert.ok(createIssue);
  const inputSchema = (createIssue.inputSchema as {
    properties: Record<string, { properties?: Record<string, unknown> }>;
  }).properties.input;
  assert.ok(inputSchema);
  const createInput = inputSchema.properties as Record<string, {
    enum?: unknown;
    type?: unknown;
    pattern?: unknown;
    minItems?: unknown;
    maxItems?: unknown;
    items?: { enum?: unknown };
    properties?: Record<string, {
      enum?: unknown;
      type?: unknown;
      minItems?: unknown;
      maxItems?: unknown;
      items?: { enum?: unknown };
    }>;
  }>;
  assert.equal(createInput.issue_id?.type, "string");
  assert.match(
    "11111111-1111-4111-8111-111111111111",
    new RegExp(String(createInput.issue_id?.pattern), "u"),
  );
  assert.deepEqual(createInput.parent_issue_id?.enum, [rootId]);
  const desired = createInput.desired?.properties;
  assert.equal(desired?.description?.type, "string");
  assert.deepEqual(desired?.state_id?.enum, [workflow.cycle_states.draft]);
  assert.equal(desired?.label_ids?.minItems, 1);
  assert.equal(desired?.label_ids?.maxItems, 1);
  assert.deepEqual(desired?.label_ids?.items?.enum, [workflow.labels.cycle]);
  assert.deepEqual(desired?.delegate_id?.enum, [null]);
  assert.deepEqual(desired?.priority?.enum, [null]);

  const createRelation = tools.specs.find(({ name }) => name === "create_relation");
  assert.ok(createRelation);
  const relationInput = (createRelation.inputSchema as {
    properties: Record<string, { properties?: Record<string, { type?: unknown; pattern?: unknown }> }>;
  }).properties.input?.properties;
  assert.equal(relationInput?.relation_id?.type, "string");
  assert.match(
    "22222222-2222-4222-8222-222222222222",
    new RegExp(String(relationInput?.relation_id?.pattern), "u"),
  );
});

test("Root tools dispatch a typed Task MCP result after all identity fences pass", async () => {
  const calls: string[] = [];
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue],
    task_manager: bindTaskManager(taskManager(calls)),
  });
  const binding = tools.bindings(correlationId)[0];
  assert.ok(binding);
  const result = await binding.execute(getIssueCall(), { assertActive: () => undefined });

  assert.deepEqual(calls, ["get_issue"]);
  assert.deepEqual(result, {
    schema_version: 1,
    function: "get_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.get_issue,
    output: { issue: null },
  });
  assert.equal(Object.isFrozen(result), true);
});

test("Root tools reject a get_issue result for a different identity as a fatal contract violation", async () => {
  const manager = taskManager([]);
  manager.get_issue = async (call) => parseTaskMcpResult({
    schema_version: 1,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
    output: {
      issue: taskIssueResource({
        issue_id: "LIN-3",
        kind: "cycle",
        status_id: workflowStateFields.todo_state_id,
        status: "Todo",
        title: "Foreign issue",
        description_markdown: "## Foreign\n\nFixture facts.",
        parent_issue_id: null,
        label_ids: [],
        delegate_id: null,
        priority: null,
      }),
    },
  }, call);
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue],
    task_manager: bindTaskManager(manager),
  });
  const read = tools.bindings(correlationId)[0];
  assert.ok(read);

  await assert.rejects(
    read.execute(getIssueCall(), { assertActive: () => undefined }),
    (error: unknown) => error instanceof RootToolFatalError && error.code === "invalid_contract",
  );
});

test("Root tools return a typed mutation result with fresh resource and concrete read-back diff", async () => {
  const calls: string[] = [];
  const manager = taskManager(calls);
  serveSnapshotIssues(manager, undefined, () => calls.push("get_issue"));
  manager.update_issue = async (call) => {
    calls.push(call.function);
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome: "applied",
        effect_may_have_occurred: true,
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: correctedDraftResource,
        concrete_diff: [{
          kind: "field_changed",
          issue_id: call.input.issue_id,
          field: "description",
          before: cycleDescription,
          after: correctedCycleDescription,
        }],
        sanitized_reason: null,
      },
    }, call);
  };
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue, TASK_MCP_CAPABILITIES.update_issue],
    task_manager: bindTaskManager(manager),
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const read = bindings.get("get_issue");
  const update = bindings.get("update_issue");
  assert.ok(read);
  assert.ok(update);
  await read.execute(getIssueCall(), { assertActive: () => undefined });
  const result = await update.execute({
    schema_version: 1,
    function: "update_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.update_issue,
    input: {
      issue_id: cycleTaskId,
      expected_revision: canonicalDraftRevision,
      desired: { description: correctedCycleDescription },
    },
  }, { assertActive: () => undefined });

  assert.deepEqual(calls, ["get_issue", "update_issue"]);
  assert.equal((result as { output?: { outcome?: unknown } }).output?.outcome, "applied");
  assert.deepEqual((result as { output?: { fresh_resource?: unknown } }).output?.fresh_resource, correctedDraftResource);
  assert.deepEqual((result as { output?: { concrete_diff?: unknown } }).output?.concrete_diff, [{
    kind: "field_changed",
    issue_id: cycleTaskId,
    field: "description",
    before: cycleDescription,
    after: correctedCycleDescription,
  }]);
  assert.equal((result as { seal_digest?: unknown }).seal_digest, null);
  assert.equal(Object.isFrozen(result), true);
});

test("Root tools return a seal digest only from an applied approval fresh read-back", async () => {
  let currentTask = rootTaskSnapshot([], true);
  const manager = taskManager([]);
  serveSnapshotIssues(manager, () => currentTask);
  manager.update_issue = async (call) => {
    const approved = sealedDraftResource;
    currentTask = parseTaskSnapshot({
      ...currentTask,
      issues: currentTask.issues.map((issue) => issue.issue_id === approved.issue_id ? approved : issue),
    });
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome: "applied",
        effect_may_have_occurred: true,
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: approved,
        concrete_diff: [{
          kind: "field_changed",
          issue_id: call.input.issue_id,
          field: "status",
          before: workflow.cycle_states.draft,
          after: workflow.cycle_states.in_progress,
        }],
        sanitized_reason: null,
      },
    }, call);
  };
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue, TASK_MCP_CAPABILITIES.update_issue],
    task_manager: bindTaskManager(manager, async () => currentTask),
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const read = bindings.get("get_issue");
  const approve = bindings.get("update_issue");
  assert.ok(read);
  assert.ok(approve);
  await read.execute(getIssueCall(), { assertActive: () => undefined });

  const result = await approve.execute({
    schema_version: 1,
    function: "update_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.update_issue,
    input: {
      issue_id: cycleTaskId,
      expected_revision: canonicalDraftRevision,
      desired: { state_id: workflow.cycle_states.in_progress },
    },
  }, { assertActive: () => undefined });

  assert.equal(
    (result as { seal_digest?: unknown }).seal_digest,
    expectedApprovalSeal(),
  );
  assert.equal(
    (result as { output?: { fresh_resource?: { revision?: unknown } } }).output?.fresh_resource?.revision,
    sealedDraftResource.revision,
  );
});

test("Root tools do not return a seal for a stale approval precondition", async () => {
  const manager = taskManager([]);
  serveSnapshotIssues(manager);
  manager.update_issue = async (call) => parseTaskMcpResult({
    schema_version: 1,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
    output: {
      outcome: "stale_before_effect",
      effect_may_have_occurred: false,
      target: { kind: "issue", issue_id: call.input.issue_id },
      fresh_resource: correctedDraftResource,
      concrete_diff: [{
        kind: "field_changed",
        issue_id: call.input.issue_id,
        field: "description",
        before: cycleDescription,
        after: correctedCycleDescription,
      }],
      sanitized_reason: "fresh_precondition_failed",
    },
  }, call);
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue, TASK_MCP_CAPABILITIES.update_issue],
    task_manager: bindTaskManager(manager),
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const read = bindings.get("get_issue");
  const approve = bindings.get("update_issue");
  assert.ok(read);
  assert.ok(approve);
  await read.execute(getIssueCall(), { assertActive: () => undefined });

  const result = await approve.execute({
    schema_version: 1,
    function: "update_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.update_issue,
    input: {
      issue_id: cycleTaskId,
      expected_revision: canonicalDraftRevision,
      desired: { state_id: workflow.cycle_states.in_progress },
    },
  }, { assertActive: () => undefined });

  assert.equal((result as { output?: { outcome?: unknown } }).output?.outcome, "stale_before_effect");
  assert.equal((result as { seal_digest?: unknown }).seal_digest, null);
});

test("an exact read resolves an unknown applied approval with the sealed fresh revision", async () => {
  let currentTask = rootTaskSnapshot([], true);
  let approvedRevision: string | undefined;
  const manager = taskManager([]);
  manager.update_issue = async (call) => {
    const before = currentTask.issues.find(({ issue_id }) => issue_id === call.input.issue_id);
    assert.ok(before);
    const approved = changedTaskIssueResource(before, {
      status_id: workflow.cycle_states.in_progress,
      status: "In Progress",
    }, "2026-08-01T00:00:03.000Z");
    approvedRevision = approved.revision;
    currentTask = parseTaskSnapshot({
      ...currentTask,
      issues: currentTask.issues.map((issue) => issue.issue_id === call.input.issue_id ? approved : issue),
    });
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome: "conflict_observed",
        effect_may_have_occurred: true,
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: "fresh_readback_unavailable",
      },
    }, call);
  };
  manager.get_issue = async (call) => parseTaskMcpResult({
    schema_version: 1,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
    output: {
      issue: currentTask.issues.find(({ issue_id }) => issue_id === call.input.issue_id) ?? null,
    },
  }, call);
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue, TASK_MCP_CAPABILITIES.update_issue],
    task_manager: bindTaskManager(manager, async () => currentTask),
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const approve = bindings.get("update_issue");
  const read = bindings.get("get_issue");
  assert.ok(approve);
  assert.ok(read);

  await read.execute(getIssueCall(), { assertActive: () => undefined });

  const unknown = await approve.execute({
    schema_version: 1,
    function: "update_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.update_issue,
    input: {
      issue_id: cycleTaskId,
      expected_revision: canonicalDraftRevision,
      desired: { state_id: workflow.cycle_states.in_progress },
    },
  }, { assertActive: () => undefined });
  assert.equal((unknown as { seal_digest?: unknown }).seal_digest, null);
  assert.equal(tools.hasPendingAcceptance(), true);

  const resolved = await read.execute(getIssueCall(), { assertActive: () => undefined });
  assert.equal(
    (resolved as { output?: { issue?: { revision?: unknown } } }).output?.issue?.revision,
    approvedRevision,
  );
  assert.equal(
    (resolved as { seal_digest?: unknown }).seal_digest,
    expectedApprovalSeal(),
  );
  assert.equal(tools.hasPendingAcceptance(), false);
});

test("conflict_observed blocks every mutation until get_issue reads the exact target", async () => {
  const effects: string[] = [];
  const manager = taskManager([]);
  let firstUnknown = true;
  manager.update_issue = async (call) => {
    effects.push(`update:${call.input.issue_id}`);
    const outcome = call.input.issue_id === cycleTaskId && firstUnknown
      ? "conflict_observed"
      : "not_applied";
    if (outcome === "conflict_observed") firstUnknown = false;
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome,
        effect_may_have_occurred: outcome === "conflict_observed",
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: outcome === "conflict_observed"
          ? "provider_acceptance_unknown"
          : "requested_state_not_applied",
      },
    }, call);
  };
  serveSnapshotIssues(manager, undefined, (issueId) => effects.push(`read:${issueId}`));
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [
      TASK_MCP_CAPABILITIES.get_issue,
      TASK_MCP_CAPABILITIES.update_issue,
      TASK_MCP_CAPABILITIES.archive_issue,
    ],
    task_manager: bindTaskManager(manager),
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const update = bindings.get("update_issue");
  const archive = bindings.get("archive_issue");
  const read = bindings.get("get_issue");
  assert.ok(update);
  assert.ok(archive);
  assert.ok(read);
  assert.equal(tools.hasPendingAcceptance(), false);

  await read.execute(getIssueCall(), { assertActive: () => undefined });

  const unknown = await update.execute(
    updateIssueCall(cycleTaskId, canonicalDraftRevision),
    { assertActive: () => undefined },
  );
  assert.equal((unknown as { output?: { outcome?: unknown } }).output?.outcome, "conflict_observed");
  assert.equal(tools.hasPendingAcceptance(), true);
  await assert.rejects(
    update.execute(updateIssueCall(cycleTaskId, canonicalDraftRevision), { assertActive: () => undefined }),
    isAcceptanceUnknown,
  );
  await assert.rejects(
    update.execute(updateIssueCall("LIN-1", canonicalRootRevision), { assertActive: () => undefined }),
    isAcceptanceUnknown,
  );
  await assert.rejects(
    archive.execute(archiveIssueCall("LIN-3"), { assertActive: () => undefined }),
    isAcceptanceUnknown,
  );
  await read.execute(getIssueCall({ input: { issue_id: "LIN-3" } }), { assertActive: () => undefined });
  await assert.rejects(
    update.execute(updateIssueCall("LIN-1", canonicalRootRevision), { assertActive: () => undefined }),
    isAcceptanceUnknown,
  );
  assert.equal(tools.hasPendingAcceptance(), true);

  await read.execute(getIssueCall(), { assertActive: () => undefined });
  assert.equal(tools.hasPendingAcceptance(), false);
  await update.execute(updateIssueCall(cycleTaskId, canonicalDraftRevision), { assertActive: () => undefined });
  assert.deepEqual(effects, [
    `read:${cycleTaskId}`,
    `update:${cycleTaskId}`,
    "read:LIN-3",
    `read:${cycleTaskId}`,
    `update:${cycleTaskId}`,
  ]);
});

test("conflict_observed blocks every declared tool while an exact Task mutation is unresolved", async () => {
  const effects: string[] = [];
  const manager = taskManager([]);
  serveSnapshotIssues(manager, undefined, (issueId) => effects.push(`read:${issueId}`));
  manager.update_issue = async (call) => {
    effects.push(`update:${call.input.issue_id}`);
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome: "conflict_observed",
        effect_may_have_occurred: true,
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: "provider_acceptance_unknown",
      },
    }, call);
  };
  const git = declaredReadTool("git", "get_status", effects);
  const delivery = declaredReadTool("delivery", "get_remote_ref", effects);
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [
      TASK_MCP_CAPABILITIES.get_issue,
      TASK_MCP_CAPABILITIES.update_issue,
      "git:get_status",
      "delivery:get_remote_ref",
    ],
    task_manager: bindTaskManager(manager),
    declared_tools: [git, delivery],
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const read = bindings.get("get_issue");
  const update = bindings.get("update_issue");
  assert.ok(read);
  assert.ok(update);
  await read.execute(getIssueCall(), { assertActive: () => undefined });
  await update.execute(updateIssueCall(cycleTaskId, canonicalDraftRevision), { assertActive: () => undefined });

  for (const name of ["get_status", "get_remote_ref"]) {
    const binding = bindings.get(name);
    assert.ok(binding);
    await assert.rejects(binding.execute({
      schema_version: 1,
      root_id: rootId,
      runtime_generation: generation,
      correlation_id: correlationId,
      capability: binding.spec.name === "get_status"
          ? "git:get_status"
          : "delivery:get_remote_ref",
    }, { assertActive: () => undefined }), isAcceptanceUnknown);
  }
  assert.deepEqual(effects, [`read:${cycleTaskId}`, `update:${cycleTaskId}`]);
});

test("conflict_observed from create_issue blocks create retries until the caller identity is read", async () => {
  const effects: string[] = [];
  const manager = taskManager([]);
  let creations = 0;
  manager.create_issue = async (call) => {
    creations += 1;
    effects.push(`create:${creations}`);
    const outcome = creations === 1 ? "conflict_observed" : "not_applied";
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome,
        effect_may_have_occurred: outcome === "conflict_observed",
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: outcome === "conflict_observed"
          ? "provider_acceptance_unknown"
          : "requested_state_not_applied",
      },
    }, call);
  };
  manager.get_issue = async (call) => {
    effects.push(`read:${call.input.issue_id}`);
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: { issue: null },
    }, call);
  };
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue, TASK_MCP_CAPABILITIES.create_issue],
    task_manager: bindTaskManager(manager, async () => rootTaskSnapshot([], false)),
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const create = bindings.get("create_issue");
  const read = bindings.get("get_issue");
  assert.ok(create);
  assert.ok(read);

  await create.execute(createIssueCall(canonicalRootRevision), { assertActive: () => undefined });
  await assert.rejects(
    create.execute(createIssueCall(canonicalRootRevision), { assertActive: () => undefined }),
    isAcceptanceUnknown,
  );
  await read.execute(
    getIssueCall({ input: { issue_id: "11111111-1111-4111-8111-111111111111" } }),
    { assertActive: () => undefined },
  );
  await create.execute(createIssueCall(canonicalRootRevision), { assertActive: () => undefined });
  assert.deepEqual(effects, [
    "create:1",
    "read:11111111-1111-4111-8111-111111111111",
    "create:2",
  ]);
});

test("Root relation mutations are denied before provider effects", async () => {
  const effects: string[] = [];
  const manager = taskManager([]);
  let creations = 0;
  manager.create_relation = async (call) => {
    creations += 1;
    effects.push(`create:${creations}`);
    const outcome = creations <= 2 ? "conflict_observed" : "not_applied";
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome,
        effect_may_have_occurred: outcome === "conflict_observed",
        target: {
          kind: "relation",
          relation_id: call.input.relation_id,
          source_issue_id: call.input.source_issue_id,
          target_issue_id: call.input.target_issue_id,
        },
        fresh_resource: null,
        concrete_diff: [],
        sanitized_reason: outcome === "conflict_observed"
          ? "provider_acceptance_unknown"
          : "requested_state_not_applied",
      },
    }, call);
  };
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [
      TASK_MCP_CAPABILITIES.list_relations,
      TASK_MCP_CAPABILITIES.create_relation,
      TASK_MCP_CAPABILITIES.delete_relation,
    ],
    task_manager: bindTaskManager(manager, async () => rootTaskSnapshot(
      creations === 1
        ? [taskRelationResource({
          relation_id: "REL-1",
          type: "blocks",
          source_issue_id: cycleTaskId,
          target_issue_id: "LIN-3",
        })]
        : creations >= 2
          ? [taskRelationResource({
            relation_id: "REL-OTHER",
            type: "blocks",
            source_issue_id: cycleTaskId,
            target_issue_id: "LIN-4",
          })]
          : [],
    )),
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const create = bindings.get("create_relation");
  const remove = bindings.get("delete_relation");
  const read = bindings.get("list_relations");
  assert.ok(create);
  assert.ok(remove);
  assert.ok(read);

  for (const invoke of [
    () => create.execute(createRelationCall("revision:source:1"), { assertActive: () => undefined }),
    () => remove.execute(deleteRelationCall(), { assertActive: () => undefined }),
  ]) {
    await assert.rejects(
      invoke(),
      (error: unknown) => error instanceof RootToolCallError && error.code === "capability_denied",
    );
  }
  assert.equal(read.spec.name, "list_relations");
  assert.deepEqual(effects, []);
});

test("Root tools reject cross-Root, stale-generation, wrong-correlation, and capability substitution before effects", async () => {
  const cases = [
    [getIssueCall({ root_id: "LIN-9" }), /invalid_contract/u],
    [getIssueCall({ runtime_generation: generation + 1 }), /stale_generation/u],
    [getIssueCall({ correlation_id: "corr:other" }), /invalid_contract/u],
    [getIssueCall({ capability: "task_manage:update_issue" }), /capability_denied/u],
  ] as const;

  for (const [input, expected] of cases) {
    const calls: string[] = [];
    const tools = new RootTools({
      target: { root_id: rootId, runtime_generation: generation },
      capabilities: [TASK_MCP_CAPABILITIES.get_issue],
      task_manager: bindTaskManager(taskManager(calls)),
    });
    const binding = tools.bindings(correlationId)[0];
    assert.ok(binding);
    await assert.rejects(binding.execute(input, { assertActive: () => undefined }), expected);
    assert.deepEqual(calls, []);
  }
});

test("Root tools deny a same-team foreign Issue before the shared manager observes the call", async () => {
  const effects: string[] = [];
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue],
    task_manager: bindTaskManager(taskManager(effects)),
  });
  const read = tools.bindings(correlationId)[0];
  assert.ok(read);

  await assert.rejects(
    read.execute(
      getIssueCall({ input: { issue_id: "ROOT-B-ISSUE" } }),
      { assertActive: () => undefined },
    ),
    (error: unknown) => error instanceof RootToolCallError && error.code === "capability_denied",
  );
  assert.deepEqual(effects, []);
});

test("Root tools map a snapshot reader rejection to boundary_unavailable", async () => {
  const effects: string[] = [];
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue],
    task_manager: bindTaskManager(taskManager(effects), () => Promise.reject(new Error("snapshot_reader_failed"))),
  });
  const read = tools.bindings(correlationId)[0];
  assert.ok(read);

  await assert.rejects(
    read.execute(getIssueCall(), { assertActive: () => undefined }),
    (error: unknown) => error instanceof RootToolFatalError && error.code === "boundary_unavailable",
  );
  assert.deepEqual(effects, []);
});

test("Root tools fail composition closed for raw or differently bound Task managers", () => {
  assert.throws(() => new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue],
    task_manager: taskManager([]) as unknown as RootTaskManageCommandBinding,
  }), /unbound_root_task_manager/u);

  const otherRootId = parseRootIssueId("ROOT-B");
  const otherIssue = rootIssueResource(otherRootId);
  const otherSnapshot = parseTaskSnapshot({
    root_id: otherRootId,
    workflow_state_map: {
      ...workflowStateFields,
      revision: canonicalTaskRevision(workflowStateFields),
    },
    issues: [otherIssue],
    relations: [],
    resource_creation_evidence: [],
    issue_history: [],
    issue_record_observations: [],
  });
  const otherBinding = bindRootTaskManageCommand({
    target: { root_id: otherRootId, runtime_generation: generation },
    workflow,
    caller_issuer: callerAuthority.issuer,
    task_manager: taskManager([]),
    snapshot_reader: { readRootSnapshot: async () => otherSnapshot },
    record_reader: { readIssueRecordComments: async () => [] },
    service_actor_id: "actor:symphony",
    approved_cycle_reader: { readApprovedCycle: async () => null },
    accepted_revision_issuer: acceptedRevisionAuthority.issuer,
  });
  assert.throws(() => new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue],
    task_manager: otherBinding,
  }), /unbound_root_task_manager/u);
});

test("Root tools advertise and enforce 32-item relation pages so 100 relations fit the turn budget", async () => {
  const calls: string[] = [];
  const manager = taskManager(calls);
  manager.list_relations = async (call) => {
    calls.push(call.function);
    return {
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: { relations: rootTaskSnapshot().relations, next_cursor: null },
    };
  };
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.list_relations],
    task_manager: bindTaskManager(manager),
  });
  const binding = tools.bindings(correlationId)[0];
  assert.ok(binding);
  const schema = binding.spec.inputSchema as {
    properties?: { input?: { properties?: { page_size?: { const?: unknown } } } };
  };
  assert.equal(schema.properties?.input?.properties?.page_size?.const, 32);

  const page = await binding.execute(
    listRelationsCall(cycleTaskId, null, 32),
    { assertActive: () => undefined },
  ) as { output: { relations: readonly unknown[] } };
  assert.equal(page.output.relations.length, 2);

  await assert.rejects(binding.execute({
    schema_version: 1,
    function: "list_relations",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.list_relations,
    input: { issue_id: cycleTaskId, cursor: null, page_size: 1 },
  }, { assertActive: () => undefined }), /invalid_contract/u);
});

test("Root tools reject oversized typed mutation diffs as a fatal contract violation", async () => {
  const manager = taskManager([]);
  serveSnapshotIssues(manager);
  manager.update_issue = async (call) => ({
    schema_version: 1,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
    output: {
      outcome: "applied",
      effect_may_have_occurred: true,
      target: { kind: "issue", issue_id: call.input.issue_id },
      fresh_resource: null,
      concrete_diff: Array.from({ length: 9 }, (_, index) => ({
        kind: "field_changed",
        issue_id: call.input.issue_id,
        field: "description",
        before: `before-${index}`,
        after: `after-${index}`,
      })),
      sanitized_reason: null,
    },
  });
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue, TASK_MCP_CAPABILITIES.update_issue],
    task_manager: bindTaskManager(manager),
  });
  const bindings = new Map(tools.bindings(correlationId).map((binding) => [binding.spec.name, binding]));
  const read = bindings.get("get_issue");
  const update = bindings.get("update_issue");
  assert.ok(read);
  assert.ok(update);
  await read.execute(getIssueCall(), { assertActive: () => undefined });

  await assert.rejects(update.execute({
    schema_version: 1,
    function: "update_issue",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: TASK_MCP_CAPABILITIES.update_issue,
    input: {
      issue_id: cycleTaskId,
      expected_revision: canonicalDraftRevision,
      desired: { description: correctedCycleDescription },
    },
  }, { assertActive: () => undefined }), /invalid_contract/u);
});

test("Root tools retain typed read-only Git parsing while former execution and commit tools fail closed", async () => {
  const calls: string[] = [];
  const declaration = declaredReadTool("git", "get_status", calls);
  const tools = new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: ["git:get_status"],
    task_manager: bindTaskManager(taskManager(calls)),
    declared_tools: [declaration],
  });
  const binding = tools.bindings(correlationId)[0];
  assert.ok(binding);
  const result = await binding.execute({
    schema_version: 1,
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: correlationId,
    capability: "git:get_status",
  }, { assertActive: () => undefined });
  assert.deepEqual(result, { outcome: "completed" });
  assert.deepEqual(calls, ["git:get_status"]);

  for (const [family, name, capability] of [
    ["performer", "plan", "performer:plan"],
    ["performer", "work", "performer:work"],
    ["performer", "verify", "performer:verify"],
    ["git", "prepare_worktree", "git:prepare_worktree"],
    ["git", "create_commit", "git:create_commit"],
  ] as const) {
    const forbidden = {
      ...declaration,
      family,
      capability,
      spec: { ...declaration.spec, name },
    } as unknown as DeclaredRootTool<unknown, unknown>;
    assert.throws(() => new RootTools({
      target: { root_id: rootId, runtime_generation: generation },
      capabilities: [capability],
      task_manager: bindTaskManager(taskManager([])),
      declared_tools: [forbidden],
    }), /unapproved_root_tool/u, capability);
  }
});
