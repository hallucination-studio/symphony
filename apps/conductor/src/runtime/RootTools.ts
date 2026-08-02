import {
  parseCycleSealDigest,
  type CycleSealDigest,
} from "../contracts/cycle.js";
import {
  parseCorrelationId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseSchemaVersion,
  type CorrelationId,
} from "../contracts/identity.js";
import type { RuntimeTarget } from "../contracts/runtime.js";
import { asRecord, parseBoundedString } from "../contracts/validation.js";
import type { TaskManageBoundaryExecution } from "../task-management/api/TaskManageCommandInterface.js";
import {
  TASK_MCP_CAPABILITIES,
  TASK_MCP_FUNCTIONS,
  parseTaskMcpCall,
  parseTaskMcpResult,
  type TaskMcpCall,
  type TaskMcpFunction,
  type TaskMcpResult,
  type TaskMutationTarget,
} from "../task-management/mcp/TaskMcpSchemas.js";
import {
  bindRootTaskManageCommandCorrelation,
  isRootTaskManageCommandBinding,
  RootTaskManageBindingError,
  type RootGetIssueResult,
  type RootUpdateIssueResult,
  type RootTaskManageCommandBinding,
} from "./RootTaskManageCommand.js";
import {
  RootToolCallError,
  RootToolFatalError,
  parseRootAcceptanceView,
  type RootAcceptanceView,
  type RootToolBinding,
  type RootToolExecution,
  type RootToolSpec,
} from "./RootToolBoundary.js";

type DeclaredRootToolFamily = "git" | "delivery";

const APPROVED_DECLARED_TOOL_NAMES = Object.freeze({
  git: ["get_workspace", "get_status", "get_diff"],
  delivery: ["get_remote_ref", "push_revision", "list_pull_requests", "create_pull_request", "get_pull_request"],
} as const satisfies Record<DeclaredRootToolFamily, readonly string[]>);

export interface DeclaredRootTool<Call, Result> {
  readonly family: DeclaredRootToolFamily;
  readonly capability: `${DeclaredRootToolFamily}:${string}`;
  readonly spec: RootToolSpec;
  parseCall(value: unknown): Call;
  execute(call: Call, execution: RootToolExecution): Promise<unknown>;
  parseResult(value: unknown, call: Call): Result;
}

export interface RootToolsOptions {
  readonly target: RuntimeTarget;
  readonly capabilities: readonly string[];
  readonly task_manager: RootTaskManageCommandBinding;
  readonly declared_tools?: readonly DeclaredRootTool<unknown, unknown>[];
}

type JsonSchema = Record<string, unknown>;

const ROOT_TASK_PAGE_SIZE = 32;
const MAX_ROOT_TASK_CHANGES = 8;
const IDENTITY_SCHEMA = Object.freeze({ type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" });
const UUID_V4_SCHEMA = Object.freeze({
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
});
const NULLABLE_IDENTITY_SCHEMA = Object.freeze({ anyOf: [IDENTITY_SCHEMA, { type: "null" }] });
const NULLABLE_DELEGATE_SCHEMA = Object.freeze({
  anyOf: [{ type: "string", minLength: 1, maxLength: 256, pattern: "^[^\\r\\n\\u0000]+$" }, { type: "null" }],
});
const PAGE_PROPERTIES = Object.freeze({
  cursor: {
    anyOf: [{ type: "string", minLength: 1, maxLength: 512, pattern: "^[^\\r\\n\\u0000]+$" }, { type: "null" }],
  },
  page_size: { const: ROOT_TASK_PAGE_SIZE },
});

function objectSchema(properties: JsonSchema, required = Object.keys(properties), extra: JsonSchema = {}): JsonSchema {
  return { type: "object", additionalProperties: false, properties, required, ...extra };
}

function taskInputSchema(functionName: TaskMcpFunction): JsonSchema {
  switch (functionName) {
    case "get_issue": return objectSchema({ issue_id: IDENTITY_SCHEMA });
    case "list_issues":
    case "list_states":
    case "list_labels": return objectSchema(PAGE_PROPERTIES);
    case "list_children": return objectSchema({ parent_issue_id: IDENTITY_SCHEMA, ...PAGE_PROPERTIES });
    case "list_relations": return objectSchema({ issue_id: IDENTITY_SCHEMA, ...PAGE_PROPERTIES });
    case "create_issue": return objectSchema({
      issue_id: UUID_V4_SCHEMA,
      parent_issue_id: IDENTITY_SCHEMA,
      expected_parent_revision: IDENTITY_SCHEMA,
      desired: objectSchema({
        title: { type: "string", minLength: 1, maxLength: 1024, pattern: "^[^\\r\\n\\u0000]+$" },
        description: { anyOf: [{ type: "string", maxLength: 100_000, pattern: "^[^\\u0000]*$" }, { type: "null" }] },
        state_id: IDENTITY_SCHEMA,
        label_ids: { type: "array", maxItems: 256, uniqueItems: true, items: IDENTITY_SCHEMA },
        delegate_id: NULLABLE_DELEGATE_SCHEMA,
        priority: { anyOf: [{ type: "integer", minimum: 0, maximum: 100 }, { type: "null" }] },
      }),
    });
    case "update_issue": return objectSchema({
      issue_id: IDENTITY_SCHEMA,
      expected_revision: IDENTITY_SCHEMA,
      desired: objectSchema({
        title: { type: "string", minLength: 1, maxLength: 1024, pattern: "^[^\\r\\n\\u0000]+$" },
        description: { anyOf: [{ type: "string", maxLength: 100_000, pattern: "^[^\\u0000]*$" }, { type: "null" }] },
        state_id: IDENTITY_SCHEMA,
        parent_id: NULLABLE_IDENTITY_SCHEMA,
        label_ids: { type: "array", maxItems: 256, uniqueItems: true, items: IDENTITY_SCHEMA },
        delegate_id: NULLABLE_DELEGATE_SCHEMA,
        priority: { anyOf: [{ type: "integer", minimum: 0, maximum: 100 }, { type: "null" }] },
      }, [], { minProperties: 1 }),
    });
    case "archive_issue": return objectSchema({
      issue_id: IDENTITY_SCHEMA,
      expected_revision: IDENTITY_SCHEMA,
    });
    case "create_relation": return objectSchema({
      relation_id: UUID_V4_SCHEMA,
      relation_type: { type: "string", minLength: 1, maxLength: 128, pattern: "^[^\\r\\n\\u0000]+$" },
      source_issue_id: IDENTITY_SCHEMA,
      expected_source_revision: IDENTITY_SCHEMA,
      target_issue_id: IDENTITY_SCHEMA,
      expected_target_revision: IDENTITY_SCHEMA,
    });
    case "delete_relation": return objectSchema({
      relation_id: IDENTITY_SCHEMA,
      expected_relation_revision: IDENTITY_SCHEMA,
      source_issue_id: IDENTITY_SCHEMA,
      expected_source_revision: IDENTITY_SCHEMA,
      target_issue_id: IDENTITY_SCHEMA,
      expected_target_revision: IDENTITY_SCHEMA,
    });
  }
}

const TASK_DESCRIPTIONS = Object.freeze({
  get_issue: "Read one Task Manager issue by exact identity",
  list_issues: "List Task Manager issues with explicit cursor pagination",
  list_children: "List direct child issues with explicit cursor pagination",
  create_issue: "Create one issue using exact parent preconditions",
  update_issue: "Update approved fields on one exact issue revision",
  archive_issue: "Archive one exact issue revision",
  list_relations: "List relations for one issue with explicit cursor pagination",
  create_relation: "Create one relation using exact endpoint preconditions",
  delete_relation: "Delete one exact relation using endpoint preconditions",
  list_states: "List Task Manager states with explicit cursor pagination",
  list_labels: "List Task Manager labels with explicit cursor pagination",
} as const satisfies Record<TaskMcpFunction, string>);

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function commonProperties(target: RuntimeTarget, capability: string): JsonSchema {
  return {
    schema_version: { const: 1 },
    root_id: { const: target.root_id },
    runtime_generation: { const: target.runtime_generation },
    correlation_id: IDENTITY_SCHEMA,
    capability: { const: capability },
  };
}

function taskSpec(functionName: TaskMcpFunction, target: RuntimeTarget): RootToolSpec {
  const capability = TASK_MCP_CAPABILITIES[functionName];
  return deepFreeze({
    type: "function" as const,
    name: functionName,
    description: TASK_DESCRIPTIONS[functionName],
    inputSchema: objectSchema({
      ...commonProperties(target, capability),
      function: { const: functionName },
      input: taskInputSchema(functionName),
    }),
  });
}

function declaredSpec(
  declaration: DeclaredRootTool<unknown, unknown>,
  target: RuntimeTarget,
): RootToolSpec {
  const schema = structuredClone(declaration.spec.inputSchema);
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    throw new Error("invalid_declared_tool_schema");
  }
  const properties = schema.properties === undefined ? {} : asRecord(schema.properties);
  const required = Array.isArray(schema.required)
    ? schema.required.map((key) => parseBoundedString(key, "invalid_declared_tool_schema", 64))
    : [];
  const common = commonProperties(target, declaration.capability);
  return deepFreeze({
    type: "function" as const,
    name: declaration.spec.name,
    description: parseBoundedString(declaration.spec.description, "invalid_declared_tool_description", 1024),
    inputSchema: {
      ...schema,
      properties: { ...properties, ...common },
      required: [...new Set([...required, ...Object.keys(common)])],
    },
  });
}

function mapCallError(error: unknown): RootToolCallError {
  if (error instanceof RootToolCallError) return error;
  if (error instanceof Error && error.message === "stale_generation") {
    return new RootToolCallError("stale_generation");
  }
  if (error instanceof Error && error.message === "capability_mismatch") {
    return new RootToolCallError("capability_denied");
  }
  return new RootToolCallError("invalid_contract");
}

function assertEnvelope(
  value: unknown,
  expected: RuntimeTarget,
  correlationId: CorrelationId,
  capability: string,
): void {
  try {
    const record = asRecord(value);
    parseSchemaVersion(record.schema_version);
    if (parseRootIssueId(record.root_id) !== expected.root_id) throw new Error("runtime_root_mismatch");
    if (parseRuntimeGeneration(record.runtime_generation) !== expected.runtime_generation) {
      throw new Error("stale_generation");
    }
    if (parseCorrelationId(record.correlation_id) !== correlationId) throw new Error("correlation_mismatch");
    if (parseBoundedString(record.capability, "invalid_root_capability", 128) !== capability) {
      throw new Error("capability_mismatch");
    }
  } catch (error) {
    throw mapCallError(error);
  }
}

async function dispatchTask(
  taskManager: RootTaskManageCommandBinding,
  call: TaskMcpCall,
  execution: TaskManageBoundaryExecution,
): Promise<unknown> {
  switch (call.function) {
    case "get_issue": return taskManager.get_issue(call, execution);
    case "list_issues": return taskManager.list_issues(call, execution);
    case "list_children": return taskManager.list_children(call, execution);
    case "create_issue": return taskManager.create_issue(call, execution);
    case "update_issue": return taskManager.update_issue(call, execution);
    case "archive_issue": return taskManager.archive_issue(call, execution);
    case "list_relations": return taskManager.list_relations(call, execution);
    case "create_relation": return taskManager.create_relation(call, execution);
    case "delete_relation": return taskManager.delete_relation(call, execution);
    case "list_states": return taskManager.list_states(call, execution);
    case "list_labels": return taskManager.list_labels(call, execution);
  }
}

type RootTaskToolResult = TaskMcpResult | RootGetIssueResult | RootUpdateIssueResult;

function parseTaskResult(value: unknown, call: TaskMcpCall): RootTaskToolResult {
  let sealDigest: CycleSealDigest | null | undefined;
  let acceptanceView: RootAcceptanceView | null | undefined;
  let taskValue = value;
  if (call.function === "update_issue" || call.function === "get_issue") {
    const record = asRecord(value);
    if (
      call.function === "update_issue"
      && (!("seal_digest" in record) || !("acceptance_view" in record))
    ) {
      throw new Error("missing_root_update_evidence");
    }
    if ("seal_digest" in record || "acceptance_view" in record) {
      const genericResult = { ...record };
      if ("seal_digest" in record) {
        sealDigest = record.seal_digest === null ? null : parseCycleSealDigest(record.seal_digest);
        delete genericResult.seal_digest;
      }
      if ("acceptance_view" in record) {
        acceptanceView = call.function === "update_issue" && record.acceptance_view === null
          ? null
          : parseRootAcceptanceView(record.acceptance_view);
        delete genericResult.acceptance_view;
      }
      taskValue = genericResult;
    }
  }
  const result = parseTaskMcpResult(taskValue, call);
  if (
    call.function === "get_issue"
    && result.function === "get_issue"
    && result.output.issue !== null
    && result.output.issue.issue_id !== call.input.issue_id
  ) throw new Error("task_resource_identity_mismatch");
  if ("concrete_diff" in result.output && result.output.concrete_diff.length > MAX_ROOT_TASK_CHANGES) {
    throw new Error("root_task_change_limit_exceeded");
  }
  if (sealDigest === undefined && acceptanceView === undefined) return result;
  return Object.freeze({
    ...result,
    ...(sealDigest === undefined ? {} : { seal_digest: sealDigest }),
    ...(acceptanceView === undefined ? {} : { acceptance_view: acceptanceView }),
  }) as RootTaskToolResult;
}

function assertRootPageSize(call: TaskMcpCall): void {
  if (
    (call.function === "list_issues"
      || call.function === "list_children"
      || call.function === "list_relations"
      || call.function === "list_states"
      || call.function === "list_labels")
    && call.input.page_size !== ROOT_TASK_PAGE_SIZE
  ) throw new RootToolCallError("invalid_contract");
}

type IssueMutationTarget = Extract<TaskMutationTarget, { readonly kind: "issue" }>;
type RelationMutationTarget = Extract<TaskMutationTarget, { readonly kind: "relation" }>;

type UnknownAcceptance =
  | { readonly kind: "issue"; readonly target: IssueMutationTarget }
  | {
    readonly kind: "relation";
    readonly target: RelationMutationTarget;
    readonly next_cursor: string | null;
  };

type RootToolBinder = (correlationId: CorrelationId) => readonly RootToolBinding[];
const ROOT_TOOL_BINDERS = new WeakMap<object, RootToolBinder>();

function isTaskMutation(call: TaskMcpCall): boolean {
  return call.function === "create_issue"
    || call.function === "update_issue"
    || call.function === "archive_issue"
    || call.function === "create_relation"
    || call.function === "delete_relation";
}

export class RootTools {
  readonly target: RuntimeTarget;
  readonly specs: readonly RootToolSpec[];
  readonly #taskManager: RootTaskManageCommandBinding;
  readonly #taskFunctions: ReadonlySet<TaskMcpFunction>;
  readonly #declaredTools: ReadonlyMap<string, DeclaredRootTool<unknown, unknown>>;
  #unknownAcceptance: UnknownAcceptance | null = null;

  constructor(options: RootToolsOptions) {
    this.target = Object.freeze({
      root_id: parseRootIssueId(options.target.root_id),
      runtime_generation: parseRuntimeGeneration(options.target.runtime_generation),
    });
    if (
      !isRootTaskManageCommandBinding(options.task_manager)
      || options.task_manager.root_id !== this.target.root_id
    ) throw new Error("unbound_root_task_manager");
    this.#taskManager = options.task_manager;
    const capabilities = options.capabilities.map((capability) =>
      parseBoundedString(capability, "invalid_root_capability", 128));
    if (new Set(capabilities).size !== capabilities.length) throw new Error("duplicate_root_capability");

    const declarations = options.declared_tools ?? [];
    const declaredTools = new Map<string, DeclaredRootTool<unknown, unknown>>();
    const declaredCapabilities = new Set<string>();
    for (const declaration of declarations) {
      if (!Object.hasOwn(APPROVED_DECLARED_TOOL_NAMES, declaration.family)) {
        throw new Error("unapproved_root_tool");
      }
      const approvedNames = APPROVED_DECLARED_TOOL_NAMES[declaration.family] as readonly string[];
      if (!approvedNames.includes(declaration.spec.name)) throw new Error("unapproved_root_tool");
      const expectedCapability = `${declaration.family}:${declaration.spec.name}`;
      if (declaration.capability !== expectedCapability) throw new Error("invalid_root_tool_capability");
      if (declaredTools.has(declaration.spec.name) || declaredCapabilities.has(declaration.capability)) {
        throw new Error("duplicate_root_tool");
      }
      declaredTools.set(declaration.spec.name, declaration);
      declaredCapabilities.add(declaration.capability);
    }

    const taskFunctions = new Set<TaskMcpFunction>();
    const specs: RootToolSpec[] = [];
    const knownCapabilities = new Set<string>();
    for (const functionName of TASK_MCP_FUNCTIONS) {
      const capability = TASK_MCP_CAPABILITIES[functionName];
      knownCapabilities.add(capability);
      if (capabilities.includes(capability)) {
        taskFunctions.add(functionName);
        specs.push(taskSpec(functionName, this.target));
      }
    }
    for (const declaration of declarations) {
      knownCapabilities.add(declaration.capability);
      if (capabilities.includes(declaration.capability)) specs.push(declaredSpec(declaration, this.target));
    }
    if (capabilities.some((capability) => !knownCapabilities.has(capability))) {
      throw new Error("unknown_root_capability");
    }
    this.#taskFunctions = taskFunctions;
    this.#declaredTools = declaredTools;
    this.specs = Object.freeze(specs);
    ROOT_TOOL_BINDERS.set(this, (correlationId) => this.#bindings(correlationId));
    Object.freeze(this);
  }

  hasPendingAcceptance(): boolean {
    return this.#unknownAcceptance !== null;
  }

  bindings(correlationId: CorrelationId): readonly RootToolBinding[] {
    return bindRootTools(this, correlationId);
  }

  #bindings(correlationId: CorrelationId): readonly RootToolBinding[] {
    const currentCorrelation = parseCorrelationId(correlationId);
    const taskManager = bindRootTaskManageCommandCorrelation(this.#taskManager, currentCorrelation);
    return Object.freeze(this.specs.map((spec): RootToolBinding => Object.freeze({
      spec,
      execute: (value: unknown, execution: RootToolExecution) =>
        this.#execute(spec.name, value, currentCorrelation, taskManager, execution),
    })));
  }

  async #execute(
    toolName: string,
    value: unknown,
    correlationId: CorrelationId,
    taskManager: RootTaskManageCommandBinding,
    execution: RootToolExecution,
  ): Promise<unknown> {
    execution.assertActive();
    if (this.#taskFunctions.has(toolName as TaskMcpFunction)) {
      let call: TaskMcpCall;
      try {
        call = parseTaskMcpCall(value, this.target);
        if (call.function !== toolName) throw new Error("function_mismatch");
        if (call.correlation_id !== correlationId) throw new Error("correlation_mismatch");
        assertRootPageSize(call);
        this.#assertAcceptanceKnown(call);
      } catch (error) {
        throw mapCallError(error);
      }
      execution.assertActive();
      let rawResult: unknown;
      try {
        rawResult = await dispatchTask(taskManager, call, execution);
      } catch (error) {
        if (error instanceof RootToolCallError) throw error;
        if (error instanceof RootTaskManageBindingError) {
          if (error.fatal) {
            throw new RootToolFatalError(
              error.code === "boundary_unavailable" ? "boundary_unavailable" : "invalid_contract",
            );
          }
          throw new RootToolCallError(error.code);
        }
        throw new RootToolFatalError("boundary_unavailable");
      }
      execution.assertActive();
      try {
        const result = parseTaskResult(rawResult, call);
        this.#observeTaskResult(call, result);
        return result;
      } catch {
        throw new RootToolFatalError("invalid_contract");
      }
    }

    const declaration = this.#declaredTools.get(toolName);
    if (declaration === undefined || !this.specs.some(({ name }) => name === toolName)) {
      throw new RootToolCallError("capability_denied");
    }
    if (this.#unknownAcceptance !== null) throw new RootToolCallError("acceptance_unknown");
    assertEnvelope(value, this.target, correlationId, declaration.capability);
    let call: unknown;
    try {
      call = declaration.parseCall(value);
    } catch (error) {
      throw mapCallError(error);
    }
    execution.assertActive();
    let rawResult: unknown;
    try {
      rawResult = await declaration.execute(call, execution);
    } catch {
      throw new RootToolFatalError("boundary_unavailable");
    }
    execution.assertActive();
    try {
      return declaration.parseResult(rawResult, call);
    } catch {
      throw new RootToolFatalError("invalid_contract");
    }
  }

  #assertAcceptanceKnown(call: TaskMcpCall): void {
    if (this.#unknownAcceptance !== null && isTaskMutation(call)) {
      throw new RootToolCallError("acceptance_unknown");
    }
  }

  #observeTaskResult(call: TaskMcpCall, result: RootTaskToolResult): void {
    if ("outcome" in result.output && result.output.outcome === "conflict_observed") {
      const target = result.output.target;
      this.#unknownAcceptance = target.kind === "issue"
        ? Object.freeze({ kind: "issue", target })
        : Object.freeze({ kind: "relation", target, next_cursor: null });
      return;
    }
    const unknown = this.#unknownAcceptance;
    if (unknown === null) return;
    if (unknown.kind === "issue" && call.function === "get_issue" && result.function === "get_issue") {
      if (
        call.input.issue_id === unknown.target.issue_id
        && (result.output.issue === null || result.output.issue.issue_id === unknown.target.issue_id)
      ) {
        this.#unknownAcceptance = null;
      }
      return;
    }
    if (unknown.kind !== "relation" || call.function !== "list_relations" || result.function !== "list_relations") {
      return;
    }
    const targetMismatch = result.output.relations.some((relation) => (
      relation.relation_id === unknown.target.relation_id
      && (
        relation.source_issue_id !== unknown.target.source_issue_id
        || relation.target_issue_id !== unknown.target.target_issue_id
      )
    ));
    if (targetMismatch) throw new Error("task_relation_identity_mismatch");
    const targetPresent = result.output.relations.some((relation) => (
      relation.relation_id === unknown.target.relation_id
      && relation.source_issue_id === unknown.target.source_issue_id
      && relation.target_issue_id === unknown.target.target_issue_id
    ));
    if (targetPresent) {
      this.#unknownAcceptance = null;
      return;
    }
    if (
      call.input.issue_id !== unknown.target.source_issue_id
      || call.input.cursor !== unknown.next_cursor
      || result.output.relations.some((relation) => (
        relation.source_issue_id !== call.input.issue_id
        && relation.target_issue_id !== call.input.issue_id
      ))
    ) return;
    this.#unknownAcceptance = result.output.next_cursor === null
      ? null
      : Object.freeze({ ...unknown, next_cursor: result.output.next_cursor });
  }
}

export function isRootTools(value: unknown): value is RootTools {
  return typeof value === "object"
    && value !== null
    && Object.getPrototypeOf(value) === RootTools.prototype
    && Object.isFrozen(value)
    && ROOT_TOOL_BINDERS.has(value);
}

export function bindRootTools(
  tools: RootTools,
  correlationId: CorrelationId,
): readonly RootToolBinding[] {
  if (!isRootTools(tools)) throw new Error("unbound_root_tools");
  const binder = ROOT_TOOL_BINDERS.get(tools);
  if (binder === undefined) throw new Error("unbound_root_tools");
  return binder(correlationId);
}
