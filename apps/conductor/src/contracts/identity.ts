const MAX_PROVIDER_ID_LENGTH = 256;

export type RootIssueId = string;
export type CycleIssueId = string;
export type ArtistIssueId = string;
export type CriticIssueId = string;
export type CommentId = string;

export const AGENT_KINDS = ["codex"] as const;
export type AgentKind = typeof AGENT_KINDS[number];

export const ISSUE_STATUSES = ["todo", "active", "completed", "canceled"] as const;
export type IssueStatus = typeof ISSUE_STATUSES[number];

export const CYCLE_RESULTS = ["succeeded", "rejected", "failed"] as const;
export type CycleResult = typeof CYCLE_RESULTS[number];

export const CRITIC_VERDICTS = [
  "accepted",
  "incomplete",
  "blocked",
  "violation",
  "process_error",
] as const;
export type CritiqueVerdict = typeof CRITIC_VERDICTS[number];

export function parseProviderId<T extends string>(value: unknown, name = "provider_id"): T {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_PROVIDER_ID_LENGTH
    || /[\r\n\0]/u.test(value)
  ) throw new Error(`invalid_${name}`);
  return value as T;
}

export const parseRootIssueId = (value: unknown): RootIssueId =>
  parseProviderId<RootIssueId>(value);
export const parseCycleIssueId = (value: unknown): CycleIssueId =>
  parseProviderId<CycleIssueId>(value);
export const parseArtistIssueId = (value: unknown): ArtistIssueId =>
  parseProviderId<ArtistIssueId>(value);
export const parseCriticIssueId = (value: unknown): CriticIssueId =>
  parseProviderId<CriticIssueId>(value);
export const parseCommentId = (value: unknown): CommentId =>
  parseProviderId<CommentId>(value);

export function parseAgentKind(value: unknown): AgentKind {
  return parseEnum(value, AGENT_KINDS);
}

export function parseIssueStatus(value: unknown): IssueStatus {
  return parseEnum(value, ISSUE_STATUSES);
}

export function parseCycleResult(value: unknown): CycleResult {
  return parseEnum(value, CYCLE_RESULTS);
}

export function parseCritiqueVerdict(value: unknown): CritiqueVerdict {
  return parseEnum(value, CRITIC_VERDICTS);
}

function parseEnum<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error("invalid_contract_variant");
  return value as T[number];
}
