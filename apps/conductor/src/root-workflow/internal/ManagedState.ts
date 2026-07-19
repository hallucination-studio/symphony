import type { V3RootManagedComment } from "../api/Models.js";

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const v3RootMarker = "<!-- symphony root";
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export function parseV3RootManagedComment(
  source: string,
): ParseResult<V3RootManagedComment> {
  const markerStart = source.lastIndexOf(`${v3RootMarker}\n`);
  if (!source.startsWith("Symphony\n") || markerStart < 0 || !source.endsWith("\n-->")) {
    return { ok: false, error: "root_managed_marker_invalid" };
  }
  const values = new Map<string, string>();
  const allowed = new Set([
    "conductor_id", "performer_profile_id", "performer_id", "delivery_branch",
    "pull_request", "retry_blocked", "retry_expected_performer_id",
    "retry_failure_code", "retry_observed_at",
  ]);
  for (const line of source.slice(markerStart + v3RootMarker.length + 1, -4).split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) return { ok: false, error: "root_managed_comment_line_invalid" };
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!allowed.has(key)) return { ok: false, error: `unknown_root_managed_field:${key}` };
    if (values.has(key)) return { ok: false, error: `duplicate_root_managed_field:${key}` };
    values.set(key, value);
  }
  if ([...allowed].some((key) => !values.has(key))) {
    return { ok: false, error: "root_managed_comment_incomplete" };
  }
  const conductorId = values.get("conductor_id")!;
  const profileId = values.get("performer_profile_id")!;
  const performerId = none(values.get("performer_id")!);
  const branch = values.get("delivery_branch")!;
  const pullRequest = none(values.get("pull_request")!);
  if (!validIdentifier(conductorId) || !validIdentifier(profileId)
    || (performerId !== undefined && !validIdentifier(performerId))
    || !validField(branch)
    || (pullRequest !== undefined && !validHttpsUrl(pullRequest))) {
    return { ok: false, error: "root_managed_identity_invalid" };
  }
  const retryBlocked = values.get("retry_blocked");
  const retryExpected = none(values.get("retry_expected_performer_id")!);
  const retryFailure = none(values.get("retry_failure_code")!);
  const retryObservedAt = none(values.get("retry_observed_at")!);
  if (retryBlocked !== "true" && retryBlocked !== "false") {
    return { ok: false, error: "root_retry_block_invalid" };
  }
  if (retryBlocked === "false" && (
    retryExpected !== undefined || retryFailure !== undefined || retryObservedAt !== undefined
  )) return { ok: false, error: "root_retry_block_invalid" };
  if (retryBlocked === "true" && (
    (retryExpected !== undefined && !validIdentifier(retryExpected))
    || retryFailure === undefined || !validIdentifier(retryFailure)
    || retryObservedAt === undefined || !validTimestamp(retryObservedAt)
  )) return { ok: false, error: "root_retry_block_invalid" };
  return {
    ok: true,
    value: {
      conductorId,
      performerProfileId: profileId,
      ...(performerId === undefined ? {} : { performerId }),
      deliveryBranch: branch,
      ...(pullRequest === undefined ? {} : { pullRequest }),
      ...(retryBlocked === "true" ? {
        retryBlock: {
          ...(retryExpected === undefined ? {} : { expectedPerformerId: retryExpected }),
          failureCode: retryFailure!,
          observedAt: retryObservedAt!,
        },
      } : {}),
    },
  };
}

export function serializeV3RootManagedComment(value: V3RootManagedComment): string {
  const retry = value.retryBlock;
  const lines = [
    "Symphony",
    `Conductor: ${value.conductorId}`,
    `Performer profile: ${value.performerProfileId}`,
    `Conversation: ${retry ? "action required" : value.performerId ? "active" : "restarting"}`,
    `Activity: ${retry ? "failed" : "none"}`,
    "Evidence: current Linear and Git read-back",
    `Observed at: ${retry?.observedAt ?? "none"}`,
    `Branch: ${value.deliveryBranch}`,
    `Pull request: ${value.pullRequest ?? "none"}`,
    `Current problem: ${retry?.failureCode ?? "none"}`,
    "",
    v3RootMarker,
    `conductor_id: ${field(value.conductorId)}`,
    `performer_profile_id: ${field(value.performerProfileId)}`,
    `performer_id: ${value.performerId ? field(value.performerId) : "none"}`,
    `delivery_branch: ${field(value.deliveryBranch)}`,
    `pull_request: ${value.pullRequest ? field(value.pullRequest) : "none"}`,
    `retry_blocked: ${retry ? "true" : "false"}`,
    `retry_expected_performer_id: ${retry?.expectedPerformerId
      ? field(retry.expectedPerformerId) : "none"}`,
    `retry_failure_code: ${retry ? field(retry.failureCode) : "none"}`,
    `retry_observed_at: ${retry ? field(retry.observedAt) : "none"}`,
    "-->",
  ];
  const rendered = lines.join("\n");
  const parsed = parseV3RootManagedComment(rendered);
  if (!parsed.ok) throw new Error(parsed.error);
  return rendered;
}

function none(value: string): string | undefined {
  return value === "none" ? undefined : value;
}

function validIdentifier(value: string): boolean {
  return identifierPattern.test(value);
}

function validField(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && !/[\r\n\0]/u.test(value);
}

function validHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function field(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 2048 || /[\r\n]/.test(normalized)) {
    throw new Error("root_managed_field_invalid");
  }
  return normalized;
}
