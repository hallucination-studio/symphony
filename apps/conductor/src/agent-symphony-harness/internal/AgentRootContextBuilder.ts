import { createHash } from "node:crypto";

import type { JsonValue } from "@symphony/contracts";
import type { BoundedContextSection } from "../../linear-tree/internal/BoundedLinearTreeContextImpl.js";
import { BoundedLinearTreeContextImpl } from "../../linear-tree/internal/BoundedLinearTreeContextImpl.js";
import {
  agentCommandCatalog,
  agentCommandExamples,
} from "./AgentCommandRegistry.js";

interface GitContextSection {
  items: JsonValue[];
  cap: number;
  hasMore: boolean;
  includeErrors: Array<{ code: string; sanitized_reason: string }>;
}

export class AgentRootContextBuilder {
  constructor(private readonly linear: BoundedLinearTreeContextImpl) {}

  async build(input: { rootIssueId: string; git: GitContextSection }) {
    const linear = await this.linear.read(input.rootIssueId);
    const dto = {
      trusted_harness: {
        root_objective: "Advance the current Root using only fresh Linear and Git facts.",
        workflow_rules: "Treat Linear Issue Tree as workflow authority and use only executable commands below.",
        completion_rules: "Completion and delivery count only after command read-back confirms durable facts.",
        retry_rules: "After an unconfirmed write, read back the declared target before deciding whether to retry.",
      },
      human_context: {
        root: linear.root,
        tree: linear.tree,
        ancestors: linear.ancestors,
        comments: linear.comments,
        relations: linear.relations,
        git: boundGit(input.git),
      },
      executable_commands: {
        catalog: agentCommandCatalog(),
        examples: agentCommandExamples(),
        error_semantics: "Errors contain only code, sanitized_reason, retryable, bounded latest facts, and next_steps.",
      },
    };
    const json = stableJson(dto as unknown as JsonValue);
    const markdown = markdownFromDto(dto);
    return {
      dto,
      json,
      markdown,
      contextBytes: Buffer.byteLength(markdown, "utf8"),
      contextDigest: createHash("sha256").update(markdown, "utf8").digest("hex"),
    };
  }
}

function boundGit(section: GitContextSection): BoundedContextSection<JsonValue> {
  if (!Number.isSafeInteger(section.cap) || section.cap < 0 || section.items.length > section.cap) {
    throw new Error("git_context_cap_invalid");
  }
  if (section.includeErrors.length > 8) throw new Error("git_context_include_errors_exceeded");
  return {
    items: [...section.items],
    returned: section.items.length,
    cap: section.cap,
    has_more: section.hasMore,
    partial: section.hasMore || section.includeErrors.length > 0,
    include_errors: section.includeErrors.map((error) => ({ ...error })),
  };
}

function markdownFromDto(dto: object): string {
  const value = dto as Record<string, JsonValue>;
  return Object.entries(value)
    .map(([name, section]) => `## ${name}\n\n\`\`\`json\n${stableJson(section)}\n\`\`\``)
    .join("\n\n");
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
