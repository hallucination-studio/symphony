import {
  parseAgentKind,
  type AgentKind,
} from "./identity.js";
import {
  asRecord,
  freezeObject,
  parseAbsolutePath,
  parseBoundedString,
  parseEnum,
  parseMarkdownText,
  parseNonNegativeInteger,
  parseOptional,
  parsePositiveInteger,
  type MarkdownText,
} from "./validation.js";

export const PERFORMER_SANDBOXES = ["no_workspace", "read_only", "workspace_write"] as const;
export type PerformerSandbox = typeof PERFORMER_SANDBOXES[number];

export const PERFORMER_LAUNCH_STATUSES = [
  "exited",
  "timed_out",
  "start_failed",
  "interrupted",
] as const;
export type PerformerLaunchStatus = typeof PERFORMER_LAUNCH_STATUSES[number];

export interface PerformerLaunchRequest {
  readonly agent: AgentKind;
  readonly model?: string;
  readonly reasoning_effort?: string;
  readonly prompt: MarkdownText;
  readonly working_directory: string;
  readonly sandbox: PerformerSandbox;
  readonly final_response_path?: string | undefined;
  readonly diagnostic_jsonl_path?: string | undefined;
  readonly diagnostic_stderr_path?: string | undefined;
  readonly timeout_ms: number;
}

/** Provider-reported cumulative token counts for one Agent invocation. */
export interface PerformerTokenUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly cached_input_tokens?: number | undefined;
  readonly cache_write_input_tokens?: number | undefined;
  readonly reasoning_output_tokens?: number | undefined;
}

export interface PerformerProcessResult {
  readonly launch_status: PerformerLaunchStatus;
  readonly exit_code?: number | undefined;
  readonly duration_ms: number;
  readonly final_response_ref?: string | undefined;
  readonly diagnostic_jsonl_ref?: string | undefined;
  readonly diagnostic_stderr_ref?: string | undefined;
  readonly thread_id?: string | undefined;
  readonly token_usage?: PerformerTokenUsage | undefined;
  readonly sanitized_reason?: string | undefined;
}

function optionalPath(value: unknown, code: string): string | undefined {
  return parseOptional(value, (entry) => parseAbsolutePath(entry, code));
}

function optionalReason(value: unknown): string | undefined {
  return parseOptional(value, (entry) => parseBoundedString(entry, "invalid_sanitized_reason", 256));
}

function parseTokenUsageCounter(value: unknown, code: string): number {
  return parseNonNegativeInteger(value, code);
}

export function parsePerformerTokenUsage(value: unknown): PerformerTokenUsage {
  const record = asRecord(value, "invalid_token_usage");
  assertAllowedKeys(record, ["input_tokens", "output_tokens", "total_tokens"], [
    "cached_input_tokens",
    "cache_write_input_tokens",
    "reasoning_output_tokens",
  ]);
  const inputTokens = parseTokenUsageCounter(record.input_tokens, "invalid_input_tokens");
  const outputTokens = parseTokenUsageCounter(record.output_tokens, "invalid_output_tokens");
  const totalTokens = parseTokenUsageCounter(record.total_tokens, "invalid_total_tokens");
  if (inputTokens > Number.MAX_SAFE_INTEGER - outputTokens || totalTokens !== inputTokens + outputTokens) {
    throw new Error("invalid_total_tokens");
  }
  const cachedInputTokens = parseOptional(
    record.cached_input_tokens,
    (entry) => parseTokenUsageCounter(entry, "invalid_cached_input_tokens"),
  );
  const cacheWriteInputTokens = parseOptional(
    record.cache_write_input_tokens,
    (entry) => parseTokenUsageCounter(entry, "invalid_cache_write_input_tokens"),
  );
  const reasoningOutputTokens = parseOptional(
    record.reasoning_output_tokens,
    (entry) => parseTokenUsageCounter(entry, "invalid_reasoning_output_tokens"),
  );
  return freezeObject({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    ...(cachedInputTokens === undefined ? {} : { cached_input_tokens: cachedInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cache_write_input_tokens: cacheWriteInputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoning_output_tokens: reasoningOutputTokens }),
  });
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key))) throw new Error("invalid_contract_keys");
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error("invalid_contract_keys");
}

export function parsePerformerLaunchRequest(value: unknown): PerformerLaunchRequest {
  const record = asRecord(value, "invalid_performer_launch_request");
  assertAllowedKeys(
    record,
    ["agent", "prompt", "working_directory", "sandbox", "timeout_ms"],
    [
      "model",
      "reasoning_effort",
      "final_response_path",
      "diagnostic_jsonl_path",
      "diagnostic_stderr_path",
    ],
  );
  const finalResponsePath = optionalPath(record.final_response_path, "invalid_final_response_path");
  const diagnosticJsonlPath = optionalPath(record.diagnostic_jsonl_path, "invalid_diagnostic_jsonl_path");
  const diagnosticStderrPath = optionalPath(record.diagnostic_stderr_path, "invalid_diagnostic_stderr_path");
  const model = parseOptional(record.model, (entry) => parseBoundedString(entry, "invalid_model", 256));
  const reasoningEffort = parseOptional(
    record.reasoning_effort,
    (entry) => parseBoundedString(entry, "invalid_reasoning_effort", 64),
  );
  const parsed = {
    agent: parseAgentKind(record.agent),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    prompt: parseMarkdownText(record.prompt, "invalid_performer_prompt"),
    working_directory: parseAbsolutePath(record.working_directory, "invalid_working_directory"),
    sandbox: parseEnum(record.sandbox, PERFORMER_SANDBOXES),
    timeout_ms: parsePositiveInteger(record.timeout_ms, "invalid_timeout_ms"),
    ...(finalResponsePath === undefined ? {} : { final_response_path: finalResponsePath }),
    ...(diagnosticJsonlPath === undefined ? {} : { diagnostic_jsonl_path: diagnosticJsonlPath }),
    ...(diagnosticStderrPath === undefined ? {} : { diagnostic_stderr_path: diagnosticStderrPath }),
  };
  return freezeObject(parsed);
}

export function parsePerformerProcessResult(value: unknown): PerformerProcessResult {
  const record = asRecord(value, "invalid_performer_process_result");
  assertAllowedKeys(record, ["launch_status", "duration_ms"], [
    "exit_code",
    "final_response_ref",
    "diagnostic_jsonl_ref",
    "diagnostic_stderr_ref",
    "thread_id",
    "token_usage",
    "sanitized_reason",
  ]);
  const launchStatus = parseEnum(record.launch_status, PERFORMER_LAUNCH_STATUSES);
  const exitCode = parseOptional(record.exit_code, (entry) => {
    if (!Number.isSafeInteger(entry) || (entry as number) < 0 || (entry as number) > 255) {
      throw new Error("invalid_exit_code");
    }
    return entry as number;
  });
  if (exitCode !== undefined && launchStatus !== "exited") throw new Error("exit_code_status_mismatch");
  const finalResponseRef = optionalPath(record.final_response_ref, "invalid_final_response_ref");
  const diagnosticJsonlRef = optionalPath(record.diagnostic_jsonl_ref, "invalid_diagnostic_jsonl_ref");
  const diagnosticStderrRef = optionalPath(record.diagnostic_stderr_ref, "invalid_diagnostic_stderr_ref");
  const threadId = parseOptional(record.thread_id, (entry) => parseBoundedString(entry, "invalid_thread_id", 256));
  const tokenUsage = parseOptional(record.token_usage, parsePerformerTokenUsage);
  const sanitizedReason = optionalReason(record.sanitized_reason);
  const parsed = {
    launch_status: launchStatus,
    duration_ms: (() => {
      if (!Number.isSafeInteger(record.duration_ms) || (record.duration_ms as number) < 0) {
        throw new Error("invalid_duration_ms");
      }
      return record.duration_ms as number;
    })(),
    ...(exitCode === undefined ? {} : { exit_code: exitCode }),
    ...(finalResponseRef === undefined ? {} : { final_response_ref: finalResponseRef }),
    ...(diagnosticJsonlRef === undefined ? {} : { diagnostic_jsonl_ref: diagnosticJsonlRef }),
    ...(diagnosticStderrRef === undefined ? {} : { diagnostic_stderr_ref: diagnosticStderrRef }),
    ...(threadId === undefined ? {} : { thread_id: threadId }),
    ...(tokenUsage === undefined ? {} : { token_usage: tokenUsage }),
    ...(sanitizedReason === undefined ? {} : { sanitized_reason: sanitizedReason }),
  };
  return freezeObject(parsed);
}
