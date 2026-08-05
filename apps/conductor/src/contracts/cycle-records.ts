import {
  parseRootIssueId,
  parseTaskIssueId,
  parseTaskRelationId,
  parseTaskRevision,
  type RootIssueId,
  type TaskIssueId,
  type TaskRevision,
} from "./identity.js";
import {
  asRecord,
  assertExactKeys,
  parseArray,
  parseBoundedString,
  parseEnum,
  parseMarkdownText,
  parseStringArray,
  type MarkdownText,
  type UnknownRecord,
} from "./validation.js";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const CANONICAL_REVISION_PATTERN = /^symphony:v1:[0-9a-f]{64}$/u;
const MAX_DIRECTIVES = 256;
const MAX_RECORD_ITEMS = 512;
const TASK_STATUSES = [
  "Todo", "Draft", "In Progress", "Awaiting Acceptance", "In Review", "Done",
  "Succeeded", "Rejected", "Failed", "Canceled",
] as const;
const STAGE_TERMINAL_STATUSES = ["Done", "Failed", "Canceled"] as const;
const CYCLE_TERMINAL_STATUSES = ["Succeeded", "Rejected", "Failed", "Canceled"] as const;
const CYCLE_PHASES = ["draft", "in_progress", "awaiting_acceptance"] as const;

type TaskStatus = typeof TASK_STATUSES[number];
type Digest = string;

function parseDigest(value: unknown, code = "invalid_digest"): Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw new Error(code);
  return value;
}

function parseCanonicalRevision(value: unknown): TaskRevision {
  const revision = parseTaskRevision(value);
  if (!CANONICAL_REVISION_PATTERN.test(revision)) throw new Error("invalid_canonical_task_revision");
  return revision;
}

function parseTimestamp(value: unknown, code: string): string {
  const timestamp = parseBoundedString(value, code, 64);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) throw new Error(code);
  return timestamp;
}

function parseIdentifier(value: unknown, code = "invalid_contract_identity"): string {
  return parseBoundedString(value, code, 128);
}

function parseNullable<T>(value: unknown, parser: (entry: unknown) => T): T | null {
  return value === null ? null : parser(value);
}

function nonEmptyArray<T>(
  value: unknown,
  parser: (entry: unknown) => T,
  code: string,
  max = MAX_RECORD_ITEMS,
): readonly [T, ...T[]] {
  const parsed = parseArray(value, parser, max);
  if (parsed.length === 0) throw new Error(code);
  return parsed as readonly [T, ...T[]];
}

function sameOrdered(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function assertUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new Error(code);
}

export interface ExecutionDirective {
  readonly directive_id: string;
  readonly instruction_markdown: MarkdownText;
  readonly depends_on_directive_ids: readonly string[];
  readonly acceptance_criterion_ids: readonly string[];
}

export interface ApprovedWorkGroup {
  readonly work_group_id: string;
  readonly directive_ids: readonly [string, ...string[]];
  readonly depends_on_work_group_ids: readonly string[];
}

export interface VerificationDirective {
  readonly directive_id: string;
  readonly instruction_markdown: MarkdownText;
  readonly acceptance_criterion_ids: readonly string[];
}

export interface CycleSpecification {
  readonly cycle_id: TaskIssueId;
  readonly root_id: RootIssueId;
  readonly predecessor_cycle_issue_id: TaskIssueId | null;
  readonly predecessor_terminal_record_id: string;
  readonly approval_record_id: string;
  readonly plan_issue_id: TaskIssueId;
  readonly plan_completion_record_id: string;
  readonly plan_invalidation_record_id: string;
  readonly cycle_completion_record_id: string;
  readonly cycle_invalidation_record_id: string;
  readonly delivery_completion_record_id: string;
  readonly delivery_invalidation_record_id: string;
  readonly identity_derivation_version: string;
  readonly workspace_base_revision: Digest;
  readonly root_definition_revision: TaskRevision;
  readonly cycle_specification_markdown: MarkdownText;
  readonly root_adr_markdown: MarkdownText;
  readonly execution_directives: readonly [ExecutionDirective, ...ExecutionDirective[]];
  readonly approved_work_groups: readonly [ApprovedWorkGroup, ...ApprovedWorkGroup[]];
  readonly verify_directives: readonly [VerificationDirective, ...VerificationDirective[]];
  readonly specification_seal_digest: Digest | null;
}

function parseExecutionDirective(value: unknown): ExecutionDirective {
  const record = asRecord(value);
  assertExactKeys(record, [
    "directive_id", "instruction_markdown", "depends_on_directive_ids", "acceptance_criterion_ids",
  ]);
  return Object.freeze({
    directive_id: parseIdentifier(record.directive_id, "invalid_execution_directive_id"),
    instruction_markdown: parseMarkdownText(record.instruction_markdown, "invalid_execution_instruction"),
    depends_on_directive_ids: parseStringArray(
      record.depends_on_directive_ids,
      (entry) => parseIdentifier(entry, "invalid_execution_dependency_id"),
      MAX_DIRECTIVES,
    ),
    acceptance_criterion_ids: parseStringArray(
      record.acceptance_criterion_ids,
      (entry) => parseIdentifier(entry, "invalid_acceptance_criterion_id"),
      MAX_DIRECTIVES,
    ),
  });
}

function parseApprovedWorkGroup(value: unknown): ApprovedWorkGroup {
  const record = asRecord(value);
  assertExactKeys(record, ["work_group_id", "directive_ids", "depends_on_work_group_ids"]);
  const directiveIds = nonEmptyArray(
    record.directive_ids,
    (entry) => parseIdentifier(entry, "invalid_work_group_directive_id"),
    "empty_work_group",
    MAX_DIRECTIVES,
  );
  assertUnique(directiveIds, "duplicate_contract_identity");
  return Object.freeze({
    work_group_id: parseIdentifier(record.work_group_id, "invalid_work_group_id"),
    directive_ids: directiveIds,
    depends_on_work_group_ids: parseStringArray(
      record.depends_on_work_group_ids,
      (entry) => parseIdentifier(entry, "invalid_work_group_dependency_id"),
      MAX_DIRECTIVES,
    ),
  });
}

function parseVerificationDirective(value: unknown): VerificationDirective {
  const record = asRecord(value);
  assertExactKeys(record, ["directive_id", "instruction_markdown", "acceptance_criterion_ids"]);
  return Object.freeze({
    directive_id: parseIdentifier(record.directive_id, "invalid_verification_directive_id"),
    instruction_markdown: parseMarkdownText(record.instruction_markdown, "invalid_verification_instruction"),
    acceptance_criterion_ids: parseStringArray(
      record.acceptance_criterion_ids,
      (entry) => parseIdentifier(entry, "invalid_acceptance_criterion_id"),
      MAX_DIRECTIVES,
    ),
  });
}

function assertDag(nodes: readonly { readonly id: string; readonly dependencies: readonly string[] }[], code: string): void {
  const known = new Set(nodes.map(({ id }) => id));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dependencies = new Map(nodes.map(({ id, dependencies: values }) => [id, values]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(code);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (!known.has(dependency) || dependency === id) throw new Error(code);
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const { id } of nodes) visit(id);
}

export function parseCycleSpecification(value: unknown): CycleSpecification {
  const record = asRecord(value);
  assertExactKeys(record, [
    "cycle_id", "root_id", "predecessor_cycle_issue_id", "predecessor_terminal_record_id",
    "approval_record_id", "plan_issue_id", "plan_completion_record_id", "plan_invalidation_record_id",
    "cycle_completion_record_id", "cycle_invalidation_record_id", "delivery_completion_record_id",
    "delivery_invalidation_record_id", "identity_derivation_version", "workspace_base_revision",
    "root_definition_revision", "cycle_specification_markdown", "root_adr_markdown",
    "execution_directives", "approved_work_groups", "verify_directives", "specification_seal_digest",
  ]);
  const executionDirectives = nonEmptyArray(
    record.execution_directives, parseExecutionDirective, "empty_execution_directives", MAX_DIRECTIVES,
  );
  const workGroups = nonEmptyArray(
    record.approved_work_groups, parseApprovedWorkGroup, "empty_approved_work_groups", MAX_DIRECTIVES,
  );
  const verifyDirectives = nonEmptyArray(
    record.verify_directives, parseVerificationDirective, "empty_verification_directives", MAX_DIRECTIVES,
  );
  const directiveIds = executionDirectives.map(({ directive_id }) => directive_id);
  const groupIds = workGroups.map(({ work_group_id }) => work_group_id);
  const verifyIds = verifyDirectives.map(({ directive_id }) => directive_id);
  assertUnique(directiveIds, "duplicate_execution_directive_id");
  assertUnique(groupIds, "duplicate_work_group_id");
  assertUnique(verifyIds, "duplicate_verification_directive_id");
  assertDag(executionDirectives.map((directive) => ({
    id: directive.directive_id, dependencies: directive.depends_on_directive_ids,
  })), "execution_directive_dependency_cycle");
  assertDag(workGroups.map((group) => ({
    id: group.work_group_id, dependencies: group.depends_on_work_group_ids,
  })), "work_group_dependency_cycle");
  const partition = workGroups.flatMap(({ directive_ids }) => directive_ids);
  if (
    partition.length !== directiveIds.length
    || new Set(partition).size !== partition.length
    || directiveIds.some((id) => !partition.includes(id))
  ) throw new Error("work_group_directive_partition");
  const groupByDirective = new Map(workGroups.flatMap((group) =>
    group.directive_ids.map((id) => [id, group.work_group_id] as const)));
  for (const directive of executionDirectives) {
    const groupId = groupByDirective.get(directive.directive_id);
    for (const dependency of directive.depends_on_directive_ids) {
      const dependencyGroupId = groupByDirective.get(dependency);
      if (groupId !== dependencyGroupId) {
        const group = workGroups.find(({ work_group_id }) => work_group_id === groupId);
        if (dependencyGroupId === undefined || !group?.depends_on_work_group_ids.includes(dependencyGroupId)) {
          throw new Error("work_group_dependency_does_not_cover_directive_dependency");
        }
      }
    }
  }
  const predecessorCycleId = parseNullable(record.predecessor_cycle_issue_id, parseTaskIssueId);
  const predecessorRecordId = parseIdentifier(record.predecessor_terminal_record_id, "invalid_predecessor_record_id");
  if ((predecessorCycleId === null) !== (predecessorRecordId === "first_cycle")) {
    throw new Error("invalid_cycle_predecessor_anchor");
  }
  return Object.freeze({
    cycle_id: parseTaskIssueId(record.cycle_id),
    root_id: parseRootIssueId(record.root_id),
    predecessor_cycle_issue_id: predecessorCycleId,
    predecessor_terminal_record_id: predecessorRecordId,
    approval_record_id: parseIdentifier(record.approval_record_id),
    plan_issue_id: parseTaskIssueId(record.plan_issue_id),
    plan_completion_record_id: parseIdentifier(record.plan_completion_record_id),
    plan_invalidation_record_id: parseIdentifier(record.plan_invalidation_record_id),
    cycle_completion_record_id: parseIdentifier(record.cycle_completion_record_id),
    cycle_invalidation_record_id: parseIdentifier(record.cycle_invalidation_record_id),
    delivery_completion_record_id: parseIdentifier(record.delivery_completion_record_id),
    delivery_invalidation_record_id: parseIdentifier(record.delivery_invalidation_record_id),
    identity_derivation_version: parseIdentifier(record.identity_derivation_version, "invalid_identity_derivation_version"),
    workspace_base_revision: parseDigest(record.workspace_base_revision, "invalid_workspace_base_revision"),
    root_definition_revision: parseCanonicalRevision(record.root_definition_revision),
    cycle_specification_markdown: parseMarkdownText(record.cycle_specification_markdown, "invalid_cycle_specification"),
    root_adr_markdown: parseMarkdownText(record.root_adr_markdown, "invalid_root_adr"),
    execution_directives: executionDirectives,
    approved_work_groups: workGroups,
    verify_directives: verifyDirectives,
    specification_seal_digest: parseNullable(record.specification_seal_digest, (entry) =>
      parseDigest(entry, "invalid_specification_seal_digest")),
  });
}

export interface TaskIssueRecordCommon {
  readonly record_id: string;
  readonly revision: TaskRevision;
  readonly issue_id: TaskIssueId;
  readonly cycle_id: TaskIssueId;
  readonly actor_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: null;
  readonly basis_issue_revision: TaskRevision;
  readonly basis_status: TaskStatus;
  readonly basis_document_digest: Digest;
}

const COMMON_RECORD_KEYS = [
  "record_id", "revision", "issue_id", "cycle_id", "actor_id", "created_at", "updated_at",
  "archived_at", "basis_issue_revision", "basis_status", "basis_document_digest",
] as const;

function parseRecordCommon(record: UnknownRecord): TaskIssueRecordCommon {
  const createdAt = parseTimestamp(record.created_at, "invalid_record_created_at");
  const updatedAt = parseTimestamp(record.updated_at, "invalid_record_updated_at");
  if (record.archived_at !== null) throw new Error("record_not_write_once");
  return Object.freeze({
    record_id: parseIdentifier(record.record_id, "invalid_record_id"),
    revision: parseCanonicalRevision(record.revision),
    issue_id: parseTaskIssueId(record.issue_id),
    cycle_id: parseTaskIssueId(record.cycle_id),
    actor_id: parseIdentifier(record.actor_id, "invalid_actor_id"),
    created_at: createdAt,
    updated_at: updatedAt,
    archived_at: null,
    basis_issue_revision: parseCanonicalRevision(record.basis_issue_revision),
    basis_status: parseEnum(record.basis_status, TASK_STATUSES),
    basis_document_digest: parseDigest(record.basis_document_digest, "invalid_basis_document_digest"),
  });
}

export interface CycleApprovalRecord extends TaskIssueRecordCommon {
  readonly record_kind: "cycle_approval";
  readonly identity_derivation_version: string;
  readonly predecessor_cycle_issue_id: TaskIssueId | null;
  readonly predecessor_terminal_record_id: string;
  readonly plan_issue_id: TaskIssueId;
  readonly plan_completion_record_id: string;
  readonly plan_invalidation_record_id: string;
  readonly cycle_completion_record_id: string;
  readonly cycle_invalidation_record_id: string;
  readonly delivery_completion_record_id: string;
  readonly delivery_invalidation_record_id: string;
  readonly specification_seal_digest: Digest;
  readonly workspace_base_revision: Digest;
}

const APPROVAL_ANCHOR_KEYS = [
  "identity_derivation_version", "predecessor_cycle_issue_id", "predecessor_terminal_record_id",
  "plan_issue_id", "plan_completion_record_id", "plan_invalidation_record_id",
  "cycle_completion_record_id", "cycle_invalidation_record_id", "delivery_completion_record_id",
  "delivery_invalidation_record_id", "specification_seal_digest", "workspace_base_revision",
] as const;

function parseCycleApprovalRecordShape(value: unknown): CycleApprovalRecord {
  const record = asRecord(value);
  assertExactKeys(record, [...COMMON_RECORD_KEYS, "record_kind", ...APPROVAL_ANCHOR_KEYS]);
  if (record.record_kind !== "cycle_approval") throw new Error("invalid_contract_variant");
  const common = parseRecordCommon(record);
  const parsed = Object.freeze({
    ...common,
    record_kind: "cycle_approval" as const,
    identity_derivation_version: parseIdentifier(record.identity_derivation_version),
    predecessor_cycle_issue_id: parseNullable(record.predecessor_cycle_issue_id, parseTaskIssueId),
    predecessor_terminal_record_id: parseIdentifier(record.predecessor_terminal_record_id),
    plan_issue_id: parseTaskIssueId(record.plan_issue_id),
    plan_completion_record_id: parseIdentifier(record.plan_completion_record_id),
    plan_invalidation_record_id: parseIdentifier(record.plan_invalidation_record_id),
    cycle_completion_record_id: parseIdentifier(record.cycle_completion_record_id),
    cycle_invalidation_record_id: parseIdentifier(record.cycle_invalidation_record_id),
    delivery_completion_record_id: parseIdentifier(record.delivery_completion_record_id),
    delivery_invalidation_record_id: parseIdentifier(record.delivery_invalidation_record_id),
    specification_seal_digest: parseDigest(record.specification_seal_digest),
    workspace_base_revision: parseDigest(record.workspace_base_revision),
  });
  if (parsed.basis_status !== "Draft") throw new Error("cycle_approval_source_status_mismatch");
  return parsed;
}

export function parseCycleApprovalRecord(value: unknown, specification: CycleSpecification): CycleApprovalRecord {
  if (specification.specification_seal_digest === null) throw new Error("unsealed_cycle_specification");
  const parsed = parseCycleApprovalRecordShape(value);
  const expected: Record<string, unknown> = {
    record_id: specification.approval_record_id,
    issue_id: specification.cycle_id,
    cycle_id: specification.cycle_id,
    ...Object.fromEntries(APPROVAL_ANCHOR_KEYS.map((key) => [key, specification[key]])),
  };
  if (Object.entries(expected).some(([key, expectedValue]) => parsed[key as keyof typeof parsed] !== expectedValue)) {
    throw new Error("cycle_approval_anchor_mismatch");
  }
  return parsed;
}

interface ManifestNodeCommon {
  readonly issue_id: TaskIssueId;
  readonly parent_issue_id: TaskIssueId;
  readonly completion_record_id: string;
  readonly invalidation_record_id: string;
  readonly title: string;
  readonly instruction_digest: Digest;
}

export interface ManifestPlanNode extends ManifestNodeCommon { readonly kind: "plan" }
export interface ManifestWorkNode extends ManifestNodeCommon {
  readonly kind: "work";
  readonly approved_work_group_id: string;
  readonly directive_ids: readonly [string, ...string[]];
}
export interface ManifestVerifyNode extends ManifestNodeCommon {
  readonly kind: "verify";
  readonly directive_ids: readonly [string, ...string[]];
}

export type ManifestRelation = Readonly<Record<string, unknown>> & {
  readonly relation_id: string;
  readonly relation_role: "work_dependency" | "verify_barrier";
  readonly source_issue_id: TaskIssueId;
  readonly target_issue_id: TaskIssueId;
};

export interface PlanGraphManifest {
  readonly cycle_id: TaskIssueId;
  readonly approval_record_id: string;
  readonly specification_seal_digest: Digest;
  readonly plan_issue_id: TaskIssueId;
  readonly plan: ManifestPlanNode;
  readonly ordered_work_nodes: readonly [ManifestWorkNode, ...ManifestWorkNode[]];
  readonly ordered_work_issue_ids: readonly [TaskIssueId, ...TaskIssueId[]];
  readonly verify_node: ManifestVerifyNode;
  readonly verify_issue_id: TaskIssueId;
  readonly relations: readonly ManifestRelation[];
}

function parseManifestCommon(record: UnknownRecord): ManifestNodeCommon {
  return Object.freeze({
    issue_id: parseTaskIssueId(record.issue_id),
    parent_issue_id: parseTaskIssueId(record.parent_issue_id),
    completion_record_id: parseIdentifier(record.completion_record_id),
    invalidation_record_id: parseIdentifier(record.invalidation_record_id),
    title: parseBoundedString(record.title, "invalid_manifest_title", 1_024),
    instruction_digest: parseDigest(record.instruction_digest, "invalid_instruction_digest"),
  });
}

function parsePlanNode(value: unknown): ManifestPlanNode {
  const record = asRecord(value);
  assertExactKeys(record, [
    "kind", "issue_id", "parent_issue_id", "completion_record_id", "invalidation_record_id",
    "title", "instruction_digest",
  ]);
  if (record.kind !== "plan") throw new Error("invalid_manifest_node_kind");
  return Object.freeze({ kind: "plan", ...parseManifestCommon(record) });
}

function parseWorkNode(value: unknown): ManifestWorkNode {
  const record = asRecord(value);
  assertExactKeys(record, [
    "kind", "issue_id", "parent_issue_id", "completion_record_id", "invalidation_record_id",
    "title", "instruction_digest", "approved_work_group_id", "directive_ids",
  ]);
  if (record.kind !== "work") throw new Error("invalid_manifest_node_kind");
  const directiveIds = nonEmptyArray(
    record.directive_ids, (entry) => parseIdentifier(entry), "empty_manifest_work_directives", MAX_DIRECTIVES,
  );
  assertUnique(directiveIds, "duplicate_contract_identity");
  return Object.freeze({
    kind: "work", ...parseManifestCommon(record),
    approved_work_group_id: parseIdentifier(record.approved_work_group_id),
    directive_ids: directiveIds,
  });
}

function parseVerifyNode(value: unknown): ManifestVerifyNode {
  const record = asRecord(value);
  assertExactKeys(record, [
    "kind", "issue_id", "parent_issue_id", "completion_record_id", "invalidation_record_id",
    "title", "instruction_digest", "directive_ids",
  ]);
  if (record.kind !== "verify") throw new Error("invalid_manifest_node_kind");
  const directiveIds = nonEmptyArray(
    record.directive_ids, (entry) => parseIdentifier(entry), "empty_manifest_verify_directives", MAX_DIRECTIVES,
  );
  assertUnique(directiveIds, "duplicate_contract_identity");
  return Object.freeze({ kind: "verify", ...parseManifestCommon(record), directive_ids: directiveIds });
}

function parseManifestRelation(value: unknown): ManifestRelation {
  const record = asRecord(value);
  const role = parseEnum(record.relation_role, ["work_dependency", "verify_barrier"] as const);
  assertExactKeys(record, role === "work_dependency" ? [
    "relation_id", "relation_role", "type", "prerequisite_work_group_id",
    "dependent_work_group_id", "source_issue_id", "target_issue_id",
  ] : [
    "relation_id", "relation_role", "type", "prerequisite_work_group_id",
    "source_issue_id", "target_issue_id",
  ]);
  if (record.type !== "blocks") throw new Error("invalid_manifest_relation_type");
  const base = {
    relation_id: parseTaskRelationId(record.relation_id),
    relation_role: role,
    type: "blocks" as const,
    prerequisite_work_group_id: parseIdentifier(record.prerequisite_work_group_id),
    source_issue_id: parseTaskIssueId(record.source_issue_id),
    target_issue_id: parseTaskIssueId(record.target_issue_id),
  };
  return Object.freeze(role === "work_dependency" ? {
    ...base,
    dependent_work_group_id: parseIdentifier(record.dependent_work_group_id),
  } : base);
}

export interface SealedCycleBasis {
  readonly specification: CycleSpecification;
  readonly approval_record: CycleApprovalRecord;
}

export function parsePlanGraphManifest(value: unknown, basis?: SealedCycleBasis): PlanGraphManifest {
  const record = asRecord(value);
  assertExactKeys(record, [
    "cycle_id", "approval_record_id", "specification_seal_digest", "plan_issue_id", "plan",
    "ordered_work_nodes", "ordered_work_issue_ids", "verify_node", "verify_issue_id", "relations",
  ]);
  const plan = parsePlanNode(record.plan);
  const works = nonEmptyArray(record.ordered_work_nodes, parseWorkNode, "empty_manifest_work_nodes", MAX_DIRECTIVES);
  const orderedIds = nonEmptyArray(
    record.ordered_work_issue_ids, parseTaskIssueId, "empty_manifest_work_order", MAX_DIRECTIVES,
  );
  const verify = parseVerifyNode(record.verify_node);
  const relations = parseArray(record.relations, parseManifestRelation, MAX_RECORD_ITEMS);
  assertUnique(works.map(({ issue_id }) => issue_id), "duplicate_manifest_work_issue");
  assertUnique(works.map(({ approved_work_group_id }) => approved_work_group_id), "duplicate_manifest_work_group");
  assertUnique(
    [plan.issue_id, ...works.map(({ issue_id }) => issue_id), verify.issue_id],
    "duplicate_manifest_issue_identity",
  );
  assertUnique([
    plan.completion_record_id, plan.invalidation_record_id,
    ...works.flatMap((work) => [work.completion_record_id, work.invalidation_record_id]),
    verify.completion_record_id, verify.invalidation_record_id,
  ], "duplicate_manifest_record_identity");
  assertUnique(relations.map(({ relation_id }) => relation_id), "duplicate_manifest_relation_identity");
  if (!sameOrdered(orderedIds, works.map(({ issue_id }) => issue_id))) {
    throw new Error("manifest_work_order_mismatch");
  }
  if (basis !== undefined) {
    const specification = basis.specification;
    if (specification.specification_seal_digest === null) throw new Error("unsealed_cycle_specification");
    const anchorMismatch = record.cycle_id !== specification.cycle_id
      || record.approval_record_id !== basis.approval_record.record_id
      || record.specification_seal_digest !== specification.specification_seal_digest
      || record.plan_issue_id !== specification.plan_issue_id
      || plan.issue_id !== specification.plan_issue_id
      || plan.parent_issue_id !== specification.cycle_id
      || plan.completion_record_id !== specification.plan_completion_record_id
      || plan.invalidation_record_id !== specification.plan_invalidation_record_id
      || verify.parent_issue_id !== specification.cycle_id
      || record.verify_issue_id !== verify.issue_id;
    if (anchorMismatch) throw new Error("manifest_anchor_mismatch");
    const groups = new Map(specification.approved_work_groups.map((group) => [group.work_group_id, group]));
    if (works.length !== groups.size) throw new Error("manifest_work_group_cover_mismatch");
    for (const work of works) {
      const group = groups.get(work.approved_work_group_id);
      if (group === undefined || work.parent_issue_id !== specification.cycle_id
        || !sameOrdered(work.directive_ids, group.directive_ids)) {
        throw new Error("manifest_work_group_cover_mismatch");
      }
    }
    const workPosition = new Map(works.map((work, index) => [work.approved_work_group_id, index]));
    for (const group of specification.approved_work_groups) {
      const position = workPosition.get(group.work_group_id);
      if (position === undefined || group.depends_on_work_group_ids.some((dependency) => {
        const dependencyPosition = workPosition.get(dependency);
        return dependencyPosition === undefined || dependencyPosition >= position;
      })) throw new Error("manifest_work_order_not_topological");
    }
    if (!sameOrdered(verify.directive_ids, specification.verify_directives.map(({ directive_id }) => directive_id))) {
      throw new Error("manifest_verify_directive_mismatch");
    }
    const workByGroup = new Map(works.map((work) => [work.approved_work_group_id, work]));
    const expectedRelations = new Set<string>();
    for (const group of specification.approved_work_groups) {
      const target = workByGroup.get(group.work_group_id);
      if (target === undefined) throw new Error("manifest_work_group_cover_mismatch");
      for (const dependencyId of group.depends_on_work_group_ids) {
        const source = workByGroup.get(dependencyId);
        if (source === undefined) throw new Error("manifest_work_group_cover_mismatch");
        expectedRelations.add(`work_dependency|${dependencyId}|${group.work_group_id}|${source.issue_id}|${target.issue_id}`);
      }
      expectedRelations.add(`verify_barrier|${group.work_group_id}|${target.issue_id}|${verify.issue_id}`);
    }
    const observedRelations = relations.map((relation) => relation.relation_role === "work_dependency"
      ? `${relation.relation_role}|${String(relation.prerequisite_work_group_id)}|${String(relation.dependent_work_group_id)}|${relation.source_issue_id}|${relation.target_issue_id}`
      : `${relation.relation_role}|${String(relation.prerequisite_work_group_id)}|${relation.source_issue_id}|${relation.target_issue_id}`);
    if (observedRelations.length !== expectedRelations.size
      || new Set(observedRelations).size !== observedRelations.length
      || observedRelations.some((key) => !expectedRelations.has(key))) {
      throw new Error("manifest_relation_set_mismatch");
    }
  }
  return Object.freeze({
    cycle_id: parseTaskIssueId(record.cycle_id),
    approval_record_id: parseIdentifier(record.approval_record_id),
    specification_seal_digest: parseDigest(record.specification_seal_digest),
    plan_issue_id: parseTaskIssueId(record.plan_issue_id),
    plan,
    ordered_work_nodes: works,
    ordered_work_issue_ids: orderedIds,
    verify_node: verify,
    verify_issue_id: parseTaskIssueId(record.verify_issue_id),
    relations,
  });
}

type StageKind = "plan" | "work" | "verify";

function parseCheckMarkdown(value: unknown): MarkdownText {
  return parseMarkdownText(value, "invalid_completion_checks");
}

interface WorkCompletionEvidence {
  readonly instruction_digest: Digest;
  readonly workspace_parent_revision: Digest;
  readonly workspace_diff_digest: Digest;
  readonly checks_markdown: MarkdownText;
  readonly normalized_handoff_markdown: MarkdownText;
}

export type WorkCompletion = WorkCompletionEvidence & (
  { readonly outcome: "completed" }
  | {
    readonly outcome: "failed" | "canceled";
    readonly reason_code: string;
    readonly reason_markdown: MarkdownText;
  }
);

export type VerifyCompletion = {
  readonly instruction_digest: Digest;
  readonly exact_revision: Digest;
  readonly checks_markdown: MarkdownText;
  readonly evidence_markdown: MarkdownText;
} & (
  { readonly conclusion: "passed" }
  | { readonly conclusion: "failed"; readonly reason_markdown: MarkdownText }
  | {
    readonly conclusion: "inconclusive" | "canceled";
    readonly reason_code: string;
    readonly reason_markdown: MarkdownText;
  }
);

export type PlanCompletion = {
  readonly outcome: "completed";
  readonly instruction_digest: Digest;
  readonly manifest: PlanGraphManifest;
  readonly graph_seal_digest: Digest;
  readonly traceability_by_issue_id_markdown: MarkdownText;
} | {
  readonly outcome: "failed" | "canceled";
  readonly instruction_digest: Digest;
  readonly reason_markdown: MarkdownText;
};

function parseWorkCompletion(value: unknown): WorkCompletion {
  const record = asRecord(value);
  const outcome = parseEnum(record.outcome, ["completed", "failed", "canceled"] as const);
  const reasonKeys = outcome === "completed" ? [] : ["reason_code", "reason_markdown"];
  assertExactKeys(record, [
    "outcome", "instruction_digest", "workspace_parent_revision", "workspace_diff_digest",
    "checks_markdown", "normalized_handoff_markdown", ...reasonKeys,
  ]);
  const evidence = {
    instruction_digest: parseDigest(record.instruction_digest),
    workspace_parent_revision: parseDigest(record.workspace_parent_revision),
    workspace_diff_digest: parseDigest(record.workspace_diff_digest),
    checks_markdown: parseCheckMarkdown(record.checks_markdown),
    normalized_handoff_markdown: parseMarkdownText(record.normalized_handoff_markdown, "invalid_work_handoff"),
  };
  if (outcome === "completed") return Object.freeze({ ...evidence, outcome });
  return Object.freeze({
    ...evidence, outcome,
    reason_code: parseIdentifier(record.reason_code, "invalid_completion_reason_code"),
    reason_markdown: parseMarkdownText(record.reason_markdown, "invalid_completion_reason"),
  });
}

function parseVerifyCompletion(value: unknown): VerifyCompletion {
  const record = asRecord(value);
  const conclusion = parseEnum(record.conclusion, ["passed", "failed", "inconclusive", "canceled"] as const);
  const reasonKeys = conclusion === "passed" ? [] : conclusion === "failed"
    ? ["reason_markdown"] : ["reason_code", "reason_markdown"];
  assertExactKeys(record, [
    "conclusion", "instruction_digest", "exact_revision", "checks_markdown", "evidence_markdown",
    ...reasonKeys,
  ]);
  const evidence = {
    instruction_digest: parseDigest(record.instruction_digest),
    exact_revision: parseDigest(record.exact_revision, "invalid_exact_revision"),
    checks_markdown: parseCheckMarkdown(record.checks_markdown),
    evidence_markdown: parseMarkdownText(record.evidence_markdown, "invalid_verify_evidence"),
  };
  if (conclusion === "passed") {
    return Object.freeze({ ...evidence, conclusion });
  }
  if (conclusion === "failed") {
    return Object.freeze({
      ...evidence,
      conclusion,
      reason_markdown: parseMarkdownText(record.reason_markdown, "invalid_completion_reason"),
    });
  }
  return Object.freeze({
    ...evidence, conclusion,
    reason_code: parseIdentifier(record.reason_code, "invalid_completion_reason_code"),
    reason_markdown: parseMarkdownText(record.reason_markdown, "invalid_completion_reason"),
  });
}

function parsePlanCompletion(
  value: unknown,
  basis: SealedCycleBasis | undefined,
): PlanCompletion {
  const record = asRecord(value);
  const outcome = parseEnum(record.outcome, ["completed", "failed", "canceled"] as const);
  if (outcome === "completed") {
    assertExactKeys(record, [
      "outcome", "instruction_digest", "manifest", "graph_seal_digest", "traceability_by_issue_id_markdown",
    ]);
    return Object.freeze({
      outcome,
      instruction_digest: parseDigest(record.instruction_digest),
      manifest: parsePlanGraphManifest(record.manifest, basis),
      graph_seal_digest: parseDigest(record.graph_seal_digest),
      traceability_by_issue_id_markdown: parseMarkdownText(
        record.traceability_by_issue_id_markdown, "invalid_plan_traceability",
      ),
    });
  }
  assertExactKeys(record, ["outcome", "instruction_digest", "reason_markdown"]);
  return Object.freeze({
    outcome,
    instruction_digest: parseDigest(record.instruction_digest),
    reason_markdown: parseMarkdownText(record.reason_markdown, "invalid_completion_reason"),
  });
}

export type StageCompletion = PlanCompletion | WorkCompletion | VerifyCompletion;

export function stageCompletionTerminalStatus(
  completion: StageCompletion,
): typeof STAGE_TERMINAL_STATUSES[number] {
  if ("conclusion" in completion) {
    if (completion.conclusion === "passed") return "Done";
    if (completion.conclusion === "canceled") return "Canceled";
    return "Failed";
  }
  if (completion.outcome === "completed") return "Done";
  return completion.outcome === "failed" ? "Failed" : "Canceled";
}

export interface StageCompletionRecord extends Omit<TaskIssueRecordCommon, "basis_status"> {
  readonly record_kind: "stage_completion";
  readonly stage_id: TaskIssueId;
  readonly basis_status: "In Progress";
  readonly completion: StageCompletion;
}

export function parseStageCompletionRecord(
  value: unknown,
  stageKind: "work",
  basis?: SealedCycleBasis,
): StageCompletionRecord & { readonly completion: WorkCompletion };
export function parseStageCompletionRecord(
  value: unknown,
  stageKind: "verify",
  basis?: SealedCycleBasis,
): StageCompletionRecord & { readonly completion: VerifyCompletion };
export function parseStageCompletionRecord(
  value: unknown,
  stageKind: "plan",
  basis?: SealedCycleBasis,
): StageCompletionRecord & { readonly completion: PlanCompletion };
export function parseStageCompletionRecord(
  value: unknown,
  stageKind: StageKind,
  basis?: SealedCycleBasis,
): StageCompletionRecord;
export function parseStageCompletionRecord(
  value: unknown,
  stageKind: StageKind,
  basis?: SealedCycleBasis,
): StageCompletionRecord {
  const record = asRecord(value);
  assertExactKeys(record, [...COMMON_RECORD_KEYS, "record_kind", "stage_id", "completion"]);
  if (record.record_kind !== "stage_completion") throw new Error("invalid_contract_variant");
  const common = parseRecordCommon(record);
  const stageId = parseTaskIssueId(record.stage_id);
  if (common.issue_id !== stageId || common.basis_status !== "In Progress") {
    throw new Error("stage_completion_source_mismatch");
  }
  const completion = stageKind === "work"
    ? parseWorkCompletion(record.completion)
    : stageKind === "verify"
      ? parseVerifyCompletion(record.completion)
      : parsePlanCompletion(record.completion, basis);
  return Object.freeze({
    ...common,
    basis_status: "In Progress",
    record_kind: "stage_completion",
    stage_id: stageId,
    completion,
  });
}

const STAGE_INVALIDATION_KINDS = [
  "invalid_terminal", "invalid_record_basis", "unresolvable_record_slot", "authoritative_record_lost",
  "sealed_fact_mutated", "invalid_status_transition",
] as const;

interface StageInvalidationRecordCommon extends Omit<TaskIssueRecordCommon, "basis_status"> {
  readonly record_kind: "stage_invalidation";
  readonly stage_id: TaskIssueId;
  readonly observed_status: TaskStatus;
  readonly observed_instruction_digest: Digest;
  readonly observed_completion_record_digest: Digest | null;
  readonly observed_history_digest: Digest;
  readonly reason_code: string;
  readonly reason_markdown: MarkdownText;
  readonly basis_status: "Todo" | "In Progress";
}

export type StageInvalidationRecord = StageInvalidationRecordCommon & (
  {
    readonly invalidation_kind: "invalid_terminal";
    readonly terminal_status: typeof STAGE_TERMINAL_STATUSES[number];
  }
  | {
    readonly invalidation_kind: Exclude<typeof STAGE_INVALIDATION_KINDS[number], "invalid_terminal">;
    readonly terminal_status: "Failed";
  }
);

export function parseStageInvalidationRecord(value: unknown): StageInvalidationRecord {
  const record = asRecord(value);
  assertExactKeys(record, [
    ...COMMON_RECORD_KEYS, "record_kind", "stage_id", "observed_status", "observed_instruction_digest",
    "observed_completion_record_digest", "observed_history_digest", "reason_code", "reason_markdown",
    "invalidation_kind", "terminal_status",
  ]);
  if (record.record_kind !== "stage_invalidation") throw new Error("invalid_contract_variant");
  const common = parseRecordCommon(record);
  const kind = parseEnum(record.invalidation_kind, STAGE_INVALIDATION_KINDS);
  const terminalStatus = parseEnum(record.terminal_status, STAGE_TERMINAL_STATUSES);
  const stageId = parseTaskIssueId(record.stage_id);
  if (common.issue_id !== stageId || !["Todo", "In Progress"].includes(common.basis_status)) {
    throw new Error("stage_invalidation_source_mismatch");
  }
  if (kind !== "invalid_terminal" && terminalStatus !== "Failed") {
    throw new Error("invalid_stage_invalidation_terminal_status");
  }
  if (kind === "invalid_terminal" && record.observed_status !== terminalStatus) {
    throw new Error("invalid_stage_invalidation_terminal_status");
  }
  return Object.freeze({
    ...common,
    record_kind: "stage_invalidation",
    stage_id: stageId,
    observed_status: parseEnum(record.observed_status, TASK_STATUSES),
    observed_instruction_digest: parseDigest(record.observed_instruction_digest),
    observed_completion_record_digest: parseNullable(record.observed_completion_record_digest, parseDigest),
    observed_history_digest: parseDigest(record.observed_history_digest),
    reason_code: parseIdentifier(record.reason_code, "invalid_invalidation_reason_code"),
    reason_markdown: parseMarkdownText(record.reason_markdown, "invalid_invalidation_reason"),
    invalidation_kind: kind,
    terminal_status: terminalStatus,
  }) as StageInvalidationRecord;
}

function parseStageDigestEntry(value: unknown, revisionEntry: true): StageRevisionEvidence;
function parseStageDigestEntry(value: unknown, revisionEntry: false): StageCompletionDigestEvidence;
function parseStageDigestEntry(
  value: unknown,
  revisionEntry: boolean,
): StageRevisionEvidence | StageCompletionDigestEvidence {
  const record = asRecord(value);
  assertExactKeys(record, revisionEntry
    ? ["issue_id", "revision", "terminal_record_digest"]
    : ["issue_id", "digest"]);
  return Object.freeze(revisionEntry ? {
    issue_id: parseTaskIssueId(record.issue_id),
    revision: parseCanonicalRevision(record.revision),
    terminal_record_digest: parseDigest(record.terminal_record_digest),
  } : {
    issue_id: parseTaskIssueId(record.issue_id), digest: parseDigest(record.digest),
  });
}

function parseAcceptanceProof(value: unknown): Readonly<Record<string, unknown>> {
  const record = asRecord(value);
  assertExactKeys(record, ["proof_scope", "first_round", "second_round", "observation_order", "stable_decision_basis_digest"]);
  if (record.proof_scope !== "acceptance" || record.observation_order !== "linear -> git -> linear -> git") {
    throw new Error("invalid_acceptance_convergence_proof");
  }
  const parseRound = (entry: unknown): Readonly<Record<string, unknown>> => {
    const round = asRecord(entry);
    assertExactKeys(round, [
      "linear_snapshot_digest", "linear_observed_at", "git_exact_revision", "git_observed_at", "root_revision",
    ]);
    return Object.freeze({
      linear_snapshot_digest: parseDigest(round.linear_snapshot_digest),
      linear_observed_at: parseTimestamp(round.linear_observed_at, "invalid_linear_observed_at"),
      git_exact_revision: parseDigest(round.git_exact_revision),
      git_observed_at: parseTimestamp(round.git_observed_at, "invalid_git_observed_at"),
      root_revision: parseCanonicalRevision(round.root_revision),
    });
  };
  const firstRound = parseRound(record.first_round);
  const secondRound = parseRound(record.second_round);
  if (
    firstRound.linear_snapshot_digest !== secondRound.linear_snapshot_digest
    || firstRound.git_exact_revision !== secondRound.git_exact_revision
    || firstRound.root_revision !== secondRound.root_revision
  ) throw new Error("unstable_acceptance_convergence_proof");
  return Object.freeze({
    proof_scope: "acceptance",
    first_round: firstRound,
    second_round: secondRound,
    observation_order: "linear -> git -> linear -> git",
    stable_decision_basis_digest: parseDigest(record.stable_decision_basis_digest),
  });
}

interface StageRevisionEvidence {
  readonly issue_id: TaskIssueId;
  readonly revision: TaskRevision;
  readonly terminal_record_digest: Digest;
}

interface StageCompletionDigestEvidence {
  readonly issue_id: TaskIssueId;
  readonly digest: Digest;
}

interface AcceptanceCycleEvidence {
  readonly specification_seal_digest: Digest;
  readonly graph_seal_digest: Digest;
  readonly acceptance_basis_digest: Digest;
  readonly stage_revisions: readonly [StageRevisionEvidence, ...StageRevisionEvidence[]];
  readonly stage_completion_digests: readonly [StageCompletionDigestEvidence, ...StageCompletionDigestEvidence[]];
  readonly exact_revision: Digest;
  readonly acceptance_convergence_proof: Readonly<Record<string, unknown>>;
}

export type CycleCompletion =
  | (AcceptanceCycleEvidence & { readonly outcome: "accepted"; readonly acceptance_markdown: MarkdownText })
  | (AcceptanceCycleEvidence & { readonly outcome: "rejected"; readonly reason_markdown: MarkdownText })
  | {
    readonly outcome: "failed" | "canceled";
    readonly failure_phase: "draft";
    readonly draft_specification_digest: Digest;
    readonly observed_cycle_document_digest: Digest;
    readonly reason_code: string;
    readonly reason_markdown: MarkdownText;
  }
  | {
    readonly outcome: "failed" | "canceled";
    readonly failure_phase: "in_progress";
    readonly specification_seal_digest: Digest;
    readonly graph_seal_digest: Digest | null;
    readonly observed_execution_graph_digest: Digest;
    readonly observed_cycle_document_digest: Digest;
    readonly failed_stage_id: TaskIssueId | null;
    readonly reason_code: string;
    readonly reason_markdown: MarkdownText;
  }
  | (AcceptanceCycleEvidence & {
    readonly outcome: "canceled";
    readonly failure_phase: "awaiting_acceptance";
    readonly reason_code: string;
    readonly reason_markdown: MarkdownText;
  });

export function cycleCompletionTerminalStatus(
  completion: CycleCompletion,
): typeof CYCLE_TERMINAL_STATUSES[number] {
  if (completion.outcome === "accepted") return "Succeeded";
  if (completion.outcome === "rejected") return "Rejected";
  return completion.outcome === "failed" ? "Failed" : "Canceled";
}

function parseCycleCompletion(value: unknown): CycleCompletion {
  const record = asRecord(value);
  const outcome = parseEnum(record.outcome, ["accepted", "rejected", "failed", "canceled"] as const);
  if (outcome === "accepted" || outcome === "rejected") {
    assertExactKeys(record, [
      "outcome", "specification_seal_digest", "graph_seal_digest", "acceptance_basis_digest",
      "stage_revisions", "stage_completion_digests", "exact_revision", "acceptance_convergence_proof",
      outcome === "accepted" ? "acceptance_markdown" : "reason_markdown",
    ]);
    const stageRevisions = nonEmptyArray(record.stage_revisions, (entry) => parseStageDigestEntry(entry, true), "empty_stage_revisions");
    const stageDigests = nonEmptyArray(record.stage_completion_digests, (entry) => parseStageDigestEntry(entry, false), "empty_stage_completion_digests");
    const revisionIds = stageRevisions.map((entry) => String(entry.issue_id));
    const digestIds = stageDigests.map((entry) => String(entry.issue_id));
    assertUnique(revisionIds, "duplicate_stage_revision");
    assertUnique(digestIds, "duplicate_stage_completion_digest");
    if (!sameOrdered(revisionIds, digestIds)) throw new Error("stage_acceptance_basis_mismatch");
    const evidence = {
      specification_seal_digest: parseDigest(record.specification_seal_digest),
      graph_seal_digest: parseDigest(record.graph_seal_digest),
      acceptance_basis_digest: parseDigest(record.acceptance_basis_digest),
      stage_revisions: stageRevisions,
      stage_completion_digests: stageDigests,
      exact_revision: parseDigest(record.exact_revision),
      acceptance_convergence_proof: parseAcceptanceProof(record.acceptance_convergence_proof),
    };
    if (outcome === "accepted") return Object.freeze({
      ...evidence, outcome,
      acceptance_markdown: parseMarkdownText(record.acceptance_markdown, "invalid_cycle_terminal_markdown"),
    });
    return Object.freeze({
      ...evidence, outcome,
      reason_markdown: parseMarkdownText(record.reason_markdown, "invalid_cycle_terminal_markdown"),
    });
  }
  const phase = parseEnum(record.failure_phase, CYCLE_PHASES);
  if (phase === "draft") {
    assertExactKeys(record, [
      "outcome", "failure_phase", "draft_specification_digest", "observed_cycle_document_digest",
      "reason_code", "reason_markdown",
    ]);
    return Object.freeze({
      outcome, failure_phase: phase,
      draft_specification_digest: parseDigest(record.draft_specification_digest),
      observed_cycle_document_digest: parseDigest(record.observed_cycle_document_digest),
      reason_code: parseIdentifier(record.reason_code),
      reason_markdown: parseMarkdownText(record.reason_markdown, "invalid_cycle_terminal_reason"),
    });
  }
  if (phase === "in_progress") {
    assertExactKeys(record, [
      "outcome", "failure_phase", "specification_seal_digest", "graph_seal_digest",
      "observed_execution_graph_digest", "observed_cycle_document_digest", "failed_stage_id",
      "reason_code", "reason_markdown",
    ]);
    return Object.freeze({
      outcome, failure_phase: phase,
      specification_seal_digest: parseDigest(record.specification_seal_digest),
      graph_seal_digest: parseNullable(record.graph_seal_digest, parseDigest),
      observed_execution_graph_digest: parseDigest(record.observed_execution_graph_digest),
      observed_cycle_document_digest: parseDigest(record.observed_cycle_document_digest),
      failed_stage_id: parseNullable(record.failed_stage_id, parseTaskIssueId),
      reason_code: parseIdentifier(record.reason_code),
      reason_markdown: parseMarkdownText(record.reason_markdown, "invalid_cycle_terminal_reason"),
    });
  }
  if (outcome !== "canceled") throw new Error("invalid_cycle_completion_phase");
  assertExactKeys(record, [
    "outcome", "failure_phase", "specification_seal_digest", "graph_seal_digest", "acceptance_basis_digest",
    "stage_revisions", "stage_completion_digests", "exact_revision", "acceptance_convergence_proof",
    "reason_code", "reason_markdown",
  ]);
  return Object.freeze({
    outcome, failure_phase: phase,
    specification_seal_digest: parseDigest(record.specification_seal_digest),
    graph_seal_digest: parseDigest(record.graph_seal_digest),
    acceptance_basis_digest: parseDigest(record.acceptance_basis_digest),
    stage_revisions: nonEmptyArray(record.stage_revisions, (entry) => parseStageDigestEntry(entry, true), "empty_stage_revisions"),
    stage_completion_digests: nonEmptyArray(record.stage_completion_digests, (entry) => parseStageDigestEntry(entry, false), "empty_stage_completion_digests"),
    exact_revision: parseDigest(record.exact_revision),
    acceptance_convergence_proof: parseAcceptanceProof(record.acceptance_convergence_proof),
    reason_code: parseIdentifier(record.reason_code),
    reason_markdown: parseMarkdownText(record.reason_markdown, "invalid_cycle_terminal_reason"),
  });
}

interface CycleCompletionRecordCommon extends Omit<TaskIssueRecordCommon, "basis_status"> {
  readonly record_kind: "cycle_completion";
}

export type CycleCompletionRecord = CycleCompletionRecordCommon & (
  {
    readonly basis_status: "Awaiting Acceptance";
    readonly successor_policy: "not_applicable";
    readonly completion: Extract<CycleCompletion, { readonly outcome: "accepted" }>;
  }
  | {
    readonly basis_status: "Awaiting Acceptance";
    readonly successor_policy: "allowed";
    readonly completion:
      | Extract<CycleCompletion, { readonly outcome: "rejected" }>
      | Extract<CycleCompletion, { readonly failure_phase: "awaiting_acceptance" }>;
  }
  | {
    readonly basis_status: "Draft";
    readonly successor_policy: "allowed";
    readonly completion: Extract<CycleCompletion, { readonly failure_phase: "draft" }>;
  }
  | {
    readonly basis_status: "In Progress";
    readonly successor_policy: "allowed";
    readonly completion: Extract<CycleCompletion, { readonly failure_phase: "in_progress" }>;
  }
);

export function parseCycleCompletionRecord(value: unknown): CycleCompletionRecord {
  const record = asRecord(value);
  assertExactKeys(record, [...COMMON_RECORD_KEYS, "record_kind", "successor_policy", "completion"]);
  if (record.record_kind !== "cycle_completion") throw new Error("invalid_contract_variant");
  const common = parseRecordCommon(record);
  if (common.issue_id !== common.cycle_id || !["Draft", "In Progress", "Awaiting Acceptance"].includes(common.basis_status)) {
    throw new Error("cycle_completion_source_mismatch");
  }
  const completion = parseCycleCompletion(record.completion);
  const policy = parseEnum(record.successor_policy, ["not_applicable", "allowed"] as const);
  if ((completion.outcome === "accepted") !== (policy === "not_applicable")) {
    throw new Error("invalid_cycle_completion_successor_policy");
  }
  const expectedPhase = common.basis_status === "Draft" ? "draft"
    : common.basis_status === "In Progress" ? "in_progress" : "awaiting_acceptance";
  if (
    (completion.outcome === "accepted" || completion.outcome === "rejected")
    && common.basis_status !== "Awaiting Acceptance"
  ) throw new Error("cycle_completion_phase_mismatch");
  if ("failure_phase" in completion && completion.failure_phase !== expectedPhase) {
    throw new Error("cycle_completion_phase_mismatch");
  }
  return Object.freeze({
    ...common, record_kind: "cycle_completion", successor_policy: policy, completion,
  }) as CycleCompletionRecord;
}

export type CycleInvalidationEvidence =
  | {
    readonly evidence_kind: "present_digest_mismatch";
    readonly resource_kind: "cycle" | "stage" | "record";
    readonly resource_id: string;
    readonly expected_digest: Digest;
    readonly observed_digest: Digest;
    readonly observed_revision: TaskRevision;
    readonly creation_evidence_digest: Digest | null;
  }
  | {
    readonly evidence_kind: "present_relation_mismatch";
    readonly resource_kind: "relation";
    readonly resource_id: string;
    readonly expected_relation_digest: Digest;
    readonly observed_relation_digest: Digest;
    readonly observed_revision: TaskRevision;
    readonly creation_evidence_digest: Digest;
  }
  | {
    readonly evidence_kind: "unexpected_resource";
    readonly resource_kind: "stage" | "relation" | "record";
    readonly resource_id: string;
    readonly observed_digest: Digest;
    readonly observed_revision: TaskRevision;
    readonly creation_evidence_digest: Digest | null;
  }
  | {
    readonly evidence_kind: "missing_manifest_resource";
    readonly resource_kind: "stage" | "relation" | "record";
    readonly resource_id: string;
    readonly expected_manifest_entry_digest: Digest;
    readonly last_known_revision: TaskRevision | null;
    readonly creation_evidence_digest: Digest | null;
  }
  | {
    readonly evidence_kind: "authoritative_body_lost";
    readonly resource_kind: "approval_record" | "plan_completion_record" | "stage_record" | "cycle_record";
    readonly resource_id: string;
    readonly observed_record_observation_digest: Digest;
  };

export function parseCycleInvalidationEvidence(value: unknown): CycleInvalidationEvidence {
  const record = asRecord(value);
  const kind = parseEnum(record.evidence_kind, [
    "present_digest_mismatch", "present_relation_mismatch", "unexpected_resource",
    "missing_manifest_resource", "authoritative_body_lost",
  ] as const);
  if (kind === "present_digest_mismatch") {
    assertExactKeys(record, [
      "evidence_kind", "resource_kind", "resource_id", "expected_digest", "observed_digest",
      "observed_revision", "creation_evidence_digest",
    ]);
    return Object.freeze({
      evidence_kind: kind,
      resource_kind: parseEnum(record.resource_kind, ["cycle", "stage", "record"] as const),
      resource_id: parseIdentifier(record.resource_id),
      expected_digest: parseDigest(record.expected_digest),
      observed_digest: parseDigest(record.observed_digest),
      observed_revision: parseCanonicalRevision(record.observed_revision),
      creation_evidence_digest: parseNullable(record.creation_evidence_digest, parseDigest),
    });
  }
  if (kind === "present_relation_mismatch") {
    assertExactKeys(record, [
      "evidence_kind", "resource_kind", "resource_id", "expected_relation_digest",
      "observed_relation_digest", "observed_revision", "creation_evidence_digest",
    ]);
    if (record.resource_kind !== "relation") throw new Error("invalid_invalidation_resource_kind");
    return Object.freeze({
      evidence_kind: kind, resource_kind: "relation",
      resource_id: parseIdentifier(record.resource_id),
      expected_relation_digest: parseDigest(record.expected_relation_digest),
      observed_relation_digest: parseDigest(record.observed_relation_digest),
      observed_revision: parseCanonicalRevision(record.observed_revision),
      creation_evidence_digest: parseDigest(record.creation_evidence_digest),
    });
  }
  if (kind === "unexpected_resource") {
    assertExactKeys(record, [
      "evidence_kind", "resource_kind", "resource_id", "observed_digest", "observed_revision",
      "creation_evidence_digest",
    ]);
    return Object.freeze({
      evidence_kind: kind,
      resource_kind: parseEnum(record.resource_kind, ["stage", "relation", "record"] as const),
      resource_id: parseIdentifier(record.resource_id), observed_digest: parseDigest(record.observed_digest),
      observed_revision: parseCanonicalRevision(record.observed_revision),
      creation_evidence_digest: parseNullable(record.creation_evidence_digest, parseDigest),
    });
  }
  if (kind === "missing_manifest_resource") {
    assertExactKeys(record, [
      "evidence_kind", "resource_kind", "resource_id", "expected_manifest_entry_digest",
      "last_known_revision", "creation_evidence_digest",
    ]);
    return Object.freeze({
      evidence_kind: kind,
      resource_kind: parseEnum(record.resource_kind, ["stage", "relation", "record"] as const),
      resource_id: parseIdentifier(record.resource_id),
      expected_manifest_entry_digest: parseDigest(record.expected_manifest_entry_digest),
      last_known_revision: parseNullable(record.last_known_revision, parseCanonicalRevision),
      creation_evidence_digest: parseNullable(record.creation_evidence_digest, parseDigest),
    });
  }
  assertExactKeys(record, ["evidence_kind", "resource_kind", "resource_id", "observed_record_observation_digest"]);
  return Object.freeze({
    evidence_kind: kind,
    resource_kind: parseEnum(record.resource_kind, [
      "approval_record", "plan_completion_record", "stage_record", "cycle_record",
    ] as const),
    resource_id: parseIdentifier(record.resource_id),
    observed_record_observation_digest: parseDigest(record.observed_record_observation_digest),
  });
}

const CYCLE_INVALIDATION_KINDS = [
  "invalid_terminal", "invalid_status_transition", "invalid_record_basis", "unresolvable_record_slot",
  "partial_graph_materialization", "authoritative_record_lost", "sealed_fact_mutated",
] as const;

interface CycleInvalidationRecordCommon extends Omit<TaskIssueRecordCommon, "basis_status"> {
  readonly record_kind: "cycle_invalidation";
  readonly observed_status: TaskStatus;
  readonly observed_cycle_document_digest: Digest;
  readonly observed_execution_graph_digest: Digest;
  readonly offending_resources: readonly [CycleInvalidationEvidence, ...CycleInvalidationEvidence[]];
  readonly observed_history_digest: Digest;
  readonly observed_record_set_digest: Digest;
  readonly reason_code: string;
  readonly reason_markdown: MarkdownText;
}

interface InvalidTerminalSuccessorEvidence {
  readonly closed_stage_record_digests: readonly Digest[];
  readonly known_graph_digest: Digest;
  readonly identity_history_closure_digest: Digest;
}

type CycleInvalidationPhaseBasis =
  | { readonly last_valid_phase: "draft"; readonly basis_status: "Draft"; readonly expected_status: "Draft" }
  | {
    readonly last_valid_phase: "in_progress";
    readonly basis_status: "In Progress";
    readonly expected_status: "In Progress";
  }
  | {
    readonly last_valid_phase: "awaiting_acceptance";
    readonly basis_status: "Awaiting Acceptance";
    readonly expected_status: "Awaiting Acceptance";
  };

export type CycleInvalidationRecord = CycleInvalidationRecordCommon & CycleInvalidationPhaseBasis & (
  {
    readonly invalidation_kind: "invalid_terminal";
    readonly terminal_status: typeof CYCLE_TERMINAL_STATUSES[number];
    readonly successor_policy: "allowed";
    readonly successor_evidence: InvalidTerminalSuccessorEvidence;
  }
  | {
    readonly invalidation_kind: "invalid_terminal";
    readonly terminal_status: typeof CYCLE_TERMINAL_STATUSES[number];
    readonly successor_policy: "permanently_quarantined";
    readonly successor_evidence: null;
  }
  | {
    readonly invalidation_kind: Exclude<typeof CYCLE_INVALIDATION_KINDS[number], "invalid_terminal">;
    readonly terminal_status: "Failed";
    readonly successor_policy: "permanently_quarantined";
    readonly successor_evidence: null;
  }
);

export function parseCycleInvalidationRecord(value: unknown): CycleInvalidationRecord {
  const record = asRecord(value);
  assertExactKeys(record, [
    ...COMMON_RECORD_KEYS, "record_kind", "last_valid_phase", "expected_status", "observed_status",
    "observed_cycle_document_digest", "observed_execution_graph_digest", "offending_resources",
    "observed_history_digest", "observed_record_set_digest", "reason_code", "reason_markdown",
    "invalidation_kind", "terminal_status", "successor_policy", "successor_evidence",
  ]);
  if (record.record_kind !== "cycle_invalidation") throw new Error("invalid_contract_variant");
  const common = parseRecordCommon(record);
  const kind = parseEnum(record.invalidation_kind, CYCLE_INVALIDATION_KINDS);
  const terminalStatus = parseEnum(record.terminal_status, CYCLE_TERMINAL_STATUSES);
  const policy = parseEnum(record.successor_policy, ["allowed", "permanently_quarantined"] as const);
  if (common.issue_id !== common.cycle_id) throw new Error("cycle_invalidation_owner_mismatch");
  if (kind !== "invalid_terminal" && (policy !== "permanently_quarantined" || terminalStatus !== "Failed")) {
    throw new Error("invalid_cycle_successor_policy");
  }
  const phase = parseEnum(record.last_valid_phase, CYCLE_PHASES);
  const phaseStatus = phase === "draft" ? "Draft"
    : phase === "in_progress" ? "In Progress" : "Awaiting Acceptance";
  if (common.basis_status !== phaseStatus || record.expected_status !== phaseStatus) {
    throw new Error("cycle_invalidation_phase_mismatch");
  }
  if (kind === "invalid_terminal" && record.observed_status !== terminalStatus) {
    throw new Error("cycle_invalidation_terminal_status_mismatch");
  }
  let successorEvidence: Readonly<Record<string, unknown>> | null = null;
  if (policy === "allowed") {
    if (kind !== "invalid_terminal" || record.successor_evidence === null) {
      throw new Error("invalid_cycle_successor_policy");
    }
    const evidence = asRecord(record.successor_evidence);
    assertExactKeys(evidence, ["closed_stage_record_digests", "known_graph_digest", "identity_history_closure_digest"]);
    successorEvidence = Object.freeze({
      closed_stage_record_digests: parseStringArray(evidence.closed_stage_record_digests, parseDigest, MAX_RECORD_ITEMS),
      known_graph_digest: parseDigest(evidence.known_graph_digest),
      identity_history_closure_digest: parseDigest(evidence.identity_history_closure_digest),
    });
  } else if (record.successor_evidence !== null) {
    throw new Error("invalid_cycle_successor_policy");
  }
  return Object.freeze({
    ...common,
    record_kind: "cycle_invalidation",
    last_valid_phase: phase,
    expected_status: parseEnum(record.expected_status, TASK_STATUSES),
    observed_status: parseEnum(record.observed_status, TASK_STATUSES),
    observed_cycle_document_digest: parseDigest(record.observed_cycle_document_digest),
    observed_execution_graph_digest: parseDigest(record.observed_execution_graph_digest),
    offending_resources: nonEmptyArray(
      record.offending_resources, parseCycleInvalidationEvidence, "empty_cycle_invalidation_evidence",
    ),
    observed_history_digest: parseDigest(record.observed_history_digest),
    observed_record_set_digest: parseDigest(record.observed_record_set_digest),
    reason_code: parseIdentifier(record.reason_code),
    reason_markdown: parseMarkdownText(record.reason_markdown, "invalid_cycle_invalidation_reason"),
    invalidation_kind: kind,
    terminal_status: terminalStatus,
    successor_policy: policy,
    successor_evidence: successorEvidence,
  }) as CycleInvalidationRecord;
}

export interface RootFamilyInvalidationRecord {
  readonly record_id: string;
  readonly revision: TaskRevision;
  readonly issue_id: TaskIssueId;
  readonly root_id: RootIssueId;
  readonly actor_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: null;
  readonly record_kind: "root_family_invalidation";
  readonly identity_derivation_version: string;
  readonly basis_issue_revision: TaskRevision;
  readonly basis_status: TaskStatus;
  readonly basis_document_digest: Digest;
  readonly invalidation_kind: "multiple_non_terminal_cycles";
  readonly observed_task_snapshot_digest: Digest;
  readonly observed_at: string;
  readonly non_terminal_cycle_ids: readonly TaskIssueId[];
  readonly overlap_evidence_digests: readonly Digest[];
  readonly resolution_policy: "permanently_quarantined";
  readonly reason_code: string;
  readonly reason_markdown: MarkdownText;
}

export function parseRootFamilyInvalidationRecord(value: unknown): RootFamilyInvalidationRecord {
  const record = asRecord(value);
  assertExactKeys(record, [
    "record_id", "revision", "issue_id", "root_id", "actor_id", "created_at", "updated_at",
    "archived_at", "record_kind", "identity_derivation_version", "basis_issue_revision", "basis_status",
    "basis_document_digest", "invalidation_kind", "observed_task_snapshot_digest", "observed_at",
    "non_terminal_cycle_ids", "overlap_evidence_digests", "resolution_policy", "reason_code", "reason_markdown",
  ]);
  const createdAt = parseTimestamp(record.created_at, "invalid_record_created_at");
  const updatedAt = parseTimestamp(record.updated_at, "invalid_record_updated_at");
  if (record.archived_at !== null) throw new Error("record_not_write_once");
  const issueId = parseTaskIssueId(record.issue_id);
  const rootId = parseRootIssueId(record.root_id);
  if (String(issueId) !== String(rootId)) throw new Error("root_family_invalidation_owner_mismatch");
  if (
    record.record_kind !== "root_family_invalidation"
    || record.invalidation_kind !== "multiple_non_terminal_cycles"
    || record.resolution_policy !== "permanently_quarantined"
  ) throw new Error("invalid_contract_variant");
  const cycleIds = parseStringArray(record.non_terminal_cycle_ids, parseTaskIssueId, MAX_RECORD_ITEMS) as readonly TaskIssueId[];
  const evidenceDigests = parseStringArray(record.overlap_evidence_digests, parseDigest, MAX_RECORD_ITEMS);
  if (cycleIds.length < 2 || evidenceDigests.length < 2 || cycleIds.length !== evidenceDigests.length) {
    throw new Error("insufficient_non_terminal_cycle_overlap");
  }
  return Object.freeze({
    record_id: parseIdentifier(record.record_id), revision: parseCanonicalRevision(record.revision),
    issue_id: issueId, root_id: rootId, actor_id: parseIdentifier(record.actor_id),
    created_at: createdAt, updated_at: updatedAt, archived_at: null,
    record_kind: "root_family_invalidation",
    identity_derivation_version: parseIdentifier(record.identity_derivation_version),
    basis_issue_revision: parseCanonicalRevision(record.basis_issue_revision),
    basis_status: parseEnum(record.basis_status, TASK_STATUSES),
    basis_document_digest: parseDigest(record.basis_document_digest),
    invalidation_kind: "multiple_non_terminal_cycles",
    observed_task_snapshot_digest: parseDigest(record.observed_task_snapshot_digest),
    observed_at: parseTimestamp(record.observed_at, "invalid_observation_time"),
    non_terminal_cycle_ids: cycleIds,
    overlap_evidence_digests: evidenceDigests,
    resolution_policy: "permanently_quarantined",
    reason_code: parseIdentifier(record.reason_code),
    reason_markdown: parseMarkdownText(record.reason_markdown, "invalid_family_invalidation_reason"),
  });
}

function parseNullableString(value: unknown, code: string): string | null {
  return value === null ? null : parseIdentifier(value, code);
}

export interface DeliveryObservationRoundRecord {
  readonly linear_snapshot_digest: Digest;
  readonly linear_observed_at: string;
  readonly root_revision: TaskRevision;
  readonly git_exact_revision: Digest;
  readonly git_observed_at: string;
  readonly remote_ref_revision: Digest | null;
  readonly pull_request_identity: string | null;
  readonly pull_request_revision: TaskRevision | null;
  readonly pull_request_head: Digest | null;
  readonly pull_request_state: string | null;
  readonly delivery_provider_observed_at: string;
}

export interface DeliveryConvergenceProofRecord {
  readonly proof_scope: "delivery";
  readonly first_round: DeliveryObservationRoundRecord;
  readonly second_round: DeliveryObservationRoundRecord;
  readonly observation_order: "linear -> git -> delivery -> linear -> git -> delivery";
  readonly stable_decision_basis_digest: Digest;
}

function parseDeliveryRound(value: unknown): DeliveryObservationRoundRecord {
  const record = asRecord(value);
  assertExactKeys(record, [
    "linear_snapshot_digest", "linear_observed_at", "root_revision", "git_exact_revision",
    "git_observed_at", "remote_ref_revision", "pull_request_identity", "pull_request_revision",
    "pull_request_head", "pull_request_state", "delivery_provider_observed_at",
  ]);
  return Object.freeze({
    linear_snapshot_digest: parseDigest(record.linear_snapshot_digest),
    linear_observed_at: parseTimestamp(record.linear_observed_at, "invalid_linear_observed_at"),
    root_revision: parseCanonicalRevision(record.root_revision),
    git_exact_revision: parseDigest(record.git_exact_revision),
    git_observed_at: parseTimestamp(record.git_observed_at, "invalid_git_observed_at"),
    remote_ref_revision: parseNullable(record.remote_ref_revision, parseDigest),
    pull_request_identity: parseNullableString(record.pull_request_identity, "invalid_pull_request_identity"),
    pull_request_revision: parseNullable(record.pull_request_revision, parseCanonicalRevision),
    pull_request_head: parseNullable(record.pull_request_head, parseDigest),
    pull_request_state: parseNullableString(record.pull_request_state, "invalid_pull_request_state"),
    delivery_provider_observed_at: parseTimestamp(
      record.delivery_provider_observed_at,
      "invalid_delivery_observed_at",
    ),
  });
}

function parseDeliveryProof(value: unknown): DeliveryConvergenceProofRecord {
  const record = asRecord(value);
  assertExactKeys(record, [
    "proof_scope", "first_round", "second_round", "observation_order", "stable_decision_basis_digest",
  ]);
  if (
    record.proof_scope !== "delivery"
    || record.observation_order !== "linear -> git -> delivery -> linear -> git -> delivery"
  ) throw new Error("invalid_delivery_convergence_proof");
  const firstRound = parseDeliveryRound(record.first_round);
  const secondRound = parseDeliveryRound(record.second_round);
  const stableFields = [
    "linear_snapshot_digest", "root_revision", "git_exact_revision", "remote_ref_revision",
    "pull_request_identity", "pull_request_revision", "pull_request_head", "pull_request_state",
  ] as const;
  if (stableFields.some((field) => firstRound[field] !== secondRound[field])) {
    throw new Error("unstable_delivery_convergence_proof");
  }
  return Object.freeze({
    proof_scope: "delivery",
    first_round: firstRound,
    second_round: secondRound,
    observation_order: "linear -> git -> delivery -> linear -> git -> delivery",
    stable_decision_basis_digest: parseDigest(record.stable_decision_basis_digest),
  });
}

export interface DeliveryCompletionRecord extends TaskIssueRecordCommon {
  readonly record_kind: "delivery_completion";
  readonly root_id: RootIssueId;
  readonly accepted_cycle_id: TaskIssueId;
  readonly exact_revision: Digest;
  readonly accepted_record_digest: Digest;
  readonly acceptance_basis_digest: Digest;
  readonly observed_root_status: "In Review";
  readonly observed_remote_revision: Digest;
  readonly observed_pull_request_identity: string;
  readonly observed_pull_request_head: Digest;
  readonly convergence_proof: DeliveryConvergenceProofRecord;
}

export function parseDeliveryCompletionRecord(value: unknown): DeliveryCompletionRecord {
  const record = asRecord(value);
  assertExactKeys(record, [
    ...COMMON_RECORD_KEYS, "record_kind", "root_id", "accepted_cycle_id", "exact_revision",
    "accepted_record_digest", "acceptance_basis_digest", "observed_root_status",
    "observed_remote_revision", "observed_pull_request_identity", "observed_pull_request_head",
    "convergence_proof",
  ]);
  if (record.record_kind !== "delivery_completion" || record.observed_root_status !== "In Review") {
    throw new Error("invalid_delivery_completion_variant");
  }
  const common = parseRecordCommon(record);
  const rootId = parseRootIssueId(record.root_id);
  const acceptedCycleId = parseTaskIssueId(record.accepted_cycle_id);
  if (String(common.issue_id) !== String(rootId) || common.cycle_id !== acceptedCycleId) {
    throw new Error("delivery_record_owner_mismatch");
  }
  const exactRevision = parseDigest(record.exact_revision);
  const remoteRevision = parseDigest(record.observed_remote_revision);
  const pullRequestIdentity = parseIdentifier(record.observed_pull_request_identity);
  const pullRequestHead = parseDigest(record.observed_pull_request_head);
  const proof = parseDeliveryProof(record.convergence_proof);
  const finalRound = proof.second_round;
  if (
    common.basis_status !== "In Review"
    || exactRevision !== remoteRevision
    || exactRevision !== pullRequestHead
    || finalRound.git_exact_revision !== exactRevision
    || finalRound.remote_ref_revision !== remoteRevision
    || finalRound.pull_request_head !== pullRequestHead
    || finalRound.pull_request_identity !== pullRequestIdentity
  ) throw new Error("delivery_completion_basis_mismatch");
  return Object.freeze({
    ...common, record_kind: "delivery_completion", root_id: rootId,
    accepted_cycle_id: acceptedCycleId,
    exact_revision: exactRevision,
    accepted_record_digest: parseDigest(record.accepted_record_digest),
    acceptance_basis_digest: parseDigest(record.acceptance_basis_digest),
    observed_root_status: "In Review",
    observed_remote_revision: remoteRevision,
    observed_pull_request_identity: pullRequestIdentity,
    observed_pull_request_head: pullRequestHead,
    convergence_proof: proof,
  });
}

export type DeliveryInvalidationEvidence =
  | {
    readonly kind: "convergence_mismatch";
    readonly first_round: DeliveryObservationRoundRecord;
    readonly second_round: DeliveryObservationRoundRecord;
    readonly observation_order: "linear -> git -> delivery -> linear -> git -> delivery";
    readonly mismatched_fields: readonly [string, ...string[]];
    readonly first_basis_digest: Digest;
    readonly second_basis_digest: Digest;
  }
  | {
    readonly kind: "completion_slot_conflict";
    readonly invalid_record_observation_digest: Digest;
  }
  | {
    readonly kind: "delivery_effect_conflict";
    readonly effect_may_have_occurred: true;
    readonly observed_delivery_facts_digest: Digest;
  }
  | {
    readonly kind: "root_done_before_completion";
    readonly observed_root_revision: TaskRevision;
    readonly observed_delivery_facts_digest: Digest;
  };

function parseDeliveryInvalidationEvidence(value: unknown): DeliveryInvalidationEvidence {
  const record = asRecord(value);
  const kind = parseEnum(record.kind, [
    "convergence_mismatch", "completion_slot_conflict", "delivery_effect_conflict",
    "root_done_before_completion",
  ] as const);
  if (kind === "convergence_mismatch") {
    assertExactKeys(record, [
      "kind", "first_round", "second_round", "observation_order", "mismatched_fields",
      "first_basis_digest", "second_basis_digest",
    ]);
    if (record.observation_order !== "linear -> git -> delivery -> linear -> git -> delivery") {
      throw new Error("invalid_delivery_invalidation_evidence");
    }
    return Object.freeze({
      kind, first_round: parseDeliveryRound(record.first_round), second_round: parseDeliveryRound(record.second_round),
      observation_order: "linear -> git -> delivery -> linear -> git -> delivery",
      mismatched_fields: nonEmptyArray(
        record.mismatched_fields,
        (entry) => parseIdentifier(entry, "invalid_delivery_mismatch_field"),
        "empty_delivery_mismatch_fields",
      ),
      first_basis_digest: parseDigest(record.first_basis_digest),
      second_basis_digest: parseDigest(record.second_basis_digest),
    });
  }
  if (kind === "completion_slot_conflict") {
    assertExactKeys(record, ["kind", "invalid_record_observation_digest"]);
    return Object.freeze({
      kind, invalid_record_observation_digest: parseDigest(record.invalid_record_observation_digest),
    });
  }
  if (kind === "delivery_effect_conflict") {
    assertExactKeys(record, ["kind", "effect_may_have_occurred", "observed_delivery_facts_digest"]);
    if (record.effect_may_have_occurred !== true) throw new Error("invalid_delivery_effect_conflict");
    return Object.freeze({
      kind, effect_may_have_occurred: true,
      observed_delivery_facts_digest: parseDigest(record.observed_delivery_facts_digest),
    });
  }
  assertExactKeys(record, ["kind", "observed_root_revision", "observed_delivery_facts_digest"]);
  return Object.freeze({
    kind, observed_root_revision: parseCanonicalRevision(record.observed_root_revision),
    observed_delivery_facts_digest: parseDigest(record.observed_delivery_facts_digest),
  });
}

export interface DeliveryInvalidationRecord extends TaskIssueRecordCommon {
  readonly record_kind: "delivery_invalidation";
  readonly root_id: RootIssueId;
  readonly accepted_cycle_id: TaskIssueId;
  readonly exact_revision: Digest;
  readonly accepted_record_digest: Digest;
  readonly acceptance_basis_digest: Digest;
  readonly observed_root_status: TaskStatus;
  readonly observed_remote_revision: Digest | null;
  readonly observed_pull_request_identity: string | null;
  readonly observed_pull_request_head: Digest | null;
  readonly invalidation_evidence: DeliveryInvalidationEvidence;
  readonly resolution_policy: "permanently_quarantined";
  readonly reason_code: string;
  readonly reason_markdown: MarkdownText;
}

export function parseDeliveryInvalidationRecord(value: unknown): DeliveryInvalidationRecord {
  const record = asRecord(value);
  assertExactKeys(record, [
    ...COMMON_RECORD_KEYS, "record_kind", "root_id", "accepted_cycle_id", "exact_revision",
    "accepted_record_digest", "acceptance_basis_digest", "observed_root_status",
    "observed_remote_revision", "observed_pull_request_identity", "observed_pull_request_head",
    "invalidation_evidence", "resolution_policy", "reason_code", "reason_markdown",
  ]);
  if (record.record_kind !== "delivery_invalidation" || record.resolution_policy !== "permanently_quarantined") {
    throw new Error("invalid_delivery_invalidation_variant");
  }
  const common = parseRecordCommon(record);
  const rootId = parseRootIssueId(record.root_id);
  const acceptedCycleId = parseTaskIssueId(record.accepted_cycle_id);
  if (String(common.issue_id) !== String(rootId) || common.cycle_id !== acceptedCycleId) {
    throw new Error("delivery_record_owner_mismatch");
  }
  return Object.freeze({
    ...common, record_kind: "delivery_invalidation", root_id: rootId,
    accepted_cycle_id: acceptedCycleId,
    exact_revision: parseDigest(record.exact_revision),
    accepted_record_digest: parseDigest(record.accepted_record_digest),
    acceptance_basis_digest: parseDigest(record.acceptance_basis_digest),
    observed_root_status: parseEnum(record.observed_root_status, TASK_STATUSES),
    observed_remote_revision: parseNullable(record.observed_remote_revision, parseDigest),
    observed_pull_request_identity: parseNullableString(
      record.observed_pull_request_identity,
      "invalid_pull_request_identity",
    ),
    observed_pull_request_head: parseNullable(record.observed_pull_request_head, parseDigest),
    invalidation_evidence: parseDeliveryInvalidationEvidence(record.invalidation_evidence),
    resolution_policy: "permanently_quarantined",
    reason_code: parseIdentifier(record.reason_code),
    reason_markdown: parseMarkdownText(record.reason_markdown, "invalid_delivery_invalidation_reason"),
  });
}

export type TaskIssueRecord =
  | RootFamilyInvalidationRecord
  | CycleApprovalRecord
  | StageCompletionRecord
  | StageInvalidationRecord
  | CycleCompletionRecord
  | CycleInvalidationRecord
  | DeliveryCompletionRecord
  | DeliveryInvalidationRecord;

export function parseTaskIssueRecord(value: unknown): TaskIssueRecord {
  const record = asRecord(value);
  const kind = parseEnum(record.record_kind, [
    "root_family_invalidation", "cycle_approval", "stage_completion", "stage_invalidation",
    "cycle_completion", "cycle_invalidation", "delivery_completion", "delivery_invalidation",
  ] as const);
  switch (kind) {
    case "root_family_invalidation": return parseRootFamilyInvalidationRecord(value);
    case "cycle_approval": return parseCycleApprovalRecordShape(value);
    case "stage_invalidation": return parseStageInvalidationRecord(value);
    case "cycle_completion": return parseCycleCompletionRecord(value);
    case "cycle_invalidation": return parseCycleInvalidationRecord(value);
    case "delivery_completion": return parseDeliveryCompletionRecord(value);
    case "delivery_invalidation": return parseDeliveryInvalidationRecord(value);
    case "stage_completion": {
      const completion = asRecord(record.completion);
      const stageKind: StageKind = "conclusion" in completion
        ? "verify"
        : "workspace_parent_revision" in completion
          ? "work"
          : "plan";
      return parseStageCompletionRecord(value, stageKind);
    }
  }
}
