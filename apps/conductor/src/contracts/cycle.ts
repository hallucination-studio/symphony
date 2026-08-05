import { createHash } from "node:crypto";

import { fromMarkdown } from "mdast-util-from-markdown";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseSchemaVersion,
  parseStageIssueId,
  parseTaskRelationId,
  parseTaskRevision,
  type CorrelationId,
  type CycleIssueId,
  type RootIssueId,
  type RuntimeGeneration,
  type SchemaVersion,
  type StageIssueId,
  type TaskRelationId,
  type TaskRevision,
} from "./identity.js";
import { parseGitSnapshot, type GitSnapshot } from "./observation.js";
import {
  asRecord,
  assertExactKeys,
  parseArray,
  parseBoundedString,
  parseEnum,
  markdownSemanticallyEqual,
  parseMarkdownText,
  type MarkdownText,
  type UnknownRecord,
} from "./validation.js";
import {
  parseTaskIssueHistoryEntry,
  parseTaskIssueRecordObservation,
  parseTaskResourceCreationEvidence,
  type TaskIssueHistoryEntry,
  type TaskIssueRecordObservation,
  type TaskResourceCreationEvidence,
} from "./task-management.js";

export const ROOT_DEFINITION_SECTION_NAMES = Object.freeze([
  "Requirement",
  "Domain Knowledge",
  "Root ADR",
  "Acceptance",
] as const);

export const CYCLE_DRAFT_SECTION_NAMES = Object.freeze([
  "Root Definition Revision",
  ...ROOT_DEFINITION_SECTION_NAMES,
  "Architecture",
  "Feature Design",
  "Code Design",
  "Boundaries",
  "Acceptance Mapping",
  "Failure Strategy",
] as const);

interface MarkdownPosition {
  readonly start: { readonly offset?: number };
  readonly end: { readonly offset?: number };
}

interface MarkdownNode {
  readonly type: string;
  readonly depth?: number;
  readonly value?: string;
  readonly alt?: string;
  readonly children?: readonly MarkdownNode[];
  readonly position?: MarkdownPosition;
}

export interface RootDefinitionTarget {
  readonly root_id: RootIssueId;
  readonly root_revision: TaskRevision;
  readonly correlation_id: CorrelationId;
}

export interface RootDefinition extends RootDefinitionTarget {
  readonly schema_version: SchemaVersion;
  readonly requirement_markdown: MarkdownText;
  readonly root_adr_markdown: MarkdownText;
  readonly acceptance_markdown: MarkdownText;
}

export interface CycleDraftDocument {
  readonly root_definition_revision: TaskRevision;
  readonly requirement_markdown: MarkdownText;
  readonly root_adr_markdown: MarkdownText;
  readonly acceptance_markdown: MarkdownText;
  readonly architecture_markdown: MarkdownText;
  readonly feature_design_markdown: MarkdownText;
  readonly code_design_markdown: MarkdownText;
  readonly boundaries_markdown: MarkdownText;
  readonly acceptance_mapping_markdown: MarkdownText;
  readonly failure_strategy_markdown: MarkdownText;
}

declare const cycleSealDigestBrand: unique symbol;
declare const executionGraphSealDigestBrand: unique symbol;
declare const planLocalKeyBrand: unique symbol;

export type CycleSealDigest = string & { readonly [cycleSealDigestBrand]: true };
export type ExecutionGraphSealDigest = string & { readonly [executionGraphSealDigestBrand]: true };
export type PlanLocalKey = string & { readonly [planLocalKeyBrand]: true };

export interface CycleSpecificationTarget {
  readonly root_id: RootIssueId;
  readonly cycle_id: CycleIssueId;
  readonly root_definition_revision: TaskRevision;
  readonly cycle_revision: TaskRevision;
  readonly correlation_id: CorrelationId;
}

interface CycleSpecificationFields extends CycleSpecificationTarget {
  readonly schema_version: SchemaVersion;
  readonly cycle_description_markdown: MarkdownText;
  readonly root_adr_markdown: MarkdownText;
  readonly status: "in_progress";
}

export interface CycleSpecification extends CycleSpecificationFields {
  readonly seal_digest: CycleSealDigest;
}

export interface PlanWorkItem {
  readonly local_key: PlanLocalKey;
  readonly title: string;
  readonly description_markdown: MarkdownText;
  readonly depends_on_local_keys: readonly PlanLocalKey[];
}

export interface PlanVerification {
  readonly title: string;
  readonly description_markdown: MarkdownText;
}

export interface PlanGraph {
  readonly plan_summary_markdown: MarkdownText;
  readonly work_items: readonly PlanWorkItem[];
  readonly verify: PlanVerification;
  readonly traceability_markdown: MarkdownText;
}

export type CycleExecutionStatus =
  | "in_progress"
  | "awaiting_acceptance"
  | "succeeded"
  | "rejected"
  | "failed"
  | "canceled";

export type StageExecutionStatus = "todo" | "in_progress" | "done" | "failed" | "canceled";
export type StageKind = "plan" | "work" | "verify";

export interface SealedStageIssue {
  readonly issue_id: StageIssueId;
  readonly sealed_revision: TaskRevision;
  readonly kind: StageKind;
  readonly title: string;
  readonly description_markdown: MarkdownText;
  readonly parent_cycle_id: CycleIssueId;
}

export interface StageExecutionSnapshot extends SealedStageIssue {
  readonly revision: TaskRevision;
  readonly status: StageExecutionStatus;
}

export interface SealedStageRelation {
  readonly relation_id: TaskRelationId;
  readonly revision: TaskRevision;
  readonly prerequisite_issue_id: StageIssueId;
  readonly dependent_issue_id: StageIssueId;
}

export interface SealedExecutionGraph {
  readonly plan_issue: SealedStageIssue | null;
  readonly work_issues: readonly SealedStageIssue[];
  readonly verify_issue: SealedStageIssue | null;
  readonly relations: readonly SealedStageRelation[];
  readonly seal_digest: ExecutionGraphSealDigest;
}

export interface CycleExecutionTarget {
  readonly root_id: RootIssueId;
  readonly cycle_id: CycleIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly cycle_revision: TaskRevision;
  readonly specification: CycleSpecification;
  readonly sealed_graph: SealedExecutionGraph;
}

export interface CycleExecutionSnapshot extends Omit<CycleExecutionTarget, "sealed_graph"> {
  readonly schema_version: SchemaVersion;
  readonly cycle_status: CycleExecutionStatus;
  readonly plan_issue: StageExecutionSnapshot | null;
  readonly sealed_work_issues: readonly StageExecutionSnapshot[];
  readonly verify_issue: StageExecutionSnapshot | null;
  readonly sealed_relations: readonly SealedStageRelation[];
  readonly sealed_graph_digest: ExecutionGraphSealDigest;
  readonly resource_creation_evidence: readonly TaskResourceCreationEvidence[];
  readonly issue_history: readonly TaskIssueHistoryEntry[];
  readonly issue_record_observations: readonly TaskIssueRecordObservation[];
  readonly git: GitSnapshot;
}

export type CycleAdvanceRequest = CycleExecutionSnapshot;

interface CycleAdvanceResultEnvelope {
  readonly schema_version: SchemaVersion;
  readonly root_id: RootIssueId;
  readonly cycle_id: CycleIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly seal_digest: CycleSealDigest;
  readonly from_cycle_revision: TaskRevision;
  readonly to_cycle_revision: TaskRevision;
}

export type CycleAdvanceResult =
  | (CycleAdvanceResultEnvelope & {
    readonly outcome: "advanced" | "awaiting_acceptance" | "no_action";
    readonly reason_markdown: null;
  })
  | (CycleAdvanceResultEnvelope & {
    readonly outcome: "terminal_failed" | "precondition_failed";
    readonly reason_markdown: MarkdownText;
  });

const CYCLE_SPECIFICATION_STATUSES = ["in_progress"] as const;
const CYCLE_EXECUTION_STATUSES = [
  "in_progress",
  "awaiting_acceptance",
  "succeeded",
  "rejected",
  "failed",
  "canceled",
] as const;
const STAGE_EXECUTION_STATUSES = ["todo", "in_progress", "done", "failed", "canceled"] as const;
const STAGE_KINDS = ["plan", "work", "verify"] as const;
const CYCLE_ADVANCE_OUTCOMES = [
  "advanced",
  "awaiting_acceptance",
  "terminal_failed",
  "precondition_failed",
  "no_action",
] as const;
const CYCLE_SEAL_PATTERN = /^[0-9a-f]{64}$/u;
const PLAN_LOCAL_KEY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_PLAN_WORK_ITEMS = 32;
const MAX_STAGE_RELATIONS = MAX_PLAN_WORK_ITEMS * (MAX_PLAN_WORK_ITEMS - 1) / 2 + MAX_PLAN_WORK_ITEMS;

function headingName(node: MarkdownNode): string | null {
  if (node.type !== "heading" || node.depth !== 2 || node.children?.length !== 1) return null;
  const child = node.children[0];
  return child?.type === "text" ? child.value ?? null : null;
}

function nodeOffset(node: MarkdownNode, edge: "start" | "end", code: string): number {
  const offset = node.position?.[edge].offset;
  if (offset === undefined) throw new Error(code);
  return offset;
}

function hasClosedMarkdownContent(nodes: readonly MarkdownNode[]): boolean {
  let meaningful = false;
  const pending = [...nodes];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.type === "definition") return false;
    if (
      (current.type === "text" || current.type === "inlineCode" || current.type === "code")
      && current.value !== undefined
      && current.value.trim().length > 0
    ) meaningful = true;
    if (
      (current.type === "image" || current.type === "imageReference")
      && current.alt !== undefined
      && current.alt.trim().length > 0
    ) meaningful = true;
    for (const child of current.children ?? []) pending.push(child);
  }
  return meaningful;
}

interface ClosedMarkdownDocument {
  readonly markdown: MarkdownText;
  readonly children: readonly MarkdownNode[];
  readonly headings: readonly MarkdownNode[];
  readonly code: string;
}

function closedMarkdownDocument(
  markdown: MarkdownText,
  sectionNames: readonly string[],
  code: string,
): ClosedMarkdownDocument {
  const tree = fromMarkdown(markdown) as MarkdownNode;
  const children = tree.children ?? [];
  const headings = children.filter((node) => node.type === "heading" && node.depth === 2);
  const names = headings.map(headingName);
  if (
    names.length !== sectionNames.length
    || names.some((name, index) => name !== sectionNames[index])
  ) throw new Error(code);

  const firstSectionIndex = children.indexOf(headings[0] as MarkdownNode);
  const prefix = children.slice(0, firstSectionIndex);
  if (
    prefix.length > 1
    || (prefix.length === 1 && (prefix[0]?.type !== "heading" || prefix[0].depth !== 1))
  ) throw new Error(code);
  const documentTitles = children.filter((node) => node.type === "heading" && node.depth === 1);
  if (documentTitles.length !== prefix.length) throw new Error(code);

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const nextHeading = headings[index + 1];
    const bodyStartIndex = heading === undefined ? -1 : children.indexOf(heading) + 1;
    const bodyEndIndex = nextHeading === undefined
      ? children.length
      : children.indexOf(nextHeading);
    const body = children.slice(bodyStartIndex, bodyEndIndex);
    if (
      heading === undefined
      || bodyStartIndex < 1
      || !hasClosedMarkdownContent(body)
    ) throw new Error(code);
  }
  return Object.freeze({
    markdown,
    children: Object.freeze(children),
    headings: Object.freeze(headings),
    code,
  });
}

function documentInlineCode(
  document: ClosedMarkdownDocument,
  sectionIndex: number,
): string {
  const heading = document.headings[sectionIndex];
  const nextHeading = document.headings[sectionIndex + 1];
  if (heading === undefined) throw new Error(document.code);
  const start = document.children.indexOf(heading) + 1;
  const end = nextHeading === undefined
    ? document.children.length
    : document.children.indexOf(nextHeading);
  const nodes = document.children.slice(start, end);
  const paragraph = nodes[0];
  const inline = paragraph?.children?.[0];
  if (
    nodes.length !== 1
    || paragraph?.type !== "paragraph"
    || paragraph.children?.length !== 1
    || inline?.type !== "inlineCode"
    || inline.value === undefined
  ) throw new Error(document.code);
  return inline.value;
}

function documentSection(
  document: ClosedMarkdownDocument,
  startIndex: number,
  endIndex: number,
): MarkdownText {
  const start = document.headings[startIndex];
  const end = document.headings[endIndex];
  if (start === undefined) throw new Error(document.code);
  return parseMarkdownText(document.markdown.slice(
    nodeOffset(start, "start", document.code),
    end === undefined
      ? document.markdown.length
      : nodeOffset(end, "start", document.code),
  ).trim(), document.code);
}

export function parseRootDefinitionMarkdown(value: unknown): {
  readonly requirement_markdown: MarkdownText;
  readonly root_adr_markdown: MarkdownText;
  readonly acceptance_markdown: MarkdownText;
} {
  const document = closedMarkdownDocument(
    parseMarkdownText(value, "invalid_root_definition_markdown"),
    ROOT_DEFINITION_SECTION_NAMES,
    "invalid_root_definition_markdown",
  );
  return Object.freeze({
    requirement_markdown: documentSection(document, 0, 2),
    root_adr_markdown: documentSection(document, 2, 3),
    acceptance_markdown: documentSection(document, 3, 4),
  });
}

export function parseCycleDraftMarkdown(value: unknown): CycleDraftDocument {
  const document = closedMarkdownDocument(
    parseMarkdownText(value, "invalid_cycle_draft_markdown"),
    CYCLE_DRAFT_SECTION_NAMES,
    "invalid_cycle_draft_markdown",
  );
  let rootDefinitionRevision: TaskRevision;
  try {
    rootDefinitionRevision = parseTaskRevision(documentInlineCode(document, 0));
  } catch {
    throw new Error("invalid_cycle_draft_markdown");
  }
  return Object.freeze({
    root_definition_revision: rootDefinitionRevision,
    requirement_markdown: documentSection(document, 1, 3),
    root_adr_markdown: documentSection(document, 3, 4),
    acceptance_markdown: documentSection(document, 4, 5),
    architecture_markdown: documentSection(document, 5, 6),
    feature_design_markdown: documentSection(document, 6, 7),
    code_design_markdown: documentSection(document, 7, 8),
    boundaries_markdown: documentSection(document, 8, 9),
    acceptance_mapping_markdown: documentSection(document, 9, 10),
    failure_strategy_markdown: documentSection(document, 10, 11),
  });
}

export function parseCycleDraftForRoot(
  value: unknown,
  rootDefinition: RootDefinition,
): CycleDraftDocument {
  const draft = parseCycleDraftMarkdown(value);
  if (draft.root_definition_revision !== rootDefinition.root_revision) {
    throw new Error("cycle_root_revision_snapshot_mismatch");
  }
  if (!markdownSemanticallyEqual(draft.requirement_markdown, rootDefinition.requirement_markdown)) {
    throw new Error("cycle_requirement_snapshot_mismatch");
  }
  if (!markdownSemanticallyEqual(draft.root_adr_markdown, rootDefinition.root_adr_markdown)) {
    throw new Error("cycle_root_adr_snapshot_mismatch");
  }
  if (!markdownSemanticallyEqual(draft.acceptance_markdown, rootDefinition.acceptance_markdown)) {
    throw new Error("cycle_acceptance_snapshot_mismatch");
  }
  return draft;
}

export function parseRootDefinition(value: unknown, expected: RootDefinitionTarget): RootDefinition {
  const record = asRecord(value);
  assertExactKeys(record, [
    "schema_version",
    "root_id",
    "root_revision",
    "correlation_id",
    "root_description_markdown",
  ]);
  const rootId = parseRootIssueId(record.root_id);
  const rootRevision = parseTaskRevision(record.root_revision);
  if (rootId !== expected.root_id || rootRevision !== expected.root_revision) {
    throw new Error("root_definition_target_mismatch");
  }
  const correlationId = parseCorrelationId(record.correlation_id);
  if (correlationId !== expected.correlation_id) {
    throw new Error("root_definition_correlation_mismatch");
  }
  const sections = parseRootDefinitionMarkdown(record.root_description_markdown);
  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    root_id: rootId,
    root_revision: rootRevision,
    correlation_id: correlationId,
    ...sections,
  });
}

function assertCycleSpecificationTarget(
  actual: CycleSpecificationTarget,
  expected: CycleSpecificationTarget,
): void {
  if (
    actual.root_id !== expected.root_id
    || actual.cycle_id !== expected.cycle_id
    || actual.root_definition_revision !== expected.root_definition_revision
    || actual.cycle_revision !== expected.cycle_revision
  ) throw new Error("cycle_specification_target_mismatch");
  if (actual.correlation_id !== expected.correlation_id) {
    throw new Error("cycle_specification_correlation_mismatch");
  }
}

function parseCycleSpecificationFields(
  record: UnknownRecord,
  expected: CycleSpecificationTarget,
): CycleSpecificationFields {
  const cycleDescription = parseMarkdownText(
    record.cycle_description_markdown,
    "invalid_cycle_description_markdown",
  );
  const draft = parseCycleDraftMarkdown(cycleDescription);
  const rootAdr = parseMarkdownText(record.root_adr_markdown, "invalid_cycle_root_adr_markdown");
  const rootDefinitionRevision = parseTaskRevision(record.root_definition_revision);
  const fields = Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    root_id: parseRootIssueId(record.root_id),
    cycle_id: parseCycleIssueId(record.cycle_id),
    root_definition_revision: rootDefinitionRevision,
    cycle_revision: parseTaskRevision(record.cycle_revision),
    correlation_id: parseCorrelationId(record.correlation_id),
    cycle_description_markdown: cycleDescription,
    root_adr_markdown: rootAdr,
    status: parseEnum(record.status, CYCLE_SPECIFICATION_STATUSES),
  });
  assertCycleSpecificationTarget(fields, expected);
  if (rootDefinitionRevision !== draft.root_definition_revision) {
    throw new Error("cycle_root_revision_mismatch");
  }
  if (rootAdr !== draft.root_adr_markdown) throw new Error("cycle_root_adr_mismatch");
  return fields;
}

function cycleSealDigest(fields: CycleSpecificationFields): CycleSealDigest {
  const canonical = JSON.stringify([
    fields.schema_version,
    fields.root_id,
    fields.cycle_id,
    fields.root_definition_revision,
    fields.cycle_revision,
    fields.correlation_id,
    fields.cycle_description_markdown,
    fields.root_adr_markdown,
    fields.status,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex") as CycleSealDigest;
}

export function parseCycleSealDigest(value: unknown): CycleSealDigest {
  if (typeof value !== "string" || !CYCLE_SEAL_PATTERN.test(value)) {
    throw new Error("invalid_cycle_seal_digest");
  }
  return value as CycleSealDigest;
}

export function parseExecutionGraphSealDigest(value: unknown): ExecutionGraphSealDigest {
  if (typeof value !== "string" || !CYCLE_SEAL_PATTERN.test(value)) {
    throw new Error("invalid_execution_graph_seal_digest");
  }
  return value as ExecutionGraphSealDigest;
}

export function sealCycleSpecification(
  value: unknown,
  rootDefinition: RootDefinition,
  expected: CycleSpecificationTarget,
): CycleSpecification {
  const record = asRecord(value);
  assertExactKeys(record, [
    "schema_version",
    "root_id",
    "cycle_id",
    "root_definition_revision",
    "cycle_revision",
    "correlation_id",
    "cycle_description_markdown",
    "root_adr_markdown",
    "status",
  ]);
  const fields = parseCycleSpecificationFields(record, expected);
  parseCycleDraftForRoot(fields.cycle_description_markdown, rootDefinition);
  if (
    fields.root_id !== rootDefinition.root_id
    || fields.root_definition_revision !== rootDefinition.root_revision
  ) throw new Error("cycle_specification_target_mismatch");
  return Object.freeze({ ...fields, seal_digest: cycleSealDigest(fields) });
}

export function parseCycleSpecification(
  value: unknown,
  expected: CycleSpecificationTarget,
): CycleSpecification {
  const record = asRecord(value);
  assertExactKeys(record, [
    "schema_version",
    "root_id",
    "cycle_id",
    "root_definition_revision",
    "cycle_revision",
    "correlation_id",
    "cycle_description_markdown",
    "root_adr_markdown",
    "status",
    "seal_digest",
  ]);
  const fields = parseCycleSpecificationFields(record, expected);
  const sealDigest = parseCycleSealDigest(record.seal_digest);
  if (sealDigest !== cycleSealDigest(fields)) throw new Error("cycle_seal_mismatch");
  return Object.freeze({ ...fields, seal_digest: sealDigest });
}

function parsePlanLocalKey(value: unknown): PlanLocalKey {
  const key = parseBoundedString(value, "invalid_plan_local_key", 64);
  if (!PLAN_LOCAL_KEY_PATTERN.test(key)) throw new Error("invalid_plan_local_key");
  return key as PlanLocalKey;
}

function parsePlanWorkItem(value: unknown): PlanWorkItem {
  const record = asRecord(value);
  assertExactKeys(record, ["local_key", "title", "description_markdown", "depends_on_local_keys"]);
  const dependencies = parseArray(
    record.depends_on_local_keys,
    parsePlanLocalKey,
    MAX_PLAN_WORK_ITEMS,
  );
  if (new Set(dependencies).size !== dependencies.length) {
    throw new Error("duplicate_plan_dependency");
  }
  return Object.freeze({
    local_key: parsePlanLocalKey(record.local_key),
    title: parseBoundedString(record.title, "invalid_plan_work_title", 1_024),
    description_markdown: parseMarkdownText(record.description_markdown, "invalid_plan_work_markdown"),
    depends_on_local_keys: dependencies,
  });
}

function parsePlanVerification(value: unknown): PlanVerification {
  const record = asRecord(value);
  assertExactKeys(record, ["title", "description_markdown"]);
  return Object.freeze({
    title: parseBoundedString(record.title, "invalid_plan_verify_title", 1_024),
    description_markdown: parseMarkdownText(record.description_markdown, "invalid_plan_verify_markdown"),
  });
}

function assertPlanDependencies(workItems: readonly PlanWorkItem[]): void {
  const keys = new Set(workItems.map(({ local_key }) => local_key));
  if (keys.size !== workItems.length) throw new Error("duplicate_plan_local_key");

  const incoming = new Map<PlanLocalKey, number>();
  const dependents = new Map<PlanLocalKey, PlanLocalKey[]>();
  for (const item of workItems) {
    incoming.set(item.local_key, item.depends_on_local_keys.length);
    dependents.set(item.local_key, []);
    for (const dependency of item.depends_on_local_keys) {
      if (!keys.has(dependency)) throw new Error("unknown_plan_dependency");
      if (dependency === item.local_key) throw new Error("self_plan_dependency");
    }
  }
  for (const item of workItems) {
    for (const dependency of item.depends_on_local_keys) {
      dependents.get(dependency)?.push(item.local_key);
    }
  }

  const ready = [...incoming]
    .filter(([, count]) => count === 0)
    .map(([key]) => key);
  let visited = 0;
  while (ready.length > 0) {
    const key = ready.pop();
    if (key === undefined) break;
    visited += 1;
    for (const dependent of dependents.get(key) ?? []) {
      const next = (incoming.get(dependent) ?? 0) - 1;
      incoming.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
  }
  if (visited !== workItems.length) throw new Error("cyclic_plan_dependencies");
}

export function parsePlanGraph(value: unknown): PlanGraph {
  const record = asRecord(value);
  assertExactKeys(record, ["plan_summary_markdown", "work_items", "verify", "traceability_markdown"]);
  const workItems = parseArray(record.work_items, parsePlanWorkItem, MAX_PLAN_WORK_ITEMS);
  if (workItems.length === 0) throw new Error("plan_work_items_required");
  assertPlanDependencies(workItems);
  return Object.freeze({
    plan_summary_markdown: parseMarkdownText(record.plan_summary_markdown, "invalid_plan_summary_markdown"),
    work_items: workItems,
    verify: parsePlanVerification(record.verify),
    traceability_markdown: parseMarkdownText(
      record.traceability_markdown,
      "invalid_plan_traceability_markdown",
    ),
  });
}

function parseSealedStageIssue(
  value: unknown,
  expectedKind: StageKind,
  cycleId: CycleIssueId,
): SealedStageIssue {
  const record = asRecord(value);
  assertExactKeys(record, [
    "issue_id",
    "sealed_revision",
    "kind",
    "title",
    "description_markdown",
    "parent_cycle_id",
  ]);
  const kind = parseEnum(record.kind, STAGE_KINDS);
  if (kind !== expectedKind) throw new Error("invalid_sealed_stage_kind");
  const parentCycleId = parseCycleIssueId(record.parent_cycle_id);
  if (parentCycleId !== cycleId) throw new Error("sealed_stage_parent_mismatch");
  return Object.freeze({
    issue_id: parseStageIssueId(record.issue_id),
    sealed_revision: parseTaskRevision(record.sealed_revision),
    kind,
    title: parseBoundedString(record.title, "invalid_sealed_stage_title", 1_024),
    description_markdown: parseMarkdownText(
      record.description_markdown,
      "invalid_sealed_stage_markdown",
    ),
    parent_cycle_id: parentCycleId,
  });
}

function parseSealedStageRelation(value: unknown): SealedStageRelation {
  const record = asRecord(value);
  assertExactKeys(record, [
    "relation_id",
    "revision",
    "prerequisite_issue_id",
    "dependent_issue_id",
  ]);
  const relation = Object.freeze({
    relation_id: parseTaskRelationId(record.relation_id),
    revision: parseTaskRevision(record.revision),
    prerequisite_issue_id: parseStageIssueId(record.prerequisite_issue_id),
    dependent_issue_id: parseStageIssueId(record.dependent_issue_id),
  });
  if (relation.prerequisite_issue_id === relation.dependent_issue_id) {
    throw new Error("self_execution_relation");
  }
  return relation;
}

function assertExecutionGraph(
  planIssue: SealedStageIssue | null,
  workIssues: readonly SealedStageIssue[],
  verifyIssue: SealedStageIssue | null,
  relations: readonly SealedStageRelation[],
): void {
  if (planIssue === null) {
    if (workIssues.length > 0 || verifyIssue !== null || relations.length > 0) {
      throw new Error("partial_execution_graph");
    }
    return;
  }
  if (workIssues.length === 0) {
    if (verifyIssue !== null || relations.length > 0) throw new Error("partial_execution_graph");
    return;
  }
  if (verifyIssue === null) throw new Error("partial_execution_graph");

  const stageIds = [planIssue.issue_id, ...workIssues.map(({ issue_id }) => issue_id), verifyIssue.issue_id];
  if (new Set(stageIds).size !== stageIds.length) throw new Error("duplicate_execution_stage_identity");
  if (new Set(relations.map(({ relation_id }) => relation_id)).size !== relations.length) {
    throw new Error("duplicate_execution_relation_identity");
  }

  const workIds = new Set(workIssues.map(({ issue_id }) => issue_id));
  const relationKeys = new Set<string>();
  const verifyDependencies = new Set<StageIssueId>();
  const incoming = new Map(workIssues.map(({ issue_id }) => [issue_id, 0]));
  const dependents = new Map(workIssues.map(({ issue_id }) => [issue_id, [] as StageIssueId[]]));
  for (const relation of relations) {
    const prerequisite = relation.prerequisite_issue_id;
    const dependent = relation.dependent_issue_id;
    if (!workIds.has(prerequisite) || (!workIds.has(dependent) && dependent !== verifyIssue.issue_id)) {
      throw new Error("unknown_execution_relation_endpoint");
    }
    const relationKey = `${prerequisite}\0${dependent}`;
    if (relationKeys.has(relationKey)) throw new Error("duplicate_execution_relation");
    relationKeys.add(relationKey);
    if (dependent === verifyIssue.issue_id) {
      verifyDependencies.add(prerequisite);
    } else {
      incoming.set(dependent, (incoming.get(dependent) ?? 0) + 1);
      dependents.get(prerequisite)?.push(dependent);
    }
  }
  if (
    verifyDependencies.size !== workIds.size
    || [...workIds].some((issueId) => !verifyDependencies.has(issueId))
  ) throw new Error("verify_dependency_coverage");

  const ready = [...incoming].filter(([, count]) => count === 0).map(([issueId]) => issueId);
  let visited = 0;
  while (ready.length > 0) {
    const issueId = ready.pop();
    if (issueId === undefined) break;
    visited += 1;
    for (const dependent of dependents.get(issueId) ?? []) {
      const next = (incoming.get(dependent) ?? 0) - 1;
      incoming.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
  }
  if (visited !== workIssues.length) throw new Error("cyclic_execution_graph");
}

function executionGraphSealDigest(
  planIssue: SealedStageIssue | null,
  workIssues: readonly SealedStageIssue[],
  verifyIssue: SealedStageIssue | null,
  relations: readonly SealedStageRelation[],
): ExecutionGraphSealDigest {
  return createHash("sha256")
    .update(JSON.stringify([planIssue, workIssues, verifyIssue, relations]), "utf8")
    .digest("hex") as ExecutionGraphSealDigest;
}

export function parseSealedExecutionGraph(value: unknown, cycleId: CycleIssueId): SealedExecutionGraph {
  const record = asRecord(value);
  assertExactKeys(record, ["plan_issue", "work_issues", "verify_issue", "relations"]);
  const planIssue = record.plan_issue === null
    ? null
    : parseSealedStageIssue(record.plan_issue, "plan", cycleId);
  const workIssues = parseArray(
    record.work_issues,
    (entry) => parseSealedStageIssue(entry, "work", cycleId),
    MAX_PLAN_WORK_ITEMS,
  );
  const verifyIssue = record.verify_issue === null
    ? null
    : parseSealedStageIssue(record.verify_issue, "verify", cycleId);
  const relations = parseArray(record.relations, parseSealedStageRelation, MAX_STAGE_RELATIONS);
  assertExecutionGraph(planIssue, workIssues, verifyIssue, relations);
  return Object.freeze({
    plan_issue: planIssue,
    work_issues: workIssues,
    verify_issue: verifyIssue,
    relations,
    seal_digest: executionGraphSealDigest(planIssue, workIssues, verifyIssue, relations),
  });
}

function parseExecutionStage(value: unknown, expected: SealedStageIssue): StageExecutionSnapshot {
  const record = asRecord(value);
  assertExactKeys(record, [
    "issue_id",
    "revision",
    "kind",
    "title",
    "description_markdown",
    "parent_cycle_id",
    "status",
  ]);
  const immutable = {
    issue_id: parseStageIssueId(record.issue_id),
    kind: parseEnum(record.kind, STAGE_KINDS),
    title: parseBoundedString(record.title, "invalid_execution_stage_title", 1_024),
    description_markdown: parseMarkdownText(
      record.description_markdown,
      "invalid_execution_stage_markdown",
    ),
    parent_cycle_id: parseCycleIssueId(record.parent_cycle_id),
  };
  if (
    immutable.issue_id !== expected.issue_id
    || immutable.kind !== expected.kind
    || immutable.title !== expected.title
    || immutable.description_markdown !== expected.description_markdown
    || immutable.parent_cycle_id !== expected.parent_cycle_id
  ) throw new Error("sealed_execution_graph_mismatch");
  return Object.freeze({
    ...expected,
    revision: parseTaskRevision(record.revision),
    status: parseEnum(record.status, STAGE_EXECUTION_STATUSES),
  });
}

function parseOptionalExecutionStage(
  value: unknown,
  expected: SealedStageIssue | null,
): StageExecutionSnapshot | null {
  if (expected !== null) return parseExecutionStage(value, expected);
  if (value !== null) throw new Error("sealed_execution_graph_mismatch");
  return null;
}

function parseExecutionStageList(
  value: unknown,
  expected: readonly SealedStageIssue[],
): readonly StageExecutionSnapshot[] {
  const raw = parseArray(value, asRecord, MAX_PLAN_WORK_ITEMS);
  if (raw.length !== expected.length) throw new Error("sealed_execution_graph_mismatch");
  const byId = new Map(raw.map((record) => [parseStageIssueId(record.issue_id), record]));
  if (byId.size !== raw.length) throw new Error("sealed_execution_graph_mismatch");
  return Object.freeze(expected.map((stage) => {
    const record = byId.get(stage.issue_id);
    if (record === undefined) throw new Error("sealed_execution_graph_mismatch");
    return parseExecutionStage(record, stage);
  }));
}

function parseExecutionRelationList(
  value: unknown,
  expected: readonly SealedStageRelation[],
): readonly SealedStageRelation[] {
  const parsed = parseArray(value, parseSealedStageRelation, MAX_STAGE_RELATIONS);
  if (parsed.length !== expected.length) throw new Error("sealed_execution_graph_mismatch");
  const byId = new Map(parsed.map((relation) => [relation.relation_id, relation]));
  if (byId.size !== parsed.length) throw new Error("sealed_execution_graph_mismatch");
  return Object.freeze(expected.map((relation) => {
    const actual = byId.get(relation.relation_id);
    if (
      actual === undefined
      || actual.revision !== relation.revision
      || actual.prerequisite_issue_id !== relation.prerequisite_issue_id
      || actual.dependent_issue_id !== relation.dependent_issue_id
    ) throw new Error("sealed_execution_graph_mismatch");
    return actual;
  }));
}

function specificationTarget(specification: CycleSpecification): CycleSpecificationTarget {
  return Object.freeze({
    root_id: specification.root_id,
    cycle_id: specification.cycle_id,
    root_definition_revision: specification.root_definition_revision,
    cycle_revision: specification.cycle_revision,
    correlation_id: specification.correlation_id,
  });
}

function assertCycleExecutionBindings(
  rootId: RootIssueId,
  cycleId: CycleIssueId,
  specification: CycleSpecification,
  sealedGraph: SealedExecutionGraph,
): void {
  if (
    specification.root_id !== rootId
    || specification.cycle_id !== cycleId
    || (sealedGraph.plan_issue !== null && sealedGraph.plan_issue.parent_cycle_id !== cycleId)
    || (sealedGraph.verify_issue !== null && sealedGraph.verify_issue.parent_cycle_id !== cycleId)
    || sealedGraph.work_issues.some(({ parent_cycle_id }) => parent_cycle_id !== cycleId)
  ) throw new Error("cycle_execution_target_mismatch");
}

export function parseCycleExecutionSnapshot(
  value: unknown,
  expected: CycleExecutionTarget,
): CycleExecutionSnapshot {
  const record = asRecord(value);
  assertExactKeys(record, [
    "schema_version",
    "root_id",
    "cycle_id",
    "runtime_generation",
    "correlation_id",
    "cycle_revision",
    "cycle_status",
    "specification",
    "plan_issue",
    "sealed_work_issues",
    "verify_issue",
    "sealed_relations",
    "resource_creation_evidence",
    "issue_history",
    "issue_record_observations",
    "git",
  ]);
  const rootId = parseRootIssueId(record.root_id);
  const cycleId = parseCycleIssueId(record.cycle_id);
  const runtimeGeneration = parseRuntimeGeneration(record.runtime_generation);
  const cycleRevision = parseTaskRevision(record.cycle_revision);
  if (
    rootId !== expected.root_id
    || cycleId !== expected.cycle_id
    || runtimeGeneration !== expected.runtime_generation
    || cycleRevision !== expected.cycle_revision
  ) throw new Error("cycle_execution_target_mismatch");
  const correlationId = parseCorrelationId(record.correlation_id);
  if (correlationId !== expected.correlation_id) {
    throw new Error("cycle_execution_correlation_mismatch");
  }
  const specification = parseCycleSpecification(
    record.specification,
    specificationTarget(expected.specification),
  );
  if (specification.seal_digest !== expected.specification.seal_digest) {
    throw new Error("cycle_execution_specification_mismatch");
  }
  assertCycleExecutionBindings(rootId, cycleId, specification, expected.sealed_graph);

  const planIssue = parseOptionalExecutionStage(
    record.plan_issue,
    expected.sealed_graph.plan_issue,
  );
  const workIssues = parseExecutionStageList(
    record.sealed_work_issues,
    expected.sealed_graph.work_issues,
  );
  const verifyIssue = parseOptionalExecutionStage(
    record.verify_issue,
    expected.sealed_graph.verify_issue,
  );
  const relations = parseExecutionRelationList(record.sealed_relations, expected.sealed_graph.relations);
  const resourceCreationEvidence = parseArray(
    record.resource_creation_evidence,
    parseTaskResourceCreationEvidence,
  );
  const issueHistory = parseArray(record.issue_history, parseTaskIssueHistoryEntry);
  const issueRecordObservations = parseArray(
    record.issue_record_observations,
    parseTaskIssueRecordObservation,
  );

  return Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: runtimeGeneration,
    correlation_id: correlationId,
    cycle_revision: cycleRevision,
    cycle_status: parseEnum(record.cycle_status, CYCLE_EXECUTION_STATUSES),
    specification,
    plan_issue: planIssue,
    sealed_work_issues: workIssues,
    verify_issue: verifyIssue,
    sealed_relations: relations,
    sealed_graph_digest: expected.sealed_graph.seal_digest,
    resource_creation_evidence: resourceCreationEvidence,
    issue_history: issueHistory,
    issue_record_observations: issueRecordObservations,
    git: parseGitSnapshot(record.git),
  });
}

export function parseCycleAdvanceResult(
  value: unknown,
  request: CycleAdvanceRequest,
): CycleAdvanceResult {
  const record = asRecord(value);
  assertExactKeys(record, [
    "schema_version",
    "root_id",
    "cycle_id",
    "runtime_generation",
    "correlation_id",
    "seal_digest",
    "from_cycle_revision",
    "to_cycle_revision",
    "outcome",
    "reason_markdown",
  ]);
  const rootId = parseRootIssueId(record.root_id);
  const cycleId = parseCycleIssueId(record.cycle_id);
  const runtimeGeneration = parseRuntimeGeneration(record.runtime_generation);
  if (
    rootId !== request.root_id
    || cycleId !== request.cycle_id
    || runtimeGeneration !== request.runtime_generation
  ) throw new Error("cycle_advance_target_mismatch");
  const correlationId = parseCorrelationId(record.correlation_id);
  if (correlationId !== request.correlation_id) throw new Error("cycle_advance_correlation_mismatch");
  const sealDigest = parseCycleSealDigest(record.seal_digest);
  if (sealDigest !== request.specification.seal_digest) throw new Error("cycle_advance_seal_mismatch");
  const fromCycleRevision = parseTaskRevision(record.from_cycle_revision);
  if (fromCycleRevision !== request.cycle_revision) throw new Error("cycle_advance_revision_mismatch");
  const envelope = Object.freeze({
    schema_version: parseSchemaVersion(record.schema_version),
    root_id: rootId,
    cycle_id: cycleId,
    runtime_generation: runtimeGeneration,
    correlation_id: correlationId,
    seal_digest: sealDigest,
    from_cycle_revision: fromCycleRevision,
    to_cycle_revision: parseTaskRevision(record.to_cycle_revision),
  });
  const outcome = parseEnum(record.outcome, CYCLE_ADVANCE_OUTCOMES);
  if (outcome === "terminal_failed" || outcome === "precondition_failed") {
    if (record.reason_markdown === null) throw new Error("cycle_advance_reason_required");
    return Object.freeze({
      ...envelope,
      outcome,
      reason_markdown: parseMarkdownText(record.reason_markdown, "invalid_cycle_advance_reason"),
    });
  }
  if (record.reason_markdown !== null) throw new Error("cycle_advance_reason_forbidden");
  return Object.freeze({ ...envelope, outcome, reason_markdown: null });
}
