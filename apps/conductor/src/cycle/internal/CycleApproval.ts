import { createHash } from "node:crypto";

import { parseCycleDesignMarkdown } from "../../contracts/cycle-design-markdown.js";
import {
  deriveCycleAnchorIds,
  deriveCycleUuid,
  FIRST_CYCLE_PREDECESSOR,
} from "../../contracts/cycle-identities.js";
import {
  parseCycleSpecification,
  type CycleSpecification,
} from "../../contracts/cycle-records.js";
import { parseCycleDraftMarkdown, type RootDefinition } from "../../contracts/cycle.js";
import {
  parseRootIssueId,
  parseTaskIssueId,
  type RootIssueId,
  type TaskIssueId,
  type TaskRevision,
} from "../../contracts/identity.js";
import { canonicalTaskRevision } from "../../contracts/task-management.js";

interface CycleApprovalInput {
  readonly root_id: RootIssueId;
  readonly cycle_id: TaskIssueId;
  readonly cycle_revision: TaskRevision;
  readonly cycle_status: "Draft";
  readonly cycle_description_markdown: string;
  readonly root_definition: RootDefinition;
}

export interface PreparedCycleApproval {
  readonly specification: CycleSpecification;
  readonly projection: Readonly<Record<string, unknown>>;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function seal(value: unknown): string {
  return canonicalTaskRevision(value).slice("symphony:v1:".length);
}

export function prepareCycleApproval(input: CycleApprovalInput): PreparedCycleApproval {
  const rootId = parseRootIssueId(input.root_id);
  const cycleId = parseTaskIssueId(input.cycle_id);
  const design = parseCycleDesignMarkdown(input.cycle_description_markdown);
  const draft = parseCycleDraftMarkdown(input.cycle_description_markdown);
  const { anchors } = design;
  if (
    anchors.cycle_id !== cycleId
    || input.root_definition.root_id !== rootId
    || input.root_definition.root_revision !== draft.root_definition_revision
  ) throw new Error("cycle_approval_basis_mismatch");
  const version = anchors.identity_derivation_version;
  const expectedCycleId = deriveCycleUuid(
    version,
    "cycle_issue",
    rootId,
    anchors.predecessor_cycle_issue_id ?? FIRST_CYCLE_PREDECESSOR,
    anchors.predecessor_terminal_record_id,
  );
  if (cycleId !== expectedCycleId) throw new Error("cycle_identity_derivation_mismatch");
  const expectedAnchors = deriveCycleAnchorIds(version, cycleId);
  if (Object.entries(expectedAnchors).some(([key, value]) => anchors[key as keyof typeof expectedAnchors] !== value)) {
    throw new Error("cycle_anchor_derivation_mismatch");
  }
  const unsealed = parseCycleSpecification({
    cycle_id: cycleId,
    root_id: rootId,
    predecessor_cycle_issue_id: anchors.predecessor_cycle_issue_id,
    predecessor_terminal_record_id: anchors.predecessor_terminal_record_id,
    ...expectedAnchors,
    identity_derivation_version: version,
    workspace_base_revision: anchors.workspace_base_revision,
    root_definition_revision: input.root_definition.root_revision,
    cycle_specification_markdown: input.cycle_description_markdown,
    root_adr_markdown: input.root_definition.root_adr_markdown,
    execution_directives: design.execution_directives,
    approved_work_groups: design.approved_work_groups,
    verify_directives: design.verify_directives,
    specification_seal_digest: null,
  });
  const specification = parseCycleSpecification({
    ...unsealed,
    specification_seal_digest: seal(unsealed),
  });
  const approvalAnchors = {
    plan_issue_id: expectedAnchors.plan_issue_id,
    plan_completion_record_id: expectedAnchors.plan_completion_record_id,
    plan_invalidation_record_id: expectedAnchors.plan_invalidation_record_id,
    cycle_completion_record_id: expectedAnchors.cycle_completion_record_id,
    cycle_invalidation_record_id: expectedAnchors.cycle_invalidation_record_id,
    delivery_completion_record_id: expectedAnchors.delivery_completion_record_id,
    delivery_invalidation_record_id: expectedAnchors.delivery_invalidation_record_id,
  };
  return Object.freeze({
    specification,
    projection: Object.freeze({
      issue_id: cycleId,
      cycle_id: cycleId,
      basis_issue_revision: input.cycle_revision,
      basis_status: input.cycle_status,
      basis_document_digest: digest(input.cycle_description_markdown),
      record_kind: "cycle_approval",
      identity_derivation_version: version,
      predecessor_cycle_issue_id: anchors.predecessor_cycle_issue_id,
      predecessor_terminal_record_id: anchors.predecessor_terminal_record_id,
      ...approvalAnchors,
      specification_seal_digest: specification.specification_seal_digest,
      workspace_base_revision: specification.workspace_base_revision,
    }),
  });
}
