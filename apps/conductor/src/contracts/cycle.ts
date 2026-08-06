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

export type CritiqueEnvelope =
  | {
    readonly verdict: Exclude<CritiqueVerdict, "process_error">;
    readonly task_state_markdown: MarkdownText;
    readonly pending_finding?: MarkdownText | undefined;
  }
  | { readonly verdict: "process_error"; readonly reason: string };

export interface CritiqueArtifact {
  readonly envelope: CritiqueEnvelope;
  readonly report_markdown: MarkdownText;
}

export type CritiqueCheckpoint =
  | {
    readonly verdict: Exclude<CritiqueVerdict, "process_error">;
    readonly task_state_markdown: MarkdownText;
    readonly pending_finding?: MarkdownText | undefined;
    readonly artifact_url?: string | undefined;
  }
  | {
    readonly verdict: "process_error";
    readonly reason: string;
    readonly artifact_url?: string | undefined;
  };

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

export function parseCritiqueEnvelope(value: unknown): CritiqueEnvelope {
  const record = asRecord(value, "invalid_critic_result");
  const verdict = parseCritiqueVerdict(record.verdict);
  if (verdict === "process_error") {
    assertAllowedKeys(record, ["verdict", "reason"]);
    return freezeObject({
      verdict,
      reason: parseBoundedString(record.reason, "invalid_critic_process_error", 256),
    });
  }

  assertAllowedKeys(record, ["verdict", "task_state_markdown"], ["pending_finding"]);
  const taskStateMarkdown = parseMarkdownText(record.task_state_markdown, "invalid_critic_task_state");
  const pendingFinding = optionalMarkdown(record, "pending_finding", "invalid_critic_pending_finding");
  const parsed = {
    verdict,
    task_state_markdown: taskStateMarkdown,
    ...(pendingFinding === undefined ? {} : { pending_finding: pendingFinding }),
  };
  return freezeObject(parsed);
}

function validatedCriticMarkdown(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 32 * 1024 || /\0/u.test(value)) {
    throw new Error("invalid_critic_markdown");
  }
  try {
    parseMarkdownText(value, "invalid_critic_markdown", 32 * 1024);
  } catch {
    throw new Error("invalid_critic_markdown");
  }
  return value;
}

export function parseCritiqueArtifact(value: unknown): CritiqueArtifact {
  const record = asRecord(value, "invalid_critic_artifact");
  assertAllowedKeys(record, ["envelope", "report_markdown"]);
  return freezeObject({
    envelope: parseCritiqueEnvelope(record.envelope),
    report_markdown: parseMarkdownText(record.report_markdown, "invalid_critic_report", 32 * 1024),
  });
}

export function parseCritiqueCheckpoint(value: unknown): CritiqueCheckpoint {
  const record = asRecord(value, "invalid_critic_checkpoint");
  const verdict = parseCritiqueVerdict(record.verdict);
  const artifactUrl = parseOptional(record.artifact_url, (entry) =>
    parseBoundedString(entry, "invalid_critic_artifact_url", 2_048));
  if (verdict === "process_error") {
    assertAllowedKeys(record, ["verdict", "reason"], ["artifact_url"]);
    return freezeObject({
      verdict,
      reason: parseBoundedString(record.reason, "invalid_critic_process_error", 256),
      ...(artifactUrl === undefined ? {} : { artifact_url: artifactUrl }),
    });
  }
  assertAllowedKeys(record, ["verdict", "task_state_markdown"], ["pending_finding", "artifact_url"]);
  const pendingFinding = optionalMarkdown(record, "pending_finding", "invalid_critic_pending_finding");
  return freezeObject({
    verdict,
    task_state_markdown: parseMarkdownText(record.task_state_markdown, "invalid_critic_task_state"),
    ...(pendingFinding === undefined ? {} : { pending_finding: pendingFinding }),
    ...(artifactUrl === undefined ? {} : { artifact_url: artifactUrl }),
  });
}

/** Parse the compact machine envelope and retain the remaining Markdown verbatim. */
export function parseCritiqueResultMarkdown(value: unknown): CritiqueArtifact {
  const source = validatedCriticMarkdown(value);
  const match = /^```json\r?\n([^\r\n]+)\r?\n```\r?\n\r?\n([\s\S]+)$/u.exec(source);
  if (match?.[1] === undefined || match[2] === undefined) throw new Error("invalid_critic_markdown");
  let envelope: CritiqueEnvelope;
  try {
    envelope = parseCritiqueEnvelope(JSON.parse(match[1]) as unknown);
  } catch {
    throw new Error("invalid_critic_markdown");
  }
  try {
    return parseCritiqueArtifact({ envelope, report_markdown: match[2] });
  } catch {
    throw new Error("invalid_critic_markdown");
  }
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
