import { fromMarkdown } from "mdast-util-from-markdown";

import type {
  ApprovedWorkGroup,
  ExecutionDirective,
  VerificationDirective,
} from "./cycle-records.js";
import { parseCycleDraftMarkdown } from "./cycle.js";
import { parseMarkdownText, type MarkdownText } from "./validation.js";

interface Node {
  readonly type: string;
  readonly depth?: number;
  readonly value?: string;
  readonly children?: readonly Node[];
  readonly position?: { readonly start: { readonly offset?: number }; readonly end: { readonly offset?: number } };
}

export interface CycleDesignAnchors {
  readonly cycle_id: string;
  readonly predecessor_cycle_issue_id: string | null;
  readonly predecessor_terminal_record_id: string;
  readonly approval_record_id: string;
  readonly plan_issue_id: string;
  readonly plan_completion_record_id: string;
  readonly plan_invalidation_record_id: string;
  readonly cycle_completion_record_id: string;
  readonly cycle_invalidation_record_id: string;
  readonly delivery_completion_record_id: string;
  readonly delivery_invalidation_record_id: string;
  readonly identity_derivation_version: string;
  readonly workspace_base_revision: string;
}

export interface CycleDesignMarkdown {
  readonly anchors: CycleDesignAnchors;
  readonly execution_directives: readonly [ExecutionDirective, ...ExecutionDirective[]];
  readonly approved_work_groups: readonly [ApprovedWorkGroup, ...ApprovedWorkGroup[]];
  readonly verify_directives: readonly [VerificationDirective, ...VerificationDirective[]];
}

const SECTION_NAMES = [
  "Execution Anchors",
  "Execution Directives",
  "Approved Work Groups",
  "Verification Directives",
] as const;

const ANCHOR_LABELS = [
  "Cycle ID",
  "Predecessor Cycle ID",
  "Predecessor Terminal Record ID",
  "Approval Record ID",
  "Plan Issue ID",
  "Plan Completion Record ID",
  "Plan Invalidation Record ID",
  "Cycle Completion Record ID",
  "Cycle Invalidation Record ID",
  "Delivery Completion Record ID",
  "Delivery Invalidation Record ID",
  "Identity Derivation Version",
  "Workspace Base Revision",
] as const;

function fail(): never {
  throw new Error("invalid_cycle_design_markdown");
}

function offset(node: Node, edge: "start" | "end"): number {
  const value = node.position?.[edge].offset;
  return value === undefined ? fail() : value;
}

function headingText(node: Node, depth: number): string {
  if (node.type !== "heading" || node.depth !== depth || node.children?.length !== 1) return fail();
  const child = node.children[0];
  if (child?.type !== "text" || child.value === undefined) return fail();
  return child.value;
}

function entryIdentity(node: Node, prefix: string): string {
  if (node.type !== "heading" || node.depth !== 4 || node.children?.length !== 2) return fail();
  const [label, identity] = node.children;
  if (label?.type !== "text" || label.value !== prefix || identity?.type !== "inlineCode") return fail();
  return identity.value ?? fail();
}

function inlineCodeList(node: Node, allowNone: boolean): readonly string[] {
  if (node.type !== "list" || node.children === undefined || node.children.length === 0) return fail();
  const values = node.children.map((item) => {
    const paragraph = item.children?.[0];
    const value = paragraph?.children?.[0];
    if (item.type !== "listItem" || item.children?.length !== 1 || paragraph?.type !== "paragraph") return fail();
    if (value?.type === "inlineCode" && paragraph.children?.length === 1 && value.value !== undefined) {
      if (allowNone && value.value === "None") return null;
      return value.value;
    }
    if (allowNone && value?.type === "text" && paragraph.children?.length === 1 && value.value === "None") return null;
    return fail();
  });
  if (values.includes(null)) return values.length === 1 ? Object.freeze([]) : fail();
  return Object.freeze(values as string[]);
}

function labeledList(nodes: readonly Node[], label: string, allowNone: boolean): readonly string[] {
  const headingIndex = nodes.findIndex((node) => node.type === "heading" && node.depth === 5 && headingText(node, 5) === label);
  if (headingIndex < 0 || nodes[headingIndex + 1] === undefined) return fail();
  return inlineCodeList(nodes[headingIndex + 1]!, allowNone);
}

function instruction(markdown: string, nodes: readonly Node[]): MarkdownText {
  const firstMetadata = nodes.findIndex((node) => node.type === "heading" && node.depth === 5);
  if (firstMetadata <= 0) return fail();
  return parseMarkdownText(
    markdown.slice(offset(nodes[0]!, "start"), offset(nodes[firstMetadata - 1]!, "end")),
    "invalid_cycle_design_markdown",
  );
}

function entryBodies(nodes: readonly Node[]): readonly { readonly heading: Node; readonly body: readonly Node[] }[] {
  const headings = nodes.map((node, index) => ({ node, index })).filter(({ node }) => node.type === "heading" && node.depth === 4);
  if (headings.length === 0 || headings[0]!.index !== 0) return fail();
  return Object.freeze(headings.map(({ node, index }, headingIndex) => Object.freeze({
    heading: node,
    body: Object.freeze(nodes.slice(index + 1, headings[headingIndex + 1]?.index ?? nodes.length)),
  })));
}

function parseAnchors(nodes: readonly Node[]): CycleDesignAnchors {
  if (nodes.length !== 1 || nodes[0]?.type !== "list" || nodes[0].children?.length !== ANCHOR_LABELS.length) return fail();
  const values = new Map<string, string | null>();
  nodes[0].children.forEach((item, index) => {
    const paragraph = item.children?.[0];
    const [label, value] = paragraph?.children ?? [];
    const expected = `${ANCHOR_LABELS[index]}: `;
    if (
      item.type !== "listItem" || item.children?.length !== 1 || paragraph?.type !== "paragraph"
      || label?.type !== "text"
    ) return fail();
    if (
      paragraph.children?.length === 2
      && label.value === expected
      && value?.type === "inlineCode"
      && value.value !== undefined
    ) values.set(ANCHOR_LABELS[index]!, value.value);
    else if (
      ANCHOR_LABELS[index] === "Predecessor Cycle ID"
      && paragraph.children?.length === 1
      && label.value === `${expected}None`
    ) {
      values.set(ANCHOR_LABELS[index]!, null);
    } else return fail();
  });
  const get = (label: typeof ANCHOR_LABELS[number]): string => values.get(label) ?? fail();
  return Object.freeze({
    cycle_id: get("Cycle ID"),
    predecessor_cycle_issue_id: values.get("Predecessor Cycle ID") ?? null,
    predecessor_terminal_record_id: get("Predecessor Terminal Record ID"),
    approval_record_id: get("Approval Record ID"),
    plan_issue_id: get("Plan Issue ID"),
    plan_completion_record_id: get("Plan Completion Record ID"),
    plan_invalidation_record_id: get("Plan Invalidation Record ID"),
    cycle_completion_record_id: get("Cycle Completion Record ID"),
    cycle_invalidation_record_id: get("Cycle Invalidation Record ID"),
    delivery_completion_record_id: get("Delivery Completion Record ID"),
    delivery_invalidation_record_id: get("Delivery Invalidation Record ID"),
    identity_derivation_version: get("Identity Derivation Version"),
    workspace_base_revision: get("Workspace Base Revision"),
  });
}

export function parseCycleDesignMarkdown(cycleMarkdown: unknown): CycleDesignMarkdown {
  const mapping = parseCycleDraftMarkdown(cycleMarkdown).acceptance_mapping_markdown;
  const root = fromMarkdown(mapping) as Node;
  const nodes = root.children ?? [];
  if (headingText(nodes[0] ?? fail(), 2) !== "Acceptance Mapping") return fail();
  const sections = nodes.map((node, index) => ({ node, index })).filter(({ node }) => node.type === "heading" && node.depth === 3);
  if (sections.length !== SECTION_NAMES.length || sections.some(({ node }, index) => headingText(node, 3) !== SECTION_NAMES[index])) return fail();
  const bodies = sections.map(({ index }, sectionIndex) => nodes.slice(index + 1, sections[sectionIndex + 1]?.index ?? nodes.length));
  const execution = entryBodies(bodies[1]!).map(({ heading, body }) => Object.freeze({
    directive_id: entryIdentity(heading, "Directive: "),
    instruction_markdown: instruction(mapping, body),
    depends_on_directive_ids: labeledList(body, "Dependencies", true),
    acceptance_criterion_ids: labeledList(body, "Acceptance Criteria", false),
  }));
  const groups = entryBodies(bodies[2]!).map(({ heading, body }) => Object.freeze({
    work_group_id: entryIdentity(heading, "Work Group: "),
    directive_ids: labeledList(body, "Directives", false) as readonly [string, ...string[]],
    depends_on_work_group_ids: labeledList(body, "Dependencies", true),
  }));
  const verify = entryBodies(bodies[3]!).map(({ heading, body }) => Object.freeze({
    directive_id: entryIdentity(heading, "Verification Directive: "),
    instruction_markdown: instruction(mapping, body),
    acceptance_criterion_ids: labeledList(body, "Acceptance Criteria", false),
  }));
  return Object.freeze({
    anchors: parseAnchors(bodies[0]!),
    execution_directives: execution as unknown as readonly [ExecutionDirective, ...ExecutionDirective[]],
    approved_work_groups: groups as unknown as readonly [ApprovedWorkGroup, ...ApprovedWorkGroup[]],
    verify_directives: verify as unknown as readonly [VerificationDirective, ...VerificationDirective[]],
  });
}
