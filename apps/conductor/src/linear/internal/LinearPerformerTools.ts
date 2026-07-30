import { IssueRelationType, LinearClient } from "@linear/sdk";

import type { DynamicToolBinding } from "../../codex-app-server/internal/DynamicToolBridge.js";
import type { PlanRequest, VerifyRequest, WorkRequest } from "../../contracts/stage-interaction.js";
import { asRecord, assertExactKeys, parseBoundedString, parseEnum } from "../../contracts/validation.js";
import { hasCompletePlanDag } from "../../orchestration/PlanDagValidator.js";
import type { LinearGatewayInterface } from "../api/LinearGatewayInterface.js";

const PLAN_LABEL = "symphony:kind/plan";
const WORK_LABEL = "symphony:kind/work";
const VERIFY_LABEL = "symphony:kind/verify";
const MAX_WORK_ITEMS = 8;
const PAGE_SIZE = 50;
const MAX_PAGES = 100;
const MAX_NODES = 5_000;

interface SdkConnection<T> {
  readonly nodes: readonly T[];
  readonly pageInfo: { readonly hasNextPage: boolean };
  fetchNext(): Promise<SdkConnection<T>>;
}

interface WorkDefinition {
  readonly title: string;
  readonly description: string;
  readonly dependsOn: readonly number[];
}

interface PlanDefinition {
  readonly planTitle: string;
  readonly planDescription: string;
  readonly works: readonly WorkDefinition[];
  readonly verifyTitle: string;
  readonly verifyDescription: string;
}

function planDefinition(value: unknown): PlanDefinition {
  const record = asRecord(value, "invalid_plan_tool_input");
  assertExactKeys(record, ["plan_title", "plan_description", "works", "verify_title", "verify_description"]);
  if (!Array.isArray(record.works) || record.works.length < 1 || record.works.length > MAX_WORK_ITEMS) {
    throw new Error("invalid_plan_tool_input");
  }
  const rawWorks = record.works;
  const works = rawWorks.map((entry, index): WorkDefinition => {
    const work = asRecord(entry, "invalid_plan_tool_input");
    assertExactKeys(work, ["title", "description", "depends_on"]);
    if (!Array.isArray(work.depends_on)) throw new Error("invalid_plan_tool_input");
    const dependencies = work.depends_on.map((dependency) => {
      if (!Number.isSafeInteger(dependency) || (dependency as number) < 0 || (dependency as number) >= rawWorks.length) {
        throw new Error("invalid_plan_tool_input");
      }
      return dependency as number;
    });
    if (dependencies.includes(index) || new Set(dependencies).size !== dependencies.length) {
      throw new Error("invalid_plan_tool_input");
    }
    return Object.freeze({
      title: parseBoundedString(work.title, "invalid_plan_tool_input", 200),
      description: parseBoundedString(work.description, "invalid_plan_tool_input", 4000),
      dependsOn: Object.freeze(dependencies),
    });
  });
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const cyclic = (index: number): boolean => {
    if (visiting.has(index)) return true;
    if (visited.has(index)) return false;
    visiting.add(index);
    const found = works[index]?.dependsOn.some(cyclic) ?? false;
    visiting.delete(index);
    visited.add(index);
    return found;
  };
  if (works.some((_, index) => cyclic(index))) throw new Error("invalid_plan_tool_input");
  return Object.freeze({
    planTitle: parseBoundedString(record.plan_title, "invalid_plan_tool_input", 200),
    planDescription: parseBoundedString(record.plan_description, "invalid_plan_tool_input", 4000),
    works: Object.freeze(works),
    verifyTitle: parseBoundedString(record.verify_title, "invalid_plan_tool_input", 200),
    verifyDescription: parseBoundedString(record.verify_description, "invalid_plan_tool_input", 4000),
  });
}

export class LinearPerformerTools {
  constructor(
    private readonly client: LinearClient,
    private readonly teamId: string,
    private readonly linear: Pick<LinearGatewayInterface, "readRoot">,
  ) {}

  plan(request: PlanRequest): DynamicToolBinding {
    return {
      spec: {
        type: "function",
        name: "linear_create_plan_dag",
        description: "Create and read back the complete Plan, Work DAG, and Verify stages for the bound empty Cycle.",
        inputSchema: {
          type: "object",
          properties: {
            plan_title: { type: "string", minLength: 1, maxLength: 200 },
            plan_description: { type: "string", minLength: 1, maxLength: 4000 },
            works: {
              type: "array", minItems: 1, maxItems: MAX_WORK_ITEMS,
              items: {
                type: "object",
                properties: {
                  title: { type: "string", minLength: 1, maxLength: 200 },
                  description: { type: "string", minLength: 1, maxLength: 4000 },
                  depends_on: { type: "array", uniqueItems: true, items: { type: "integer", minimum: 0, maximum: MAX_WORK_ITEMS - 1 } },
                },
                required: ["title", "description", "depends_on"], additionalProperties: false,
              },
            },
            verify_title: { type: "string", minLength: 1, maxLength: 200 },
            verify_description: { type: "string", minLength: 1, maxLength: 4000 },
          },
          required: ["plan_title", "plan_description", "works", "verify_title", "verify_description"],
          additionalProperties: false,
        },
      },
      execute: (input) => this.#createPlan(request, input),
    };
  }

  work(request: WorkRequest): DynamicToolBinding {
    return this.#stageBinding("linear_complete_work", request, ["completed", "failed", "canceled"] as const);
  }

  verify(request: VerifyRequest): DynamicToolBinding {
    return this.#stageBinding("linear_complete_verify", request, ["passed", "failed", "inconclusive"] as const);
  }

  async #createPlan(request: PlanRequest, input: unknown): Promise<unknown> {
    const definition = planDefinition(input);
    const before = await this.linear.readRoot(request.root_id);
    if (
      before.root_id !== request.root_id
      || before.root_status !== "In Progress"
      || before.active_cycle?.issue_id !== request.cycle_issue_id
      || before.active_cycle.status !== "Planning"
      || before.active_cycle.stages.length !== 0
    ) throw new Error("linear_plan_precondition_mismatch");
    const [todo, done, planLabel, workLabel, verifyLabel] = await Promise.all([
      this.#state("Todo"), this.#state("Done"), this.#label(PLAN_LABEL), this.#label(WORK_LABEL), this.#label(VERIFY_LABEL),
    ]);
    const planId = await this.#createIssue({
      parentId: request.cycle_issue_id, title: definition.planTitle, description: definition.planDescription,
      stateId: done, labelIds: [planLabel],
    });
    const workIds: string[] = [];
    for (const work of definition.works) {
      workIds.push(await this.#createIssue({
        parentId: request.cycle_issue_id, title: work.title, description: work.description,
        stateId: todo, labelIds: [workLabel],
      }));
    }
    const verifyId = await this.#createIssue({
      parentId: request.cycle_issue_id, title: definition.verifyTitle, description: definition.verifyDescription,
      stateId: todo, labelIds: [verifyLabel],
    });
    for (const [index, work] of definition.works.entries()) {
      for (const dependency of work.dependsOn) await this.#relation(workIds[dependency]!, workIds[index]!);
    }
    for (const workId of workIds) await this.#relation(workId, verifyId);
    const after = await this.linear.readRoot(request.root_id);
    if (after.active_cycle?.issue_id !== request.cycle_issue_id || !hasCompletePlanDag(after.active_cycle)) {
      throw new Error("linear_plan_readback_mismatch");
    }
    return Object.freeze({ plan_issue_id: planId, work_issue_ids: Object.freeze(workIds), verify_issue_id: verifyId });
  }

  #stageBinding(
    name: string,
    request: WorkRequest | VerifyRequest,
    outcomes: readonly string[],
  ): DynamicToolBinding {
    return {
      spec: {
        type: "function", name,
        description: "Set and read back the terminal status of the single bound Linear Stage.",
        inputSchema: {
          type: "object",
          properties: { outcome: { enum: outcomes } },
          required: ["outcome"], additionalProperties: false,
        },
      },
      execute: async (input) => {
        const record = asRecord(input, "invalid_stage_tool_input");
        assertExactKeys(record, ["outcome"]);
        const outcome = parseEnum(record.outcome, outcomes);
        const issueId = request.role === "work" ? request.work_issue_id : request.verify_issue_id;
        const before = await this.linear.readRoot(request.root_id);
        const stage = before.active_cycle?.stages.find(({ issue_id }) => issue_id === issueId);
        if (
          before.root_id !== request.root_id
          || before.active_cycle?.issue_id !== request.cycle_issue_id
          || stage?.kind !== request.role
          || stage.status !== "In Progress"
        ) throw new Error("linear_stage_precondition_mismatch");
        const desired = outcome === "completed" || outcome === "passed" ? "Done" : outcome === "canceled" ? "Canceled" : "Failed";
        const payload = await this.client.updateIssue(issueId, { stateId: await this.#state(desired) });
        if (!payload.success || payload.issueId !== issueId) throw new Error("linear_stage_mutation_failed");
        const after = await this.linear.readRoot(request.root_id);
        const readback = after.active_cycle?.stages.find(({ issue_id }) => issue_id === issueId);
        if (readback?.kind !== request.role || readback.status !== desired) throw new Error("linear_stage_readback_mismatch");
        return Object.freeze({ issue_id: issueId, status: desired, outcome });
      },
    };
  }

  async #state(name: string): Promise<string> {
    const states = await this.#all(await this.client.workflowStates({
      first: PAGE_SIZE,
      filter: { team: { id: { eq: this.teamId } }, name: { eq: name } },
    }));
    const matching = states.filter((state) => state.teamId === this.teamId && state.name === name);
    if (matching.length !== 1) throw new Error("linear_state_identity_ambiguous");
    return matching[0]!.id;
  }

  async #label(name: string): Promise<string> {
    const labels = await this.#all(await this.client.issueLabels({ first: PAGE_SIZE, filter: { name: { eq: name } } }));
    const matching = labels.filter((label) => label.name === name && (label.teamId === null || label.teamId === this.teamId));
    if (matching.length !== 1) throw new Error("linear_label_identity_ambiguous");
    return matching[0]!.id;
  }

  async #all<T>(connection: SdkConnection<T>): Promise<readonly T[]> {
    let previousLength = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (connection.nodes.length > MAX_NODES) throw new Error("linear_read_limit_exceeded");
      if (!connection.pageInfo.hasNextPage) return connection.nodes;
      previousLength = connection.nodes.length;
      connection = await connection.fetchNext();
      if (connection.nodes.length <= previousLength) throw new Error("linear_incomplete_page");
    }
    throw new Error("linear_read_limit_exceeded");
  }

  async #createIssue(input: { parentId: string; title: string; description: string; stateId: string; labelIds: string[] }): Promise<string> {
    const payload = await this.client.createIssue({ teamId: this.teamId, ...input });
    if (!payload.success || !payload.issueId) throw new Error("linear_stage_creation_failed");
    return payload.issueId;
  }

  async #relation(sourceId: string, targetId: string): Promise<void> {
    const payload = await this.client.createIssueRelation({
      issueId: sourceId, relatedIssueId: targetId, type: IssueRelationType.Blocks,
    });
    if (!payload.success) throw new Error("linear_relation_creation_failed");
  }
}
