import type { ThreadId } from "../../contracts/identity.js";
import type { CodexInboundMessage } from "./CodexProtocol.js";
import type { DynamicToolSpec } from "./CodexThread.js";

const MAX_TOOL_RESPONSE_BYTES = 3072;

export interface DynamicToolBinding {
  readonly spec: DynamicToolSpec;
  execute(argumentsValue: unknown): Promise<unknown>;
}

interface ToolProcess {
  onNotification(listener: (message: CodexInboundMessage) => void): () => void;
  respondToTool(requestId: string, success: boolean, text: string): Promise<void>;
}

function response(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text, "utf8") > MAX_TOOL_RESPONSE_BYTES) {
    throw new Error("codex_tool_response_invalid");
  }
  return text;
}

export function bindDynamicTools(
  process: ToolProcess,
  threadId: ThreadId,
  bindings: readonly DynamicToolBinding[],
): () => void {
  const byName = new Map(bindings.map((binding) => [binding.spec.name, binding]));
  if (byName.size !== bindings.length) throw new Error("duplicate_dynamic_tool");
  return process.onNotification((message) => {
    if (message.kind !== "tool_call" || message.thread_id !== threadId) return;
    const binding = byName.get(message.tool);
    if (!binding) {
      void process.respondToTool(message.request_id, false, "tool_not_authorized");
      return;
    }
    void binding.execute(message.arguments).then(
      (value) => process.respondToTool(message.request_id, true, response(value)),
      () => process.respondToTool(message.request_id, false, "tool_execution_failed"),
    ).catch(() => undefined);
  });
}
