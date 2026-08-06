import {
  parseCriticIssueId,
  parseCritiqueVerdict,
  parseCycleResult,
  parseCommentId,
  type CriticIssueId,
  type CritiqueVerdict,
  type CycleResult,
  type CommentId,
} from "./identity.js";
import {
  asRecord,
  freezeObject,
  parseArray,
  parseBoundedString,
  parseMarkdownText,
  parseOptional,
  parsePositiveInteger,
  parseStringArray,
  type MarkdownText,
  type UnknownRecord,
} from "./validation.js";

export interface CycleSpec {
  readonly cycle_number: number;
  readonly objective: MarkdownText;
  readonly acceptance: MarkdownText;
  readonly boundaries: MarkdownText;
  readonly consumed_comment_ids: readonly CommentId[];
}

export type CritiqueResult =
  | {
    readonly verdict: Exclude<CritiqueVerdict, "process_error">;
    readonly scope_reviewed: MarkdownText;
    readonly implementation_review: MarkdownText;
    readonly checks: readonly MarkdownText[];
    readonly evidence: readonly MarkdownText[];
    readonly findings: readonly MarkdownText[];
    readonly task_state_markdown: MarkdownText;
    readonly pending_finding?: MarkdownText | undefined;
  }
  | { readonly verdict: "process_error"; readonly reason: string };

export interface CycleTerminalResult {
  readonly result: CycleResult;
  readonly critic_issue_id: CriticIssueId;
  readonly critic_verdict: CritiqueVerdict;
  readonly reason: string;
}

function optionalMarkdown(record: UnknownRecord, key: string, code: string): MarkdownText | undefined {
  return parseOptional(record[key], (entry) => parseMarkdownText(entry, code));
}

function assertAllowedKeys(
  record: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key))) throw new Error("invalid_contract_keys");
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error("invalid_contract_keys");
}

function markdownArray(value: unknown, code: string): readonly MarkdownText[] {
  return parseArray(value, (entry) => parseMarkdownText(entry, code));
}

export function parseCycleSpec(value: unknown): CycleSpec {
  const record = asRecord(value, "invalid_cycle_spec");
  assertAllowedKeys(record, [
    "cycle_number",
    "objective",
    "acceptance",
    "boundaries",
    "consumed_comment_ids",
  ]);
  const comments = parseStringArray(record.consumed_comment_ids, parseCommentId);
  return freezeObject({
    cycle_number: parsePositiveInteger(record.cycle_number, "invalid_cycle_number"),
    objective: parseMarkdownText(record.objective, "invalid_cycle_objective"),
    acceptance: parseMarkdownText(record.acceptance, "invalid_cycle_acceptance"),
    boundaries: parseMarkdownText(record.boundaries, "invalid_cycle_boundaries"),
    consumed_comment_ids: comments,
  });
}

export function parseCritiqueResult(value: unknown): CritiqueResult {
  const record = asRecord(value, "invalid_critic_result");
  const verdict = parseCritiqueVerdict(record.verdict);
  if (verdict === "process_error") {
    assertAllowedKeys(record, ["verdict", "reason"]);
    return freezeObject({
      verdict,
      reason: parseBoundedString(record.reason, "invalid_critic_process_error", 256),
    });
  }

  assertAllowedKeys(
    record,
    ["verdict", "scope_reviewed", "implementation_review", "checks", "evidence", "findings", "task_state_markdown"],
    ["pending_finding"],
  );
  const taskStateMarkdown = parseMarkdownText(record.task_state_markdown, "invalid_critic_task_state");
  const pendingFinding = optionalMarkdown(record, "pending_finding", "invalid_critic_pending_finding");
  const parsed = {
    verdict,
    scope_reviewed: parseMarkdownText(record.scope_reviewed, "invalid_critic_scope_reviewed"),
    implementation_review: parseMarkdownText(record.implementation_review, "invalid_critic_implementation_review"),
    checks: markdownArray(record.checks, "invalid_critic_check"),
    evidence: markdownArray(record.evidence, "invalid_critic_evidence"),
    findings: markdownArray(record.findings, "invalid_critic_finding"),
    task_state_markdown: taskStateMarkdown,
    ...(pendingFinding === undefined ? {} : { pending_finding: pendingFinding }),
  };
  return freezeObject(parsed);
}

const CRITIC_MARKDOWN_SECTIONS = [
  "Scope Reviewed", "Implementation Review", "Checks", "Evidence", "Findings", "Task State",
] as const;

function normalizedCriticMarkdown(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 32 * 1024 || /\0/u.test(value)) {
    throw new Error("invalid_critic_markdown");
  }
  try {
    parseMarkdownText(value, "invalid_critic_markdown", 32 * 1024);
  } catch {
    throw new Error("invalid_critic_markdown");
  }
  return value.replace(/\r\n?/gu, "\n");
}

function parseCriticMarkdownSections(source: string): { readonly verdict: CritiqueVerdict; readonly sections: ReadonlyMap<string, string> } {
  const lines = source.split("\n");
  const header = lines.shift();
  if (header === undefined || !/^verdict: [a-z_]+$/u.test(header)) throw new Error("invalid_critic_markdown");
  let verdict: CritiqueVerdict;
  try {
    verdict = parseCritiqueVerdict(header.slice("verdict: ".length));
  } catch {
    throw new Error("invalid_critic_markdown");
  }

  const sections = new Map<string, string>();
  let heading: string | undefined;
  let body: string[] = [];
  const flush = () => {
    if (heading === undefined) return;
    if (sections.has(heading)) throw new Error("invalid_critic_markdown");
    const value = body.join("\n").trim();
    if (value.length === 0) throw new Error("invalid_critic_markdown");
    sections.set(heading, value);
  };
  for (const line of lines) {
    if (/^## [^ ].*$/u.test(line)) {
      flush();
      heading = line.slice(3);
      body = [];
    } else if (heading === undefined) {
      if (line.trim().length > 0) throw new Error("invalid_critic_markdown");
    } else {
      body.push(line);
    }
  }
  flush();
  return { verdict, sections };
}

function parseCriticListSection(value: string, code: string): readonly MarkdownText[] {
  const lines = value.split("\n");
  if (lines.length === 1 && lines[0] === "- None") return Object.freeze([]);
  const entries: MarkdownText[] = [];
  let current: string[] | undefined;
  const flush = () => {
    if (current === undefined) return;
    const item = current.join("\n").trim();
    if (item.length === 0) throw new Error("invalid_critic_markdown");
    entries.push(parseMarkdownText(item, code));
  };
  for (const line of lines) {
    if (line.startsWith("- ")) {
      flush();
      const firstLine = line.slice(2).trimEnd();
      if (firstLine.trim().length === 0) throw new Error("invalid_critic_markdown");
      current = [firstLine];
      continue;
    }
    if (current === undefined || (line.length > 0 && !line.startsWith("  "))) {
      throw new Error("invalid_critic_markdown");
    }
    current.push(line.length === 0 ? "" : line.slice(2));
  }
  flush();
  return Object.freeze(entries);
}

/** Parse the fixed Markdown response emitted by the Critic role. */
export function parseCritiqueResultMarkdown(value: unknown): CritiqueResult {
  const source = normalizedCriticMarkdown(value);
  let parsed: { readonly verdict: CritiqueVerdict; readonly sections: ReadonlyMap<string, string> };
  try {
    parsed = parseCriticMarkdownSections(source);
  } catch {
    throw new Error("invalid_critic_markdown");
  }

  if (parsed.verdict === "process_error") {
    if (parsed.sections.size !== 1 || !parsed.sections.has("Reason")) throw new Error("invalid_critic_markdown");
    const reason = parsed.sections.get("Reason");
    if (reason === undefined) throw new Error("invalid_critic_markdown");
    const boundedReason = reason.replace(/\s+/gu, " ").trim().slice(0, 50);
    if (boundedReason.length === 0) throw new Error("invalid_critic_markdown");
    return parseCritiqueResult({ verdict: "process_error", reason: boundedReason });
  }

  if (
    parsed.sections.size !== CRITIC_MARKDOWN_SECTIONS.length
    || CRITIC_MARKDOWN_SECTIONS.some((name) => !parsed.sections.has(name))
    || [...parsed.sections.keys()].some((name, index) => name !== CRITIC_MARKDOWN_SECTIONS[index])
  ) throw new Error("invalid_critic_markdown");
  const scopeReviewed = parsed.sections.get("Scope Reviewed");
  const implementationReview = parsed.sections.get("Implementation Review");
  const checks = parsed.sections.get("Checks");
  const evidence = parsed.sections.get("Evidence");
  const findings = parsed.sections.get("Findings");
  const taskState = parsed.sections.get("Task State");
  if (
    scopeReviewed === undefined
    || implementationReview === undefined
    || checks === undefined
    || evidence === undefined
    || findings === undefined
    || taskState === undefined
  ) {
    throw new Error("invalid_critic_markdown");
  }
  return parseCritiqueResult({
    verdict: parsed.verdict,
    scope_reviewed: parseMarkdownText(scopeReviewed, "invalid_critic_scope_reviewed"),
    implementation_review: parseMarkdownText(implementationReview, "invalid_critic_implementation_review"),
    checks: parseCriticListSection(checks, "invalid_critic_check"),
    evidence: parseCriticListSection(evidence, "invalid_critic_evidence"),
    findings: parseCriticListSection(findings, "invalid_critic_finding"),
    task_state_markdown: parseMarkdownText(taskState, "invalid_critic_task_state"),
  });
}

export function parseCycleTerminalResult(value: unknown): CycleTerminalResult {
  const record = asRecord(value, "invalid_cycle_terminal_result");
  assertAllowedKeys(record, ["result", "critic_issue_id", "critic_verdict", "reason"]);
  const result = parseCycleResult(record.result);
  const critiqueVerdict = parseCritiqueVerdict(record.critic_verdict);
  const expected = result === "succeeded"
    ? ["accepted"]
    : result === "rejected"
      ? ["incomplete"]
      : ["blocked", "violation", "process_error"];
  if (!expected.includes(critiqueVerdict)) throw new Error("cycle_result_verdict_mismatch");
  return freezeObject({
    result,
    critic_issue_id: parseCriticIssueId(record.critic_issue_id),
    critic_verdict: critiqueVerdict,
    reason: parseBoundedString(record.reason, "invalid_cycle_result_reason", 512),
  });
}
