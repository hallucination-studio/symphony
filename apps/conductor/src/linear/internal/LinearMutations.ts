import { parseMutationResult, type MutationResult } from "../../contracts/mutation.js";
import type { LinearObservation } from "../../contracts/observation.js";
import { asRecord, assertExactKeys, parseBoundedString } from "../../contracts/validation.js";
import {
  parseLinearMutation,
  type LinearGatewayInterface,
  type LinearMutation,
} from "../api/LinearGatewayInterface.js";
import {
  LinearReader,
  type LinearReadClient,
  type LinearReaderOptions,
  type LinearTargetObservation,
} from "./LinearReader.js";

const PAGE_SIZE = 50;
const MAX_PAGES = 100;
const MAX_NODES = 5_000;
const CYCLE_TITLE = "Symphony Cycle";
const CYCLE_LABEL = "symphony:kind/cycle";

export type { LinearTargetObservation } from "./LinearReader.js";

export interface LinearMutationReader {
  readRoot(rootId: LinearMutation["root_id"]): Promise<LinearObservation>;
  readTarget(issueId: string): Promise<LinearTargetObservation>;
}

export interface LinearMutationClient {
  listWorkflowStates(teamId: string, name: string, cursor: string | null, pageSize: number): Promise<unknown>;
  listNamedIssueLabels(name: string, cursor: string | null, pageSize: number): Promise<unknown>;
  createCycle(input: {
    readonly team_id: string;
    readonly parent_issue_id: string;
    readonly title: string;
    readonly state_id: string;
    readonly label_id: string;
  }): Promise<unknown>;
  updateIssueStatus(issueId: string, stateId: string): Promise<unknown>;
}

interface MutationResponse {
  readonly success: boolean;
  readonly issueId: string | null;
}

interface NamedState {
  readonly id: string;
  readonly name: string;
  readonly teamId: string;
}

interface NamedLabel {
  readonly id: string;
  readonly name: string;
  readonly teamId: string | null;
  readonly isGroup: boolean;
}

function parsePage(value: unknown): { readonly nodes: readonly unknown[]; readonly next: string | null } {
  const record = asRecord(value);
  assertExactKeys(record, ["nodes", "page_info"]);
  if (!Array.isArray(record.nodes)) throw new Error("linear_invalid_payload");
  const pageInfo = asRecord(record.page_info);
  assertExactKeys(pageInfo, ["has_next_page", "end_cursor"]);
  if (typeof pageInfo.has_next_page !== "boolean") throw new Error("linear_invalid_payload");
  if (!pageInfo.has_next_page) return { nodes: record.nodes, next: null };
  if (typeof pageInfo.end_cursor !== "string" || pageInfo.end_cursor.length === 0) {
    throw new Error("linear_incomplete_page");
  }
  return { nodes: record.nodes, next: pageInfo.end_cursor };
}

function parseState(value: unknown): NamedState {
  const record = asRecord(value);
  assertExactKeys(record, ["id", "name", "team_id"]);
  return {
    id: parseBoundedString(record.id, "invalid_state_id", 128),
    name: parseBoundedString(record.name, "invalid_state_name", 128),
    teamId: parseBoundedString(record.team_id, "invalid_team_id", 128),
  };
}

function parseLabel(value: unknown): NamedLabel {
  const record = asRecord(value);
  assertExactKeys(record, ["id", "name", "team_id", "is_group"]);
  if (typeof record.is_group !== "boolean") throw new Error("linear_invalid_payload");
  return {
    id: parseBoundedString(record.id, "invalid_label_id", 128),
    name: parseBoundedString(record.name, "invalid_label_name", 128),
    teamId: record.team_id === null ? null : parseBoundedString(record.team_id, "invalid_team_id", 128),
    isGroup: record.is_group,
  };
}

function parseResponse(value: unknown): MutationResponse {
  const record = asRecord(value);
  assertExactKeys(record, ["success", "issue_id"]);
  if (typeof record.success !== "boolean") throw new Error("linear_invalid_payload");
  return {
    success: record.success,
    issueId: record.issue_id === null ? null : parseBoundedString(record.issue_id, "invalid_issue_id", 128),
  };
}

export class LinearMutations {
  readonly #teamId: string;

  constructor(
    private readonly reader: LinearMutationReader,
    private readonly client: LinearMutationClient,
    options: { readonly team_id: string },
  ) {
    this.#teamId = parseBoundedString(options.team_id, "invalid_linear_team_id", 128);
  }

  async mutate(input: LinearMutation): Promise<MutationResult> {
    const command = parseLinearMutation(input);
    const before = await this.reader.readRoot(command.root_id);
    if (!this.#preconditionMatches(command, before)) {
      return this.#result(command, "precondition_failed", this.#targetId(command), "fresh_precondition_mismatch");
    }

    let effect: () => Promise<unknown>;
    try {
      if (command.kind === "create_cycle") {
        const [stateId, labelId] = await Promise.all([
          this.#stateId("Planning"),
          this.#cycleLabelId(),
        ]);
        effect = () => this.client.createCycle({
          team_id: this.#teamId,
          parent_issue_id: command.root_id,
          title: CYCLE_TITLE,
          state_id: stateId,
          label_id: labelId,
        });
      } else {
        const stateId = await this.#stateId(command.desired_status);
        const issueId = this.#targetId(command);
        effect = () => this.client.updateIssueStatus(issueId, stateId);
      }
    } catch {
      return this.#result(command, "not_applied", this.#targetId(command), "linear_mutation_target_unavailable");
    }

    let rawResponse: unknown;
    let providerUncertain = false;
    try {
      rawResponse = await effect();
    } catch {
      providerUncertain = true;
    }

    let readback: LinearObservation | LinearTargetObservation;
    try {
      readback = command.kind === "create_cycle"
        ? await this.reader.readRoot(command.root_id)
        : await this.reader.readTarget(this.#targetId(command));
    } catch {
      return this.#result(command, "acceptance_unknown", this.#targetId(command), "fresh_readback_unavailable");
    }

    const appliedTarget = this.#appliedTarget(command, readback);
    if (appliedTarget !== null) return this.#result(command, "applied", appliedTarget);
    if (providerUncertain) {
      return this.#result(command, "acceptance_unknown", this.#targetId(command), "provider_acceptance_unknown");
    }

    let response: MutationResponse;
    try {
      response = parseResponse(rawResponse);
    } catch {
      return this.#result(command, "readback_mismatch", this.#targetId(command), "invalid_provider_response");
    }
    if (!response.success) return this.#result(command, "not_applied", this.#targetId(command), "provider_rejected");
    return this.#result(command, "readback_mismatch", this.#targetId(command), "fresh_postcondition_mismatch");
  }

  #preconditionMatches(command: LinearMutation, before: LinearObservation): boolean {
    if (before.root_id !== command.root_id) return false;
    if (command.kind === "create_cycle") {
      return before.root_status === command.expected_root_status && before.active_cycle === null;
    }
    if (command.kind === "set_root_status") return before.root_status === command.expected_status;
    const cycle = before.active_cycle;
    if (!cycle || cycle.issue_id !== command.cycle_issue_id) return false;
    if (command.kind === "set_cycle_status") return cycle.status === command.expected_status;
    const stage = cycle.stages.find(({ issue_id }) => issue_id === command.stage_issue_id);
    return stage?.kind === command.expected_kind && stage.status === command.expected_status;
  }

  #appliedTarget(command: LinearMutation, readback: LinearObservation | LinearTargetObservation): string | null {
    if (command.kind === "create_cycle") {
      const observation = readback as LinearObservation;
      return observation.root_id === command.root_id && observation.active_cycle?.status === "Planning"
        ? observation.active_cycle.issue_id
        : null;
    }
    const target = readback as LinearTargetObservation;
    const targetId = this.#targetId(command);
    if (target.issue_id !== targetId || target.team_id !== this.#teamId || target.status !== command.desired_status) return null;
    if (command.kind === "set_root_status") return target.kind === "root" && target.parent_id === null ? targetId : null;
    if (command.kind === "set_cycle_status") {
      return target.kind === "cycle" && target.parent_id === command.root_id ? targetId : null;
    }
    return target.kind === command.expected_kind && target.parent_id === command.cycle_issue_id ? targetId : null;
  }

  #targetId(command: LinearMutation): string {
    if (command.kind === "set_cycle_status") return command.cycle_issue_id;
    if (command.kind === "set_stage_status") return command.stage_issue_id;
    return command.root_id;
  }

  async #stateId(name: string): Promise<string> {
    const states = await this.#all(
      (cursor) => this.client.listWorkflowStates(this.#teamId, name, cursor, PAGE_SIZE),
      parseState,
    );
    const matching = states.filter((state) => state.name === name && state.teamId === this.#teamId);
    if (matching.length !== 1) throw new Error("linear_state_identity_ambiguous");
    return matching[0]?.id as string;
  }

  async #cycleLabelId(): Promise<string> {
    const labels = await this.#all(
      (cursor) => this.client.listNamedIssueLabels(CYCLE_LABEL, cursor, PAGE_SIZE),
      parseLabel,
    );
    const matching = labels.filter((label) => label.name === CYCLE_LABEL
      && !label.isGroup
      && (label.teamId === null || label.teamId === this.#teamId));
    if (matching.length !== 1) throw new Error("linear_cycle_label_ambiguous");
    return matching[0]?.id as string;
  }

  async #all<T>(loader: (cursor: string | null) => Promise<unknown>, parser: (value: unknown) => T): Promise<readonly T[]> {
    const values: T[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page = parsePage(await loader(cursor));
      values.push(...page.nodes.map(parser));
      if (values.length > MAX_NODES) throw new Error("linear_read_limit_exceeded");
      if (page.next === null) return values;
      if (cursors.has(page.next)) throw new Error("linear_incomplete_page");
      cursors.add(page.next);
      cursor = page.next;
    }
    throw new Error("linear_read_limit_exceeded");
  }

  #result(
    command: LinearMutation,
    outcome: MutationResult["outcome"],
    targetId: string,
    reason?: string,
  ): MutationResult {
    return parseMutationResult(outcome === "applied"
      ? { schema_version: 1, outcome, target_id: targetId, correlation_id: command.correlation_id }
      : { schema_version: 1, outcome, target_id: targetId, correlation_id: command.correlation_id, reason });
  }
}

export class LinearGateway implements LinearGatewayInterface {
  readonly #reader: LinearReader;
  readonly #mutations: LinearMutations;

  constructor(client: LinearReadClient & LinearMutationClient, options: LinearReaderOptions) {
    this.#reader = new LinearReader(client, options);
    this.#mutations = new LinearMutations(this.#reader, client, { team_id: options.team_id });
  }

  discoverRoots() { return this.#reader.discoverRoots(); }
  readRoot(rootId: LinearMutation["root_id"]) { return this.#reader.readRoot(rootId); }
  mutate(command: LinearMutation) { return this.#mutations.mutate(command); }
}
