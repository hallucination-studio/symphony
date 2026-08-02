import { randomUUID } from "node:crypto";

import {
  parseCorrelationId,
  parseRuntimeGeneration,
  type RootIssueId,
} from "../contracts/identity.js";
import type {
  TaskManageCommandInterface,
  TaskManageExecution,
} from "../task-management/api/TaskManageCommandInterface.js";
import type { TaskManageCallerVerifier } from "../task-management/api/TaskManageCapability.js";
import { LinearCommands } from "../task-management/linear/LinearCommands.js";
import { LinearQueries } from "../task-management/linear/LinearQueries.js";
import {
  TASK_MCP_CAPABILITIES,
  type ArchiveIssueCall,
  type ArchiveIssueResult,
  type CreateIssueCall,
  type CreateIssueResult,
  type CreateRelationCall,
  type CreateRelationResult,
  type DeleteRelationCall,
  type DeleteRelationResult,
  type GetIssueCall,
  type GetIssueResult,
  type ListChildrenCall,
  type ListChildrenResult,
  type ListIssuesCall,
  type ListIssuesResult,
  type ListLabelsCall,
  type ListLabelsResult,
  type ListRelationsCall,
  type ListRelationsResult,
  type ListStatesCall,
  type ListStatesResult,
  type UpdateIssueCall,
  type UpdateIssueResult,
} from "../task-management/mcp/TaskMcpSchemas.js";
import type { ConductorConfig } from "./config.js";

const CATALOG_PAGE_SIZE = 50;
const MAX_CATALOG_PAGES = 100;

export interface TaskWorkflowCatalog {
  readonly states: readonly (readonly [identity: string, name: string, archived: boolean])[];
  readonly labels: readonly (readonly [identity: string, name: string])[];
}

function catalogMap(
  entries: readonly (readonly [identity: string, name: string])[],
): ReadonlyMap<string, string> {
  const catalog = new Map(entries);
  if (catalog.size !== entries.length) throw new Error("invalid_task_workflow_configuration");
  return catalog;
}

export function assertTaskWorkflowConfiguration(
  config: ConductorConfig,
  catalog: TaskWorkflowCatalog,
): void {
  const states = new Map(catalog.states.map(([identity, name, archived]) => [identity, { name, archived }] as const));
  if (states.size !== catalog.states.length) throw new Error("invalid_task_workflow_configuration");
  const labels = catalogMap(catalog.labels);
  const expectedStates = [
    [config.root_states.todo, "Todo"],
    [config.root_states.in_progress, "In Progress"],
    [config.root_states.in_review, "In Review"],
    [config.root_states.done, "Done"],
    [config.workflow.cycle_states.draft, "Draft"],
    [config.workflow.cycle_states.in_progress, "In Progress"],
    [config.workflow.cycle_states.awaiting_acceptance, "Awaiting Acceptance"],
    [config.workflow.cycle_states.succeeded, "Succeeded"],
    [config.workflow.cycle_states.rejected, "Rejected"],
    [config.workflow.cycle_states.failed, "Failed"],
    [config.workflow.cycle_states.canceled, "Canceled"],
    [config.workflow.stage_states.todo, "Todo"],
    [config.workflow.stage_states.in_progress, "In Progress"],
    [config.workflow.stage_states.done, "Done"],
    [config.workflow.stage_states.failed, "Failed"],
    [config.workflow.stage_states.canceled, "Canceled"],
  ] as const;
  const expectedLabels = [
    [config.workflow.labels.root, "symphony:kind/root"],
    [config.workflow.labels.cycle, "symphony:kind/cycle"],
    [config.workflow.labels.plan, "symphony:kind/plan"],
    [config.workflow.labels.work, "symphony:kind/work"],
    [config.workflow.labels.verify, "symphony:kind/verify"],
  ] as const;
  if (
    new Set(expectedStates.map(([identity]) => identity)).size !== expectedStates.length
    || expectedStates.some(([identity, name]) => {
      const observed = states.get(identity);
      return observed === undefined || observed.name !== name || observed.archived;
    })
    || expectedLabels.some(([identity, name]) => labels.get(identity) !== name)
  ) throw new Error("invalid_task_workflow_configuration");
}

function catalogEnvelope(rootId: RootIssueId) {
  return Object.freeze({
    schema_version: 1 as const,
    root_id: rootId,
    runtime_generation: parseRuntimeGeneration(1),
    correlation_id: parseCorrelationId(`startup:${randomUUID()}`),
  });
}

export async function readTaskWorkflowCatalog(
  queries: LinearQueries,
  rootId: RootIssueId,
): Promise<TaskWorkflowCatalog> {
  const envelope = catalogEnvelope(rootId);
  const states: (readonly [string, string, boolean])[] = [];
  const labels: (readonly [string, string])[] = [];
  let stateCursor: string | null = null;
  let labelCursor: string | null = null;
  for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
    const call: ListStatesCall = Object.freeze({
      ...envelope,
      function: "list_states",
      capability: TASK_MCP_CAPABILITIES.list_states,
      input: Object.freeze({ cursor: stateCursor, page_size: CATALOG_PAGE_SIZE }),
    });
    const result = await queries.list_states(call);
    states.push(...result.output.states.map(({ state_id, name, archived }) => [state_id, name, archived] as const));
    stateCursor = result.output.next_cursor;
    if (stateCursor === null) break;
    if (page === MAX_CATALOG_PAGES - 1) throw new Error("invalid_task_workflow_configuration");
  }
  for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
    const call: ListLabelsCall = Object.freeze({
      ...envelope,
      function: "list_labels",
      capability: TASK_MCP_CAPABILITIES.list_labels,
      input: Object.freeze({ cursor: labelCursor, page_size: CATALOG_PAGE_SIZE }),
    });
    const result = await queries.list_labels(call);
    labels.push(...result.output.labels.map(({ label_id, name }) => [label_id, name] as const));
    labelCursor = result.output.next_cursor;
    if (labelCursor === null) break;
    if (page === MAX_CATALOG_PAGES - 1) throw new Error("invalid_task_workflow_configuration");
  }
  return Object.freeze({ states: Object.freeze(states), labels: Object.freeze(labels) });
}

export class LinearTaskManageCommand implements TaskManageCommandInterface {
  constructor(
    private readonly queries: LinearQueries,
    private readonly commands: LinearCommands,
    private readonly verifier: TaskManageCallerVerifier,
  ) {}

  get_issue(call: GetIssueCall, execution: TaskManageExecution): Promise<GetIssueResult> {
    return this.#query(call, execution, () => this.queries.get_issue(call));
  }

  list_issues(call: ListIssuesCall, execution: TaskManageExecution): Promise<ListIssuesResult> {
    return this.#query(call, execution, () => this.queries.list_issues(call));
  }

  list_children(call: ListChildrenCall, execution: TaskManageExecution): Promise<ListChildrenResult> {
    return this.#query(call, execution, () => this.queries.list_children(call));
  }

  create_issue(call: CreateIssueCall, execution: TaskManageExecution): Promise<CreateIssueResult> {
    return this.#mutation(call, execution);
  }

  update_issue(call: UpdateIssueCall, execution: TaskManageExecution): Promise<UpdateIssueResult> {
    return this.#mutation(call, execution);
  }

  archive_issue(call: ArchiveIssueCall, execution: TaskManageExecution): Promise<ArchiveIssueResult> {
    return this.#mutation(call, execution);
  }

  list_relations(call: ListRelationsCall, execution: TaskManageExecution): Promise<ListRelationsResult> {
    return this.#query(call, execution, () => this.queries.list_relations(call));
  }

  create_relation(call: CreateRelationCall, execution: TaskManageExecution): Promise<CreateRelationResult> {
    return this.#mutation(call, execution);
  }

  delete_relation(call: DeleteRelationCall, execution: TaskManageExecution): Promise<DeleteRelationResult> {
    return this.#mutation(call, execution);
  }

  list_states(call: ListStatesCall, execution: TaskManageExecution): Promise<ListStatesResult> {
    return this.#query(call, execution, () => this.queries.list_states(call));
  }

  list_labels(call: ListLabelsCall, execution: TaskManageExecution): Promise<ListLabelsResult> {
    return this.#query(call, execution, () => this.queries.list_labels(call));
  }

  async #query<C, R>(
    call: C,
    execution: TaskManageExecution,
    operation: () => Promise<R>,
  ): Promise<R> {
    this.verifier.assert(execution.caller, call as never);
    execution.assertActive();
    const result = await operation();
    execution.assertActive();
    return result;
  }

  async #mutation<C extends CreateIssueCall | UpdateIssueCall | ArchiveIssueCall | CreateRelationCall | DeleteRelationCall>(
    call: C,
    execution: TaskManageExecution,
  ): Promise<C extends CreateIssueCall ? CreateIssueResult
    : C extends UpdateIssueCall ? UpdateIssueResult
      : C extends ArchiveIssueCall ? ArchiveIssueResult
        : C extends CreateRelationCall ? CreateRelationResult
          : DeleteRelationResult> {
    this.verifier.assert(execution.caller, call);
    execution.assertActive();
    const result = await this.commands.execute(call, execution);
    execution.assertActive();
    return result as never;
  }
}
