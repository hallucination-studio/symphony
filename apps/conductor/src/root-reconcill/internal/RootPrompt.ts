import {
  CYCLE_DRAFT_SECTION_NAMES,
  ROOT_DEFINITION_SECTION_NAMES,
} from "../../contracts/cycle.js";
import type { CorrelationId } from "../../contracts/identity.js";
import type { RuntimeTarget } from "../../contracts/runtime.js";
import type { RootReconcillInput } from "../api/RootReconcillInterface.js";

const MAX_ROOT_PROMPT_BYTES = 256 * 1024;

function jsonStringFits(value: string, consume: (bytes: number) => boolean): boolean {
  if (!consume(2)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
      || code === 0x0a || code === 0x0c || code === 0x0d) {
      if (!consume(2)) return false;
    } else if (code <= 0x1f) {
      if (!consume(6)) return false;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        if (!consume(4)) return false;
      } else if (!consume(6)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      if (!consume(6)) return false;
    } else if (code <= 0x7f) {
      if (!consume(1)) return false;
    } else if (code <= 0x7ff) {
      if (!consume(2)) return false;
    } else if (!consume(3)) return false;
  }
  return true;
}

function jsonFitsByteBudget(value: unknown, maxBytes: number): boolean {
  let remaining = maxBytes;
  const consume = (bytes: number): boolean => {
    remaining -= bytes;
    return remaining >= 0;
  };
  const visit = (entry: unknown): boolean => {
    if (entry === null) return consume(4);
    if (typeof entry === "string") return jsonStringFits(entry, consume);
    if (typeof entry === "boolean") return consume(entry ? 4 : 5);
    if (typeof entry === "number" && Number.isFinite(entry)) return consume(String(entry).length);
    if (Array.isArray(entry)) {
      if (!consume(2)) return false;
      for (let index = 0; index < entry.length; index += 1) {
        if ((index > 0 && !consume(1)) || !visit(entry[index])) return false;
      }
      return true;
    }
    if (typeof entry !== "object" || entry === null) return false;
    if (!consume(2)) return false;
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (
        key === undefined
        || (index > 0 && !consume(1))
        || !jsonStringFits(key, consume)
        || !consume(1)
        || !visit(record[key])
      ) return false;
    }
    return true;
  };
  return Number.isSafeInteger(maxBytes) && maxBytes >= 0 && visit(value);
}

export function rootReconcillOutputSchema(
  target: RuntimeTarget,
  correlationId: CorrelationId,
): Record<string, unknown> {
  const properties = Object.freeze({
    schema_version: { const: 1 },
    root_id: { const: target.root_id },
    runtime_generation: { const: target.runtime_generation },
    correlation_id: { const: correlationId },
    outcome: { enum: ["quiescent", "stopped"] },
    sanitized_reason: {
      anyOf: [
        {
          type: "string",
          minLength: 1,
          maxLength: 256,
          pattern: "^[\\x20-\\x7E]+$",
        },
        { type: "null" },
      ],
    },
  });
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  });
}

export function rootReconcillPrompt(
  input: RootReconcillInput,
  inputKind: "bootstrap" | "diff",
): string {
  const prompt = {
    role: "RootReconcill",
    instruction: [
      "Interpret the supplied fresh Root facts and remain the sole workflow semantic decision maker.",
      "During Define with no non-terminal Cycle, inspect code read-only and write the complete intended outcome, authorized scope, required consequences, explicit exclusions, domain facts, and individually verifiable acceptance criteria into every closed Root section.",
      "Root ADR decisions must include rationale, constraints and consequences that apply across Cycles.",
      "Create a Cycle only when the complete Root Markdown is present in current-turn fresh Task Manager facts; update an absent or incomplete Root first and wait for that update's applied fresh Task Manager read-back, but do not rewrite an already complete fresh Root.",
      "Create one Cycle Draft by copying the complete fresh Root Requirement, Domain Knowledge, Root ADR, Acceptance, and exact Root revision, then specify concrete architecture, feature behavior, code changes, boundaries, criterion-by-criterion acceptance evidence, and failure handling without leaving decisions to Plan.",
      "In any turn that corrects or approves a Draft, call get_issue for that exact Cycle in the same current turn and review the returned Markdown; after a correction, call get_issue again before approval.",
      "While the Cycle is Draft, correct only its description using the expected revision returned by that current-turn fresh read-back.",
      "Approve only the exact Draft reviewed from the current-turn fresh read-back by changing its status to In Progress with that expected revision; approval is complete only when either the applied update fresh resource or the resolving exact get_issue is In Progress and seal_digest is non-null.",
      "When the Cycle is In Progress, remain quiescent without mutation because Conductor owns mechanical execution.",
      "When the Cycle is Awaiting Acceptance, call get_issue for that exact Cycle in the same current turn and use its acceptance_view as the sole authorization binding while declared read-only tools inspect the sealed Cycle, complete Verify evidence, exact diff, and exact verified revision.",
      "After that review, the only allowed mutation is changing that exact Awaiting Acceptance Cycle to Succeeded or Rejected with its current-turn expected revision; Succeeded requires the unchanged acceptance_view, and incomplete or conflicting evidence must never succeed.",
      "When the current Cycle is terminal and another attempt is required, first call get_issue for that exact terminal predecessor in the same current turn, then create one fresh successor Draft from current Root facts; never reuse or fork Performer context, Stage identity, graph, or turn from the predecessor.",
      "The transcript, prior-turn tool results, code-inspection output, search output, and temporary reasoning are ephemeral: they are never current facts for a later turn; re-read required Task Manager Markdown in that later turn.",
      "Use only declared generic tools, carrying the exact Root, generation, correlation, capability, target identity, and fresh revision from current facts.",
      "Call at most one tool at a time and observe every typed result before choosing another minimum next action.",
      "Treat stale_before_effect as fresh facts and reason again in this same turn without asking the host to retry.",
      "After conflict_observed, fresh-read that exact identity before any further mutation.",
      "Express workflow choices through exact generic tool calls, never through a lifecycle decision field.",
      "Finish with quiescent when waiting for a changed external observation, or stopped with a sanitized actionable reason when safe progress is impossible.",
    ].join(" "),
    markdown_contracts: {
      root_description_sections: ROOT_DEFINITION_SECTION_NAMES,
      cycle_description_sections: CYCLE_DRAFT_SECTION_NAMES,
      root_definition_revision_format: "one inline-code Task Manager revision and no other section content",
      root_section_requirements: {
        Requirement: [
          "State the complete intended outcome and user-visible behavior.",
          "State authorized scope, required consequences, out-of-scope behavior, and approval-blocking assumptions.",
        ],
        "Domain Knowledge": [
          "Record repository and domain facts needed across Cycles, with ephemeral investigation excluded.",
        ],
        "Root ADR": [
          "Record every Root-wide decision with its rationale, constraints, and consequences.",
        ],
        Acceptance: [
          "List individually verifiable criteria for the complete Root outcome.",
        ],
      },
      cycle_section_requirements: {
        "Root Definition Revision": [
          "Copy the exact revision from the fresh Root read-back used for this Draft.",
        ],
        Requirement: ["Copy the complete Root Requirement section without alteration."],
        "Domain Knowledge": ["Copy the complete Root Domain Knowledge section without alteration."],
        "Root ADR": ["Copy the complete Root ADR section without alteration."],
        Acceptance: ["Copy the complete Root Acceptance section without alteration."],
        Architecture: ["Specify concrete component ownership, boundaries, and interactions."],
        "Feature Design": ["Specify the complete behavior and edge cases of this attempt."],
        "Code Design": ["Specify concrete modules, contracts, state changes, and verification points."],
        Boundaries: ["State authorized changes, required consequences, and explicit exclusions."],
        "Acceptance Mapping": [
          "Map every Root acceptance criterion individually to implementation and verification evidence.",
        ],
        "Failure Strategy": [
          "Specify fail-closed behavior for stale, partial, conflicting, or unknown facts.",
        ],
      },
    },
    freshness_contract: {
      prior_turn_tool_results_are_current: false,
      current_turn_get_issue_required_before: ["Draft correction", "Draft approval"],
      approval_after_correction_requires_another_get_issue: true,
    },
    define_contract: {
      cycle_creation_requires: "complete Root Markdown in current-turn fresh Task Manager facts",
      root_update_required_when: "the current-turn fresh Root Markdown is absent or incomplete",
    },
    cycle_boundary_contract: {
      in_progress: "quiescent with no mutation; Conductor owns mechanical execution",
      awaiting_acceptance: {
        fresh_read_required: "get_issue for the exact Awaiting Acceptance Cycle in the current turn",
        allowed_transitions: ["Succeeded", "Rejected"],
        succeed_requires: "the returned acceptance view with complete evidence at one exact verified revision",
      },
      terminal_cycle: {
        fresh_read_required: "get_issue for one exact terminal predecessor in the current turn",
        allowed_action: "create one fresh successor Cycle Draft with no Performer context reuse or fork",
      },
    },
    input_kind: inputKind,
    observation: input,
  };
  if (!jsonFitsByteBudget(prompt, MAX_ROOT_PROMPT_BYTES)) {
    throw new Error("root_reconcill_input_too_large");
  }
  const encoded = JSON.stringify(prompt);
  if (Buffer.byteLength(encoded, "utf8") > MAX_ROOT_PROMPT_BYTES) {
    throw new Error("root_reconcill_input_too_large");
  }
  return encoded;
}
