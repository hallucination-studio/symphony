import assert from "node:assert/strict";
import test from "node:test";

import {
  rootReconcillOutputSchema,
  rootReconcillPrompt,
} from "./RootPrompt.js";
import {
  parseCorrelationId,
  parseRootIssueId,
  parseRuntimeGeneration,
} from "../../contracts/identity.js";
import type { RootReconcillInput } from "../api/RootReconcillInterface.js";

const target = Object.freeze({
  root_id: parseRootIssueId("ROOT-A"),
  runtime_generation: parseRuntimeGeneration(4),
});
const correlationId = parseCorrelationId("corr:root:4");

test("Root prompt declares the closed Define, Draft review, and seal workflow", () => {
  const observation = Object.freeze({ fresh: "Task Manager facts" }) as unknown as RootReconcillInput;
  const prompt = JSON.parse(rootReconcillPrompt(observation, "bootstrap")) as {
    readonly input_kind?: unknown;
    readonly observation?: unknown;
    readonly markdown_contracts?: {
      readonly root_description_sections?: unknown;
      readonly cycle_description_sections?: unknown;
      readonly root_definition_revision_format?: unknown;
      readonly root_section_requirements?: unknown;
      readonly cycle_section_requirements?: unknown;
      readonly root_description_shape?: unknown;
      readonly cycle_description_shape?: unknown;
    };
    readonly freshness_contract?: unknown;
    readonly define_contract?: unknown;
    readonly cycle_boundary_contract?: unknown;
    readonly instruction?: unknown;
  };

  assert.equal(prompt.input_kind, "bootstrap");
  assert.deepEqual(prompt.observation, observation);
  assert.deepEqual(prompt.markdown_contracts?.root_description_sections, [
    "Requirement",
    "Domain Knowledge",
    "Root ADR",
    "Acceptance",
  ]);
  assert.deepEqual(prompt.markdown_contracts?.cycle_description_sections, [
    "Root Definition Revision",
    "Requirement",
    "Domain Knowledge",
    "Root ADR",
    "Acceptance",
    "Architecture",
    "Feature Design",
    "Code Design",
    "Boundaries",
    "Acceptance Mapping",
    "Failure Strategy",
  ]);
  assert.equal(
    prompt.markdown_contracts?.root_definition_revision_format,
    "one inline-code Task Manager revision and no other section content",
  );
  assert.deepEqual(prompt.markdown_contracts?.root_section_requirements, {
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
  });
  assert.deepEqual(prompt.markdown_contracts?.cycle_section_requirements, {
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
    "Failure Strategy": ["Specify fail-closed behavior for stale, partial, conflicting, or unknown facts."],
  });
  assert.equal(
    prompt.markdown_contracts?.root_description_shape,
    "Use at most one level-1 title, then exactly these level-2 headings in order: ## Requirement, ## Domain Knowledge, ## Root ADR, ## Acceptance. Give every section visible non-empty content and do not add any other level-1 or level-2 heading, preamble, metadata, JSON, or code fence.",
  );
  assert.equal(
    prompt.markdown_contracts?.cycle_description_shape,
    "Use at most one level-1 title, then exactly these level-2 headings in order: ## Root Definition Revision, ## Requirement, ## Domain Knowledge, ## Root ADR, ## Acceptance, ## Architecture, ## Feature Design, ## Code Design, ## Boundaries, ## Acceptance Mapping, ## Failure Strategy. Give every section visible non-empty content, except Root Definition Revision which contains exactly one inline-code revision, and do not add any other level-1 or level-2 heading, preamble, metadata, JSON, or code fence.",
  );
  assert.deepEqual(prompt.freshness_contract, {
    prior_turn_tool_results_are_current: false,
    current_turn_get_issue_required_before: ["Draft correction", "Draft approval"],
    approval_after_correction_requires_another_get_issue: true,
  });
  assert.deepEqual(prompt.define_contract, {
    cycle_creation_requires: "complete Root Markdown in current-turn fresh Task Manager facts",
    root_update_required_when: "the current-turn fresh Root Markdown is absent or incomplete",
    cycle_creation_mutation: {
      parent_issue_id: "exact Root identity",
      expected_parent_revision: "fresh Root revision after complete Markdown read-back",
      desired_state_id: "configured Cycle Draft state",
      desired_label_ids: "exactly the configured Cycle label",
      desired_delegate_id: null,
      desired_priority: null,
    },
  });
  assert.deepEqual(prompt.cycle_boundary_contract, {
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
  });

  const instruction = String(prompt.instruction);
  for (const required of [
    "fresh Task Manager read-back",
    "finish quiescent after the applied read-back",
    "same current turn",
    "transcript",
    "code-inspection output",
    "Draft",
    "expected revision",
    "seal_digest",
    "In Progress",
    "criterion-by-criterion",
    "constraints and consequences",
    "resolving exact get_issue",
    "In Progress, remain quiescent without mutation",
    "Awaiting Acceptance",
    "acceptance_view",
    "exact verified revision",
    "Succeeded or Rejected",
    "terminal predecessor",
    "fresh successor Draft",
    "never reuse or fork Performer context",
    "nested input object contains exactly issue_id, expected_revision, and desired",
    "fresh UUIDv4",
    "never an issue name or placeholder",
    "desired contains exactly title, description, state_id, label_ids, delegate_id, and priority",
    "The six desired fields must all be inside desired",
    "with no desired field beside desired",
    "Valid shape",
    "verbatim copies of the exact same sections from the current fresh Root read-back",
    "take the four raw Markdown substrings beginning at the named headings and paste them unchanged",
    "never repeat schema_version, function, root_id, runtime_generation, correlation_id, or capability inside input",
    "For declared code inspection calls, use the flat schema exactly as shown by each tool",
    "never add function or input",
    "sanitized_reason is null exactly when outcome is quiescent",
  ]) assert.equal(instruction.includes(required), true, required);
  for (const forbidden of ["call Plan", "call Work", "call Verify", "create_commit"]) {
    assert.equal(instruction.includes(forbidden), false, forbidden);
  }
});

test("Root output schema remains a closed semantic-turn outcome", () => {
  const schema = rootReconcillOutputSchema(target, correlationId) as {
    readonly additionalProperties?: unknown;
    readonly properties?: Record<string, { readonly enum?: unknown }>;
    readonly required?: readonly string[];
  };

  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties?.schema_version?.enum, [1]);
  assert.deepEqual(schema.properties?.root_id?.enum, [target.root_id]);
  assert.deepEqual(schema.properties?.runtime_generation?.enum, [target.runtime_generation]);
  assert.deepEqual(schema.properties?.correlation_id?.enum, [correlationId]);
  assert.deepEqual(schema.properties?.outcome?.enum, ["quiescent", "stopped"]);
  assert.deepEqual(schema.required, [
    "schema_version",
    "root_id",
    "runtime_generation",
    "correlation_id",
    "outcome",
    "sanitized_reason",
  ]);
  assert.equal(JSON.stringify(schema).includes('"const"'), false);
});
