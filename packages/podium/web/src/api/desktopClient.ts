import { invoke } from "@tauri-apps/api/core";

export interface DesktopLifecycleSnapshot {
  status: "starting" | "ready" | "degraded" | "failed" | "stopping" | "stopped";
  installation_status: string;
  error_code: string | null;
  sanitized_reason: string | null;
  action_required: boolean;
  retryable: boolean;
  next_action: string;
}

export class DesktopCommandError extends Error {
  constructor(
    public readonly code: string,
    public readonly sanitizedReason: string,
    public readonly actionRequired: boolean,
    public readonly retryable: boolean,
    public readonly nextAction: string,
  ) {
    super(sanitizedReason);
    this.name = "DesktopCommandError";
  }
}

type Invoke = typeof invoke;

export function createDesktopClient(invokeCommand: Invoke) {
  return {
    async lifecycleSnapshot(): Promise<DesktopLifecycleSnapshot> {
      let response: unknown;
      try {
        response = await invokeCommand("podium_command", {
          request: { command: "lifecycle.snapshot", input: {} },
        });
      } catch {
      throw new DesktopCommandError(
        "desktop_command_transport_failed", "command_transport_failed",
        true, false, "restart_desktop",
        );
      }
      return parseLifecycleResponse(response);
    },
  };
}

export const desktopClient = createDesktopClient(invoke);

function parseLifecycleResponse(value: unknown): DesktopLifecycleSnapshot {
  const response = exactObject(value, [
    "kind", "request_id", "protocol_version", "command", "ok",
    ...successOrErrorFields(value),
  ]);
  if (
    response.kind !== "command.result"
    || !identifier(response.request_id, 200)
    || response.protocol_version !== 1
    || response.command !== "lifecycle.snapshot"
    || typeof response.ok !== "boolean"
  ) throw invalidResponse();
  if (!response.ok) throw commandFailure(response.error);
  return lifecycleSnapshot(response.output);
}

function successOrErrorFields(value: unknown): string[] {
  if (!isObject(value) || typeof value.ok !== "boolean") throw invalidResponse();
  return value.ok ? ["output"] : ["error"];
}

function lifecycleSnapshot(value: unknown): DesktopLifecycleSnapshot {
  const result = exactObject(value, [
    "status", "installation_status", "error_code", "sanitized_reason",
    "action_required", "retryable", "next_action",
  ]);
  const statuses = ["starting", "ready", "degraded", "failed", "stopping", "stopped"];
  if (
    typeof result.status !== "string" || !statuses.includes(result.status)
    || !safeCode(result.installation_status, 128)
    || !nullableCode(result.error_code, 128)
    || !nullableCode(result.sanitized_reason, 500)
    || typeof result.action_required !== "boolean"
    || typeof result.retryable !== "boolean"
    || !safeCode(result.next_action, 128)
  ) throw invalidResponse();
  return result as unknown as DesktopLifecycleSnapshot;
}

function commandFailure(value: unknown): DesktopCommandError {
  const error = exactObject(value, [
    "code", "sanitized_reason", "action_required", "retryable", "next_action",
  ]);
  if (
    !safeCode(error.code, 128)
    || !safeCode(error.sanitized_reason, 500)
    || typeof error.action_required !== "boolean"
    || typeof error.retryable !== "boolean"
    || !safeCode(error.next_action, 128)
  ) throw invalidResponse();
  return new DesktopCommandError(
    error.code, error.sanitized_reason,
    error.action_required, error.retryable, error.next_action,
  );
}

function exactObject(value: unknown, fields: string[]): Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).length !== fields.length) throw invalidResponse();
  if (fields.some((field) => !(field in value))) throw invalidResponse();
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableCode(value: unknown, limit: number): boolean {
  return value === null || safeCode(value, limit);
}

function safeCode(value: unknown, limit: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= limit
    && /^[a-z][a-z0-9_]*$/.test(value);
}

function identifier(value: unknown, limit: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= limit
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function invalidResponse(): DesktopCommandError {
  return new DesktopCommandError(
    "desktop_command_response_invalid", "command_response_invalid",
    true, false, "restart_desktop",
  );
}
