import type { JsonValue } from "@symphony/contracts";

import type { RootConversationLifecycle } from "./RootConversationLifecycle.js";

export class RootRetryBlockCommandHandler {
  constructor(private readonly conversations: RootConversationLifecycle) {}

  async handle(value: JsonValue): Promise<JsonValue> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("root_retry_acknowledgement_invalid");
    }
    const body = value as Record<string, JsonValue>;
    if (body.kind !== "acknowledge_root_retry_block"
      || typeof body.root_issue_id !== "string"
      || typeof body.retry_observed_at !== "string"
      || Object.keys(body).some((key) => ![
        "kind", "root_issue_id", "retry_observed_at",
      ].includes(key))) {
      throw new Error("root_retry_acknowledgement_invalid");
    }
    const result = await this.conversations.acknowledge(
      body.root_issue_id,
      body.retry_observed_at,
    );
    if (result.kind !== "acknowledged") {
      throw new Error(result.reason);
    }
    return {
      kind: "root_retry_block_acknowledged",
      root_issue_id: body.root_issue_id,
      retry_observed_at: body.retry_observed_at,
    };
  }
}
