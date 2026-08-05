import {
  parseRootReconcileReportMarkdown,
  parseRootState,
  type RootReconcileDecision,
  type RootState,
} from "../contracts/root.js";
import { parseMarkdownText, type MarkdownText } from "../contracts/validation.js";

import type { LinearGateway } from "./LinearGateway.js";
import { parseLinearDescriptionTimestamp } from "./LinearDescriptionTimestamp.js";

/** The only bytes Conductor owns in a Root Issue description. */
export const ROOT_MANAGED_ROOT_START = "# Symphony Harness: Managed Root";
export const ROOT_MANAGED_ROOT_END = "# Symphony Harness: End Managed Root";
export const ROOT_STATE_SECTION_HEADING = "## Root State";
export const ROOT_RECONCILE_SECTION_HEADING = "## Reconcile";
const UPDATED_AT_PREFIX = "Updated at: ";

export interface RootDescriptionProjection {
  readonly requirement: MarkdownText;
  readonly state?: RootState | undefined;
  readonly reconcile_report?: MarkdownText | undefined;
  readonly updated_at?: string | undefined;
}

function malformed(): never {
  throw new Error("linear_root_description_malformed");
}

function parseUpdatedAt(value: unknown): string {
  try {
    return parseLinearDescriptionTimestamp(value);
  } catch {
    return malformed();
  }
}

function reconcileKind(report: string): RootReconcileDecision["kind"] {
  if (report.startsWith("### Why Continue\n")) return "create_cycle";
  if (report.startsWith("### Overview\n")) return "complete";
  if (report.startsWith("### Reason\n")) return "needs_human";
  return malformed();
}

function parseManagedBody(lines: readonly string[]): {
  readonly state: RootState;
  readonly reconcile_report?: MarkdownText | undefined;
  readonly updated_at: string;
} {
  const body = lines.join("\n").replace(/^\n/u, "").replace(/\n$/u, "");
  const newline = body.indexOf("\n");
  if (newline < 0) malformed();
  const updatedAtLine = body.slice(0, newline);
  if (!updatedAtLine.startsWith(UPDATED_AT_PREFIX)) malformed();
  const updated_at = parseUpdatedAt(updatedAtLine.slice(UPDATED_AT_PREFIX.length));
  const stateBody = body.slice(newline + 1).replace(/^\n/u, "");
  const statePrefix = `${ROOT_STATE_SECTION_HEADING}\n\n\`\`\`json\n`;
  if (!stateBody.startsWith(statePrefix)) malformed();

  const closingFence = stateBody.indexOf("\n```", statePrefix.length);
  if (closingFence < 0) malformed();
  const json = stateBody.slice(statePrefix.length, closingFence);
  if (json.length === 0 || json.includes("\n```")) malformed();
  let state: RootState;
  try {
    state = parseRootState(JSON.parse(json) as unknown);
  } catch {
    malformed();
  }
  if (JSON.stringify(state, null, 2) !== json) malformed();

  const remainder = stateBody.slice(closingFence + "\n```".length);
  if (remainder.length === 0) return { state, updated_at };
  const reportPrefix = `\n\n${ROOT_RECONCILE_SECTION_HEADING}\n\n`;
  if (!remainder.startsWith(reportPrefix)) malformed();
  const report = remainder.slice(reportPrefix.length);
  if (report.length === 0) malformed();
  const parsedReport = parseRootReconcileReportMarkdown(report, reconcileKind(report));
  return { state, reconcile_report: parsedReport, updated_at };
}

export function parseRootDescription(value: unknown): RootDescriptionProjection {
  if (typeof value !== "string" || value.length === 0 || value.length > 100_000 || value.includes("\0")) {
    malformed();
  }
  const source = value.replace(/\r\n?/gu, "\n");
  const lines = source.split("\n");
  const starts = lines.flatMap((line, index) => line === ROOT_MANAGED_ROOT_START ? [index] : []);
  const ends = lines.flatMap((line, index) => line === ROOT_MANAGED_ROOT_END ? [index] : []);
  if (starts.length === 0 && ends.length === 0) {
    try {
      return Object.freeze({ requirement: parseMarkdownText(source, "linear_root_description_malformed") });
    } catch {
      malformed();
    }
  }
  if (starts.length !== 1 || ends.length !== 1 || (starts[0] as number) >= (ends[0] as number)) malformed();
  const start = starts[0] as number;
  const end = ends[0] as number;
  if (end !== lines.length - 1) malformed();
  const requirementRaw = lines.slice(0, start).join("\n").replace(/\n+$/u, "");
  let requirement: MarkdownText;
  try {
    requirement = parseMarkdownText(requirementRaw, "linear_root_description_malformed");
  } catch {
    malformed();
  }
  let managed: ReturnType<typeof parseManagedBody>;
  try {
    managed = parseManagedBody(lines.slice(start + 1, end));
  } catch {
    malformed();
  }
  return Object.freeze({
    requirement,
    state: managed.state,
    updated_at: managed.updated_at,
    ...(managed.reconcile_report === undefined ? {} : { reconcile_report: managed.reconcile_report }),
  });
}

export function renderRootDescription(
  requirement: MarkdownText | string,
  state: RootState,
  reconcileReport?: MarkdownText | string,
  updatedAt?: string,
): MarkdownText {
  let parsedRequirement: MarkdownText;
  try {
    parsedRequirement = parseMarkdownText(requirement, "linear_root_description_malformed");
  } catch {
    malformed();
  }
  const parsedState = parseRootState(state);
  if (updatedAt === undefined) malformed();
  const parsedUpdatedAt = parseUpdatedAt(updatedAt);
  let report: MarkdownText | undefined;
  if (reconcileReport !== undefined) {
    const parsed = parseMarkdownText(reconcileReport, "linear_root_description_malformed");
    report = parseRootReconcileReportMarkdown(parsed, reconcileKind(parsed));
  }
  const value = [
    parsedRequirement,
    "",
    ROOT_MANAGED_ROOT_START,
    "",
    `${UPDATED_AT_PREFIX}${parsedUpdatedAt}`,
    "",
    ROOT_STATE_SECTION_HEADING,
    "",
    "```json",
    JSON.stringify(parsedState, null, 2),
    "```",
    ...(report === undefined ? [] : ["", ROOT_RECONCILE_SECTION_HEADING, "", report]),
    "",
    ROOT_MANAGED_ROOT_END,
  ].join("\n");
  try {
    return parseMarkdownText(value, "linear_root_description_malformed");
  } catch {
    malformed();
  }
}

export async function updateRootDescription(
  gateway: LinearGateway,
  rootId: string,
  requirement: MarkdownText | string,
  state: RootState,
  reconcileReport?: MarkdownText | string,
  updatedAt?: string,
): Promise<RootDescriptionProjection> {
  const description = renderRootDescription(requirement, state, reconcileReport, updatedAt);
  await gateway.update_issue_description(rootId, description);
  return parseRootDescription(description);
}
