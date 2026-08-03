import { createHash } from "node:crypto";

import { fromMarkdown } from "mdast-util-from-markdown";

import { parseTaskIssueId } from "./identity.js";
import { canonicalTaskRevision } from "./task-management.js";
import { asRecord, parseBoundedString, type MarkdownText, type UnknownRecord } from "./validation.js";

const PROVIDER_FIELDS = new Set([
  "record_id", "revision", "actor_id", "created_at", "updated_at", "archived_at",
]);

export interface TaskIssueRecordProviderEvidence {
  readonly comment_id: string;
  readonly issue_id: string;
  readonly provider_created_at: string;
  readonly provider_updated_at: string;
  readonly provider_edited_at: string | null;
  readonly provider_archived_at: string | null;
  readonly actor_id: string | null;
  readonly body_digest: string;
}

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function canonicalJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  const record = asRecord(value);
  return Object.freeze(Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  ));
}

function assertProjection(value: unknown): UnknownRecord {
  const record = asRecord(value);
  if (Object.keys(record).length === 0 || Object.keys(record).some((key) => PROVIDER_FIELDS.has(key))) {
    throw new Error("record_provider_field_forbidden");
  }
  parseTaskIssueId(record.issue_id);
  parseTaskIssueId(record.cycle_id);
  parseBoundedString(record.record_kind, "invalid_record_kind", 128);
  return record;
}

export function renderTaskIssueRecordProjectionMarkdown(value: unknown): MarkdownText {
  const projection = assertProjection(value);
  const json = JSON.stringify(canonicalJsonValue(projection), null, 2);
  return `## Symphony Record\n\n\`\`\`json\n${json}\n\`\`\`` as MarkdownText;
}

export function parseTaskIssueRecordProjectionMarkdown(value: unknown): UnknownRecord {
  if (typeof value !== "string" || value.length < 1 || value.length > 100_000 || /\0/u.test(value)) {
    throw new Error("invalid_record_markdown");
  }
  const tree = fromMarkdown(value) as {
    readonly children?: readonly {
      readonly type: string;
      readonly depth?: number;
      readonly lang?: string | null;
      readonly meta?: string | null;
      readonly value?: string;
      readonly children?: readonly { readonly type: string; readonly value?: string }[];
    }[];
  };
  const [heading, code] = tree.children ?? [];
  if (
    tree.children?.length !== 2
    || heading?.type !== "heading"
    || heading.depth !== 2
    || heading.children?.length !== 1
    || heading.children[0]?.type !== "text"
    || heading.children[0].value !== "Symphony Record"
    || code?.type !== "code"
    || code.lang !== "json"
    || (code.meta !== null && code.meta !== undefined)
    || code.value === undefined
  ) throw new Error("invalid_record_markdown");
  try {
    return Object.freeze({ ...assertProjection(JSON.parse(code.value) as unknown) });
  } catch (error) {
    if (error instanceof Error && error.message === "record_provider_field_forbidden") throw error;
    throw new Error("invalid_record_markdown");
  }
}

function exactTimestamp(value: unknown): string {
  const timestamp = parseBoundedString(value, "record_provider_evidence_invalid", 64);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error("record_provider_evidence_invalid");
  }
  return timestamp;
}

export function projectTaskIssueRecord(
  bodyMarkdown: unknown,
  evidence: TaskIssueRecordProviderEvidence,
): UnknownRecord {
  const projection = parseTaskIssueRecordProjectionMarkdown(bodyMarkdown);
  const issueId = parseTaskIssueId(evidence.issue_id);
  const createdAt = exactTimestamp(evidence.provider_created_at);
  const updatedAt = exactTimestamp(evidence.provider_updated_at);
  const actorId = evidence.actor_id === null
    ? null : parseBoundedString(evidence.actor_id, "record_provider_evidence_invalid", 128);
  const actualDigest = typeof bodyMarkdown === "string"
    ? createHash("sha256").update(bodyMarkdown, "utf8").digest("hex") : null;
  if (
    projection.issue_id !== issueId
    || createdAt !== updatedAt
    || evidence.provider_edited_at !== null
    || evidence.provider_archived_at !== null
    || actorId === null
    || evidence.body_digest !== actualDigest
  ) throw new Error("record_provider_evidence_invalid");
  const fields = Object.freeze({
    record_id: parseBoundedString(evidence.comment_id, "record_provider_evidence_invalid", 128),
    ...projection,
    actor_id: actorId,
    created_at: createdAt,
    updated_at: updatedAt,
    archived_at: null,
  });
  return Object.freeze({
    ...fields,
    revision: canonicalTaskRevision(fields),
  });
}
