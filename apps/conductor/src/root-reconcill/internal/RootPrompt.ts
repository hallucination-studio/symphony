import { createHash } from "node:crypto";

import {
  CYCLE_DRAFT_SECTION_NAMES,
  ROOT_DEFINITION_SECTION_NAMES,
} from "../../contracts/cycle.js";
import {
  CYCLE_IDENTITY_DERIVATION_VERSION,
  deriveCycleAnchorIds,
  deriveFirstCycleIssueId,
  FIRST_CYCLE_PREDECESSOR,
} from "../../contracts/cycle-identities.js";
import type { CorrelationId } from "../../contracts/identity.js";
import type { RuntimeTarget } from "../../contracts/runtime.js";
import type { RootReconcillInput } from "../api/RootReconcillInterface.js";

const MAX_ROOT_PROMPT_BYTES = 256 * 1024;
const CYCLE_ACCEPTANCE_MAPPING_SHAPE = [
  "## Acceptance Mapping",
  "",
  "### Execution Anchors",
  "- Cycle ID: `<current cycle id>`",
  "- Predecessor Cycle ID: None or `<predecessor cycle id>`",
  "- Predecessor Terminal Record ID: `<record id>`",
  "- Approval Record ID: `<record id>`",
  "- Plan Issue ID: `<issue id>`",
  "- Plan Completion Record ID: `<record id>`",
  "- Plan Invalidation Record ID: `<record id>`",
  "- Cycle Completion Record ID: `<record id>`",
  "- Cycle Invalidation Record ID: `<record id>`",
  "- Delivery Completion Record ID: `<record id>`",
  "- Delivery Invalidation Record ID: `<record id>`",
  "- Identity Derivation Version: `<version>`",
  "- Workspace Base Revision: `<revision>`",
  "",
  "### Execution Directives",
  "#### Directive: `<directive id>`",
  "Instruction paragraph.",
  "##### Dependencies",
  "- None or `<directive id>`",
  "##### Acceptance Criteria",
  "- `<acceptance criterion id>`",
  "",
  "### Approved Work Groups",
  "#### Work Group: `<work group id>`",
  "##### Directives",
  "- `<directive id>`",
  "##### Dependencies",
  "- None or `<work group id>`",
  "",
  "### Verification Directives",
  "#### Verification Directive: `<verification directive id>`",
  "Verification instruction paragraph.",
  "##### Acceptance Criteria",
  "- `<acceptance criterion id>`",
].join("\n");

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

function workspaceBaseRevision(input: RootReconcillInput): string {
  const headRevision = "git" in input
    ? input.git.head_revision
    : [...input.git_changes].reverse().find((change) => change.kind === "head_changed")?.after ?? null;
  return createHash("sha256")
    .update(headRevision ?? "unborn", "utf8")
    .digest("hex");
}

function firstCycleAnchorMarkdown(
  cycleId: string,
  anchorIds: ReturnType<typeof deriveCycleAnchorIds>,
  workspaceRevision: string,
): string {
  return [
    `- Cycle ID: \`${cycleId}\``,
    "- Predecessor Cycle ID: None",
    `- Predecessor Terminal Record ID: \`${FIRST_CYCLE_PREDECESSOR}\``,
    `- Approval Record ID: \`${anchorIds.approval_record_id}\``,
    `- Plan Issue ID: \`${anchorIds.plan_issue_id}\``,
    `- Plan Completion Record ID: \`${anchorIds.plan_completion_record_id}\``,
    `- Plan Invalidation Record ID: \`${anchorIds.plan_invalidation_record_id}\``,
    `- Cycle Completion Record ID: \`${anchorIds.cycle_completion_record_id}\``,
    `- Cycle Invalidation Record ID: \`${anchorIds.cycle_invalidation_record_id}\``,
    `- Delivery Completion Record ID: \`${anchorIds.delivery_completion_record_id}\``,
    `- Delivery Invalidation Record ID: \`${anchorIds.delivery_invalidation_record_id}\``,
    `- Identity Derivation Version: \`${CYCLE_IDENTITY_DERIVATION_VERSION}\``,
    `- Workspace Base Revision: \`${workspaceRevision}\``,
  ].join("\n");
}

export function rootReconcillOutputSchema(
  target: RuntimeTarget,
  correlationId: CorrelationId,
): Record<string, unknown> {
  const properties = Object.freeze({
    schema_version: { enum: [1] },
    root_id: { enum: [target.root_id] },
    runtime_generation: { enum: [target.runtime_generation] },
    correlation_id: { enum: [correlationId] },
    outcome: {
      enum: ["quiescent", "stopped"],
      description: "Use quiescent when no semantic effect is needed; use stopped only when safe progress is impossible.",
    },
    sanitized_reason: {
      description: "Set this to null exactly when outcome is quiescent; set a non-empty ASCII reason exactly when outcome is stopped.",
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
  inputKind: "bootstrap" | "diff" | "semantic_snapshot",
): string {
  const firstCycleIssueId = deriveFirstCycleIssueId(input.root_id);
  const firstCycleAnchorIds = deriveCycleAnchorIds(
    CYCLE_IDENTITY_DERIVATION_VERSION,
    firstCycleIssueId,
  );
  const currentWorkspaceBaseRevision = workspaceBaseRevision(input);
  const prompt = {
    role: "RootReconcill",
    instruction: [
      "Interpret the supplied fresh Root facts and remain the sole workflow semantic decision maker.",
      "Treat observation.routing.selected_route as a host-owned instruction: WF-ROUTE-001 means no non-terminal Cycle exists, so a complete Root requires exactly one create_issue call for the Cycle Draft in this turn; WF-ROUTE-002 means review or approve the one editable Draft; WF-ROUTE-007 means review the Awaiting Acceptance Cycle; WF-ROUTE-008 means validate the terminal predecessor before a successor. On WF-ROUTE-002, the first tool call is get_issue for observation.routing.active_cycle_id. On WF-ROUTE-007, the first tool call is also get_issue for that exact Cycle. On WF-ROUTE-008, the first tool call is get_issue for observation.routing.predecessor_cycle_id. Do not inspect code or return quiescent before that required read. Never return quiescent on WF-ROUTE-001 when the Root sections are complete and no Cycle exists.",
      "During Define with no non-terminal Cycle, inspect code read-only and write the complete intended outcome, authorized scope, required consequences, explicit exclusions, domain facts, and individually verifiable acceptance criteria into every closed Root section. Use the exact closed Root Markdown shape: at most one level-1 title followed by exactly four level-2 headings in order, with no other level-1 or level-2 heading, preamble, metadata, JSON, or code fence.",
      "First check whether the current fresh Root already satisfies the closed Root Markdown contract. If it is complete, treat it as authoritative: do not call code inspection and do not rewrite it; use its exact sections for the Cycle Draft.",
      "Inspect only the repository facts needed for the current Root sections; use a small targeted set of code-inspection calls and stop once those facts are sufficient. Do not exhaustively scan the repository.",
      "Root ADR decisions must include rationale, constraints and consequences that apply across Cycles.",
      "Create a Cycle only when the complete Root Markdown is present in current-turn fresh Task Manager facts; update an absent or incomplete Root first and wait for that update's applied fresh Task Manager read-back, but do not rewrite an already complete fresh Root. If Define updates the Root in this turn, finish quiescent after the applied read-back and wait for the next fresh Root observation before creating a Cycle; never create a Cycle from a Root document updated in the same turn.",
      "After an applied Root update, always return quiescent; do not return stopped merely because the next fresh observation is required. If an update returns conflict_observed, get_issue the exact Root, retry only with that fresh revision, then return quiescent after applied read-back. Return stopped only when no safe boundary action remains.",
      "A create_issue or update_issue result with outcome conflict_observed is not completion: immediately call get_issue for the exact result.target issue_id in this same turn, consume that read-back, and only then choose the next action. Never return quiescent or stopped while that conflict read-back is pending.",
      "Create one Cycle Draft by copying the complete fresh Root Requirement, Domain Knowledge, Root ADR, Acceptance, and exact Root revision, then specify concrete architecture, feature behavior, code changes, boundaries, criterion-by-criterion acceptance evidence, and failure handling without leaving decisions to Plan. The Cycle Draft's Requirement, Domain Knowledge, Root ADR, and Acceptance sections must be verbatim copies of the exact same sections from the current fresh Root read-back, including heading text and Markdown; take the four raw Markdown substrings beginning at the named headings and paste them unchanged; never paraphrase. Use the exact closed Cycle Draft Markdown shape: at most one level-1 title followed by exactly eleven level-2 headings in the declared order, with no other level-1 or level-2 heading, preamble, metadata, JSON, or code fence; the Root Definition Revision section is exactly one inline-code revision. Acceptance Mapping is executable Markdown, never a prose summary: it must contain exactly four level-3 sections in order, Execution Anchors, Execution Directives, Approved Work Groups, Verification Directives. Execution Anchors is one list of exactly the thirteen labeled inline-code facts in the declared order; Predecessor Cycle ID may be None. Each Execution Directive is a level-4 entry with an instruction paragraph, a level-5 Dependencies list, and a level-5 Acceptance Criteria inline-code list. Each Approved Work Group is a level-4 entry with level-5 Directives and Dependencies inline-code lists. Each Verification Directive is a level-4 entry with an instruction paragraph and a level-5 Acceptance Criteria inline-code list. Do not replace these headings or lists with prose or a copied Root Acceptance list.",
      "Before any create_issue or Draft correction, perform the Acceptance Mapping partition check explicitly: collect the exact IDs from all Execution Directive headings, then ensure every one appears exactly once across Approved Work Groups Directives lists, with no omitted, duplicated, or invented ID. Copy each ID byte-for-byte. If a directive dependency crosses groups, the dependent group must list the dependency group; when using two ordered groups, put the corresponding directive in exactly one group and make the later group depend on the earlier group.",
      "Use the exact markdown_contracts.cycle_acceptance_mapping_shape as a shape template for Acceptance Mapping, replacing every angle-bracket placeholder with the current fact or ID and never emitting a placeholder. For the first Cycle, paste cycle_identity_contract.first_cycle_anchor_markdown verbatim as the Execution Anchors list, then copy every derived record ID from cycle_identity_contract.first_cycle_anchor_ids and copy cycle_identity_contract.workspace_base_revision exactly; never invent or calculate a replacement ID or digest. Workspace Base Revision is a host-owned lowercase SHA-256 digest of the current Git head revision, never the raw commit revision.",
      "In any turn that corrects or approves a Draft, call get_issue for that exact Cycle in the same current turn and review the returned Markdown; after a correction, call get_issue again before approval.",
      "If the current fresh Draft already satisfies the closed Markdown contract and its copied Root sections match exactly, approve it directly; do not rewrite or improve a valid Draft. Update its description only for a concrete contract or design defect, then get_issue again before approval.",
      "During every Draft review, compare the four copied Root sections with the current Root issue. A child Issue creation can advance the parent provider time and revision without changing Root Markdown. If those four sections still match, approve the Draft directly using its saved Root Definition Revision; do not rewrite only the inline-code revision. If any copied Root section differs, rebuild the full Draft snapshot from the fresh Root facts and its current Root revision.",
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
      "For update_issue, the outer tool envelope carries schema_version, function, root_id, runtime_generation, correlation_id, capability, and input; the nested input object contains exactly issue_id, expected_revision, and desired. Task snapshots use description_markdown, status_id, and parent_issue_id; mutation desired uses description, state_id, and parent_id for those same values. Never copy snapshot keys into desired. Put exactly one of title, description, state_id, parent_id, label_ids, delegate_id, or priority inside desired; never repeat schema_version, function, root_id, runtime_generation, correlation_id, or capability inside input and never place a desired field beside desired.",
      "For create_issue, its input contains exactly issue_id, parent_issue_id, expected_parent_revision, and desired; issue_id must equal the host-provided cycle_identity_contract.first_cycle_issue_id when there is no existing Cycle (including WF-ROUTE-001), never a random UUID, never an issue name or placeholder. On WF-ROUTE-001, set both the call issue_id and the Acceptance Mapping Cycle ID to that exact value, set Predecessor Cycle ID to None, and set Predecessor Terminal Record ID to cycle_identity_contract.first_cycle_predecessor_terminal_record_id. Set Workspace Base Revision to cycle_identity_contract.workspace_base_revision exactly; it is a lowercase 64-hex SHA-256 digest of the current Git head revision, not the raw revision. For later successors, use the exact IDs derived from the fresh terminal predecessor facts. desired contains exactly title, description, state_id, label_ids, delegate_id, and priority. Use canonical names only: description, not description_markdown; state_id, not status_id. The six desired fields must all be inside desired, with no desired field beside desired. The quoted shape uses symbolic placeholders only; never emit ROOT, REVISION, TITLE, MARKDOWN, DRAFT_STATE, or CYCLE_LABEL literally; replace every placeholder with the exact current fact or schema value. Valid shape: {\"issue_id\":\"11111111-1111-4111-8111-111111111111\",\"parent_issue_id\":\"ROOT\",\"expected_parent_revision\":\"REVISION\",\"desired\":{\"title\":\"TITLE\",\"description\":\"MARKDOWN\",\"state_id\":\"DRAFT_STATE\",\"label_ids\":[\"CYCLE_LABEL\"],\"delegate_id\":null,\"priority\":null}}.",
      "For declared code inspection calls, use the flat schema exactly as shown by each tool; never add function or input wrappers.",
      "Code inspection path is a non-empty workspace-relative POSIX path; use . for the workspace root, and never use null, an empty path, . / segments, or an absolute path.",
      "Express workflow choices through exact generic tool calls, never through a lifecycle decision field.",
      "Finish with quiescent when waiting for a changed external observation, or stopped with a sanitized actionable reason when safe progress is impossible. The output contract is exact: sanitized_reason is null exactly when outcome is quiescent; use a non-empty ASCII sanitized_reason only when outcome is stopped.",
    ].join(" "),
    markdown_contracts: {
      root_description_sections: ROOT_DEFINITION_SECTION_NAMES,
      root_description_shape: "Use at most one level-1 title, then exactly these level-2 headings in order: ## Requirement, ## Domain Knowledge, ## Root ADR, ## Acceptance. Give every section visible non-empty content and do not add any other level-1 or level-2 heading, preamble, metadata, JSON, or code fence.",
      cycle_description_sections: CYCLE_DRAFT_SECTION_NAMES,
      cycle_description_shape: "Use at most one level-1 title, then exactly these level-2 headings in order: ## Root Definition Revision, ## Requirement, ## Domain Knowledge, ## Root ADR, ## Acceptance, ## Architecture, ## Feature Design, ## Code Design, ## Boundaries, ## Acceptance Mapping, ## Failure Strategy. Give every section visible non-empty content, except Root Definition Revision which contains exactly one inline-code revision, and do not add any other level-1 or level-2 heading, preamble, metadata, JSON, or code fence.",
      cycle_acceptance_mapping_shape: CYCLE_ACCEPTANCE_MAPPING_SHAPE,
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
          "Use exactly four level-3 sections in order: Execution Anchors, Execution Directives, Approved Work Groups, Verification Directives; do not write a prose summary or copy the Root Acceptance list here.",
          "Execution Anchors is one list of exactly thirteen labeled inline-code facts in the declared order; Predecessor Cycle ID may be None.",
          "Each Execution Directive has an instruction paragraph, a level-5 Dependencies inline-code list, and a level-5 Acceptance Criteria inline-code list.",
          "Each Approved Work Group has level-5 Directives and Dependencies inline-code lists; each Verification Directive has an instruction paragraph and a level-5 Acceptance Criteria inline-code list.",
          "Before mutation, every Execution Directive ID appears exactly once across Approved Work Groups Directives lists; no directive ID is omitted, duplicated, or invented, and cross-group directive dependencies are covered by group dependencies.",
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
      cycle_creation_mutation: {
        parent_issue_id: "exact Root identity",
        expected_parent_revision: "fresh Root revision after complete Markdown read-back",
        desired_state_id: "configured Cycle Draft state",
        desired_label_ids: "exactly the configured Cycle label",
        desired_delegate_id: null,
        desired_priority: null,
      },
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
    cycle_identity_contract: {
      derivation_version: CYCLE_IDENTITY_DERIVATION_VERSION,
      first_cycle_issue_id: firstCycleIssueId,
      first_cycle_predecessor_cycle_id: null,
      first_cycle_predecessor_terminal_record_id: FIRST_CYCLE_PREDECESSOR,
      first_cycle_anchor_ids: firstCycleAnchorIds,
      first_cycle_anchor_markdown: firstCycleAnchorMarkdown(
        firstCycleIssueId,
        firstCycleAnchorIds,
        currentWorkspaceBaseRevision,
      ),
      workspace_base_revision: currentWorkspaceBaseRevision,
    },
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
