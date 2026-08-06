import { parseCommentId } from "./identity.js";
import {
  asRecord,
  freezeObject,
  parseArray,
  parseBoundedString,
  parseMarkdownText,
  parseStringArray,
  type MarkdownText,
} from "./validation.js";

export interface HumanActionState {
  readonly comment_id: string;
  readonly reply_cursor?: string | undefined;
}

export interface ArchitectureDecisionDraft {
  readonly title: MarkdownText;
  readonly decision: MarkdownText;
  readonly rationale: MarkdownText;
  readonly consequences: readonly MarkdownText[];
}

export interface ArchitectureDecision extends ArchitectureDecisionDraft {
  readonly id: string;
  readonly source_action_comment_id: string;
  readonly source_reply_ids: readonly string[];
  readonly decided_at: string;
}

export function parseHumanActionState(value: unknown): HumanActionState {
  const record = asRecord(value, "invalid_human_action");
  const keys = Object.keys(record).sort().join("\0");
  if (keys !== ["comment_id"].join("\0") && keys !== ["comment_id", "reply_cursor"].join("\0")) {
    throw new Error("invalid_contract_keys");
  }
  const replyCursor = record.reply_cursor === undefined ? undefined : parseCommentId(record.reply_cursor);
  return freezeObject({
    comment_id: parseCommentId(record.comment_id),
    ...(replyCursor === undefined ? {} : { reply_cursor: replyCursor }),
  });
}

function parseConsequences(value: unknown): readonly MarkdownText[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error("invalid_architecture_decision_consequences");
  return parseArray(value, (entry) => parseMarkdownText(entry, "invalid_architecture_decision_consequence"));
}

export function parseArchitectureDecisionDraft(value: unknown): ArchitectureDecisionDraft {
  const record = asRecord(value, "invalid_architecture_decision");
  if (Object.keys(record).sort().join("\0") !== ["consequences", "decision", "rationale", "title"].sort().join("\0")) {
    throw new Error("invalid_contract_keys");
  }
  return freezeObject({
    title: parseMarkdownText(record.title, "invalid_architecture_decision_title"),
    decision: parseMarkdownText(record.decision, "invalid_architecture_decision_value"),
    rationale: parseMarkdownText(record.rationale, "invalid_architecture_decision_rationale"),
    consequences: parseConsequences(record.consequences),
  });
}

export function parseArchitectureDecision(value: unknown): ArchitectureDecision {
  const record = asRecord(value, "invalid_architecture_decision");
  if (Object.keys(record).sort().join("\0") !== [
    "consequences", "decided_at", "decision", "id", "rationale",
    "source_action_comment_id", "source_reply_ids", "title",
  ].sort().join("\0")) throw new Error("invalid_contract_keys");
  const id = parseBoundedString(record.id, "invalid_architecture_decision_id", 32);
  if (!/^ADR-[0-9]{3,}$/u.test(id)) throw new Error("invalid_architecture_decision_id");
  const decidedAt = parseBoundedString(record.decided_at, "invalid_architecture_decision_time", 64);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT[+-][0-9]{2}:[0-9]{2}$/u.test(decidedAt)) {
    throw new Error("invalid_architecture_decision_time");
  }
  return freezeObject({
    id,
    title: parseMarkdownText(record.title, "invalid_architecture_decision_title"),
    decision: parseMarkdownText(record.decision, "invalid_architecture_decision_value"),
    rationale: parseMarkdownText(record.rationale, "invalid_architecture_decision_rationale"),
    consequences: parseConsequences(record.consequences),
    source_action_comment_id: parseCommentId(record.source_action_comment_id),
    source_reply_ids: parseStringArray(record.source_reply_ids, parseCommentId),
    decided_at: decidedAt,
  });
}
