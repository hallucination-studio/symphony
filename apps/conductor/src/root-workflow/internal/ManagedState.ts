import { createHash } from "node:crypto";
import type { RootIssue, RootManagedComment } from "../api/Models.js";

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const rootMarker = "<!-- symphony root marker -->";
const rootFields = new Set([
  "conductor_id",
  "performer_profile_id",
  "performer_id",
  "planned_root_input_hash",
  "usage_input_tokens",
  "usage_cached_input_tokens",
  "usage_output_tokens",
  "usage_reasoning_output_tokens",
  "usage_total_tokens",
  "last_usage_turn_id",
  "delivery_branch",
  "pull_request",
  "last_error",
]);
const workMetadataPattern =
  /\n*<!-- symphony work metadata\nkind: ([^\n]+)\norigin: ([^\n]+)\ncompleted_input_hash: ([^\n]+)\n-->\s*$/;
const workIdentityPattern =
  /\n*<!-- symphony managed marker\nmanaged_marker: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})\n-->\s*$/;
const humanMarkerPattern =
  /\n*<!-- symphony managed marker\nmanaged_marker: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})\nkind: human\nhuman_kind: (plan_approval|planned_input|runtime_input)\ntarget_issue_id: ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127}|none)\n-->\s*$/;

export function parseRootManagedComment(
  source: string,
): ParseResult<RootManagedComment> {
  if (
    !source.startsWith("Symphony Root Run\n") ||
    !source.endsWith(rootMarker)
  ) {
    return { ok: false, error: "root_managed_marker_invalid" };
  }
  const values = new Map<string, string>();
  for (const line of source.split("\n").slice(1, -1)) {
    const separator = line.indexOf(":");
    if (separator < 1) {
      if (line.trim()) {
        return { ok: false, error: "root_managed_comment_line_invalid" };
      }
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!rootFields.has(key)) {
      return { ok: false, error: `unknown_root_managed_field:${key}` };
    }
    if (values.has(key)) {
      return { ok: false, error: `duplicate_root_managed_field:${key}` };
    }
    values.set(key, line.slice(separator + 1).trim());
  }
  const conductorId = required(values, "conductor_id");
  const performerProfileId = required(values, "performer_profile_id");
  const deliveryBranch = required(values, "delivery_branch");
  const usage = [
    "usage_input_tokens",
    "usage_cached_input_tokens",
    "usage_output_tokens",
    "usage_reasoning_output_tokens",
    "usage_total_tokens",
  ].map((key) => nonNegativeInteger(values, key));
  if (!conductorId.ok || !performerProfileId.ok || !deliveryBranch.ok) {
    return { ok: false, error: "root_managed_comment_incomplete" };
  }
  if (!usage.every(isParseSuccess)) {
    return { ok: false, error: "root_usage_invalid" };
  }
  const value: RootManagedComment = {
    conductorId: conductorId.value,
    performerProfileId: performerProfileId.value,
    deliveryBranch: deliveryBranch.value,
    usage: {
      inputTokens: usage[0]!.value,
      cachedInputTokens: usage[1]!.value,
      outputTokens: usage[2]!.value,
      reasoningOutputTokens: usage[3]!.value,
      totalTokens: usage[4]!.value,
    },
  };
  assignOptional(value, "performerId", optional(values, "performer_id"));
  assignOptional(
    value,
    "plannedRootInputHash",
    optional(values, "planned_root_input_hash"),
  );
  assignOptional(value, "pullRequest", optional(values, "pull_request"));
  assignOptional(value, "lastError", optional(values, "last_error"));
  assignOptional(
    value,
    "lastUsageTurnId",
    optional(values, "last_usage_turn_id"),
  );
  return { ok: true, value };
}

export function parseWorkDescription(source: string): ParseResult<{
  businessDescription: string;
  managedMarker?: string;
  origin?: "user" | "symphony";
  completedInputHash?: string;
}> {
  const match = source.match(workMetadataPattern);
  if (!match) {
    if (
      source.includes("symphony work metadata") ||
      source.includes("completed_input_hash:")
    ) {
      return { ok: false, error: "work_managed_metadata_invalid" };
    }
    return { ok: true, value: { businessDescription: source.trim() } };
  }
  if (match[1] !== "work" || !["user", "symphony"].includes(match[2]!)) {
    return { ok: false, error: "work_managed_metadata_invalid" };
  }
  const beforeMetadata = source.slice(0, match.index);
  const identity = beforeMetadata.match(workIdentityPattern);
  if (match[2] === "symphony" && !identity) {
    return { ok: false, error: "work_managed_marker_missing" };
  }
  const value: {
    businessDescription: string;
    managedMarker?: string;
    origin?: "user" | "symphony";
    completedInputHash?: string;
  } = {
    businessDescription:
      identity?.index === undefined
        ? beforeMetadata.trim()
        : beforeMetadata.slice(0, identity.index).trim(),
    origin: match[2] as "user" | "symphony",
  };
  if (identity) value.managedMarker = identity[1]!;
  if (match[3] && match[3] !== "none") value.completedInputHash = match[3];
  return { ok: true, value };
}

export function parseHumanDescription(source: string): ParseResult<{
  businessDescription: string;
  managedMarker: string;
  humanKind: "plan_approval" | "planned_input" | "runtime_input";
  targetIssueId?: string;
}> {
  const match = source.match(humanMarkerPattern);
  if (!match || match.index === undefined) {
    return { ok: false, error: "human_managed_marker_invalid" };
  }
  const humanKind = match[2] as
    | "plan_approval"
    | "planned_input"
    | "runtime_input";
  const targetIssueId = match[3]!;
  if (
    (humanKind === "plan_approval" && targetIssueId !== "none") ||
    (humanKind !== "plan_approval" && targetIssueId === "none")
  ) {
    return { ok: false, error: "human_managed_marker_invalid" };
  }
  return {
    ok: true,
    value: {
      businessDescription: source.slice(0, match.index).trim(),
      managedMarker: match[1]!,
      humanKind,
      ...(targetIssueId !== "none" ? { targetIssueId } : {}),
    },
  };
}

export function hashRootInput(root: Pick<RootIssue, "title" | "description">) {
  return hash({ title: root.title.trim(), description: root.description.trim() });
}

export function hashWorkInput(
  root: Pick<RootIssue, "title" | "description">,
  work: {
    identifier: string;
    title: string;
    description: string;
    humanInputs: Array<{ issueId: string; status: string; answer?: string }>;
    isLeaf: boolean;
  },
) {
  return hash({
    root: { title: root.title.trim(), description: root.description.trim() },
    work: {
      identifier: work.identifier,
      title: work.title.trim(),
      description: work.description.trim(),
      humanInputs: work.humanInputs,
      isLeaf: work.isLeaf,
    },
  });
}

function hash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function required(values: Map<string, string>, key: string): ParseResult<string> {
  const value = values.get(key);
  return value && value !== "none"
    ? { ok: true, value }
    : { ok: false, error: `missing:${key}` };
}

function optional(values: Map<string, string>, key: string) {
  const value = values.get(key);
  return !value || value === "none" ? undefined : value;
}

function nonNegativeInteger(
  values: Map<string, string>,
  key: string,
): ParseResult<number> {
  const value = values.get(key);
  if (!value || !/^\d+$/.test(value)) {
    return { ok: false, error: `invalid:${key}` };
  }
  const number = Number(value);
  return Number.isSafeInteger(number)
    ? { ok: true, value: number }
    : { ok: false, error: `invalid:${key}` };
}

function assignOptional<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
) {
  if (value !== undefined) target[key] = value;
}

function isParseSuccess<T>(
  result: ParseResult<T>,
): result is { ok: true; value: T } {
  return result.ok;
}
