import type { BoundaryErrorCode } from "../contracts/common-outcomes.js";

// Covers one fresh issue plus the eight mechanically bounded concrete changes.
export const MAX_ROOT_TOOL_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface RootToolSpec {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface RootToolExecution {
  assertActive(): void;
}

export interface RootToolBinding {
  readonly spec: RootToolSpec;
  execute(argumentsValue: unknown, execution: RootToolExecution): Promise<unknown>;
}

export class RootToolCallError extends Error {
  constructor(readonly code: BoundaryErrorCode) {
    super(code);
    this.name = "RootToolCallError";
  }
}

export class RootToolFatalError extends Error {
  constructor(readonly code: "boundary_unavailable" | "invalid_contract") {
    super(code);
    this.name = "RootToolFatalError";
  }
}
