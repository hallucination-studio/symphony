import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { deriveCycleUuid } from "../../contracts/cycle-identities.js";
import type { CycleAdvanceRequest } from "../../contracts/cycle.js";
import {
  parsePlanGraphManifest,
  type PlanGraphManifest,
  type SealedCycleBasis,
} from "../../contracts/cycle-records.js";
import { parseTaskIssueId, parseTaskRelationId } from "../../contracts/identity.js";
import { parseMarkdownText, type MarkdownText } from "../../contracts/validation.js";

interface BuildPlanGraphManifestInput {
  readonly basis: SealedCycleBasis;
  readonly ordered_work_group_ids: readonly string[];
  readonly plan_title: string;
  readonly plan_instruction_markdown: string;
}

export interface BuiltPlanGraphManifest {
  readonly manifest: PlanGraphManifest;
  readonly instructions_by_issue_id: Readonly<Record<string, MarkdownText>>;
}

const PERSISTED_PLAN_INSTRUCTION = parseMarkdownText(
  "## Plan\n\nCompile the approved Cycle into one sealed Work and Verify graph.",
  "invalid_plan_instruction",
);

export function assertExactPlanGraph(
  snapshot: CycleAdvanceRequest,
  built: BuiltPlanGraphManifest,
): void {
  const { manifest } = built;
  const plan = snapshot.plan_issue;
  const verify = snapshot.verify_issue;
  if (
    plan === null
    || plan.kind !== "plan"
    || parseTaskIssueId(plan.issue_id) !== manifest.plan_issue_id
    || parseTaskIssueId(plan.parent_cycle_id) !== manifest.cycle_id
    || plan.title !== manifest.plan.title
    || plan.description_markdown !== built.instructions_by_issue_id[manifest.plan_issue_id]
    || snapshot.sealed_work_issues.length !== manifest.ordered_work_nodes.length
    || verify === null
    || verify.kind !== "verify"
    || parseTaskIssueId(verify.issue_id) !== manifest.verify_issue_id
    || parseTaskIssueId(verify.parent_cycle_id) !== manifest.cycle_id
    || verify.title !== manifest.verify_node.title
    || verify.description_markdown !== built.instructions_by_issue_id[manifest.verify_issue_id]
    || snapshot.sealed_relations.length !== manifest.relations.length
  ) throw new Error("persisted_plan_graph_mismatch");

  const workById = new Map(snapshot.sealed_work_issues.map((stage) => [parseTaskIssueId(stage.issue_id), stage]));
  for (const node of manifest.ordered_work_nodes) {
    const stage = workById.get(node.issue_id);
    if (
      stage === undefined
      || stage.kind !== "work"
      || parseTaskIssueId(stage.parent_cycle_id) !== manifest.cycle_id
      || stage.title !== node.title
      || stage.description_markdown !== built.instructions_by_issue_id[node.issue_id]
    ) throw new Error("persisted_plan_graph_mismatch");
  }
  const relations = new Map(snapshot.sealed_relations.map((relation) => [relation.relation_id, relation]));
  for (const expected of manifest.relations) {
    const actual = relations.get(parseTaskRelationId(expected.relation_id));
    if (
      actual === undefined
      || parseTaskIssueId(actual.prerequisite_issue_id) !== expected.source_issue_id
      || parseTaskIssueId(actual.dependent_issue_id) !== expected.target_issue_id
    ) throw new Error("persisted_plan_graph_mismatch");
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function workInstruction(
  group: SealedCycleBasis["specification"]["approved_work_groups"][number],
  basis: SealedCycleBasis,
): MarkdownText {
  const directives = new Map(basis.specification.execution_directives.map((entry) => [entry.directive_id, entry]));
  const instruction = group.directive_ids.map((directiveId) => {
    const directive = directives.get(directiveId);
    if (directive === undefined) throw new Error("manifest_work_directive_missing");
    return directive.instruction_markdown;
  }).join("\n\n");
  const traceability = [
    `Approved group identity (base64url): \`${encoded(group.work_group_id)}\``,
    `Directive identities (base64url): ${group.directive_ids.map((identity) => `\`${encoded(identity)}\``).join(", ")}`,
    `Dependency group identities (base64url): ${group.depends_on_work_group_ids.length === 0
      ? "none"
      : group.depends_on_work_group_ids.map((identity) => `\`${encoded(identity)}\``).join(", ")}`,
  ].join("\n\n");
  return parseMarkdownText(
    `## Instruction\n\n${instruction}\n\n## Traceability\n\n${traceability}`,
    "invalid_work_instruction",
  );
}

function verifyInstruction(basis: SealedCycleBasis): MarkdownText {
  const instruction = basis.specification.verify_directives
    .map(({ instruction_markdown }) => instruction_markdown).join("\n\n");
  const identities = basis.specification.verify_directives
    .map(({ directive_id }) => `\`${encoded(directive_id)}\``).join(", ");
  return parseMarkdownText(
    `## Instruction\n\n${instruction}\n\n## Traceability\n\nVerify directive identities (base64url): ${identities}`,
    "invalid_verify_instruction",
  );
}

export function buildPlanGraphManifest(input: BuildPlanGraphManifestInput): BuiltPlanGraphManifest {
  const { specification } = input.basis;
  const version = specification.identity_derivation_version;
  const groups = new Map(specification.approved_work_groups.map((group) => [group.work_group_id, group]));
  if (
    input.ordered_work_group_ids.length !== groups.size
    || new Set(input.ordered_work_group_ids).size !== input.ordered_work_group_ids.length
    || input.ordered_work_group_ids.some((identity) => !groups.has(identity))
  ) throw new Error("plan_work_group_order_mismatch");

  const instructions: Record<string, MarkdownText> = {};
  const workNodes = input.ordered_work_group_ids.map((groupId, index) => {
    const group = groups.get(groupId);
    if (group === undefined) throw new Error("plan_work_group_order_mismatch");
    const issueId = parseTaskIssueId(deriveCycleUuid(version, "work_issue", specification.plan_issue_id, groupId));
    const instruction = workInstruction(group, input.basis);
    instructions[issueId] = instruction;
    return Object.freeze({
      kind: "work" as const,
      issue_id: issueId,
      parent_issue_id: specification.cycle_id,
      completion_record_id: deriveCycleUuid(version, "work_completion_record", issueId),
      invalidation_record_id: deriveCycleUuid(version, "work_invalidation_record", issueId),
      title: `Work ${index + 1}: ${groupId}`,
      instruction_digest: digest(instruction),
      approved_work_group_id: groupId,
      directive_ids: group.directive_ids,
    });
  });
  const workByGroup = new Map(workNodes.map((node) => [node.approved_work_group_id, node]));
  const verifyIssueId = parseTaskIssueId(deriveCycleUuid(version, "verify_issue", specification.plan_issue_id));
  const verifyMarkdown = verifyInstruction(input.basis);
  instructions[verifyIssueId] = verifyMarkdown;
  const verifyNode = Object.freeze({
    kind: "verify" as const,
    issue_id: verifyIssueId,
    parent_issue_id: specification.cycle_id,
    completion_record_id: deriveCycleUuid(version, "verify_completion_record", verifyIssueId),
    invalidation_record_id: deriveCycleUuid(version, "verify_invalidation_record", verifyIssueId),
    title: "Verify approved Cycle",
    instruction_digest: digest(verifyMarkdown),
    directive_ids: specification.verify_directives.map(({ directive_id }) => directive_id),
  });
  const relations: Record<string, unknown>[] = [];
  for (const group of specification.approved_work_groups) {
    const target = workByGroup.get(group.work_group_id);
    if (target === undefined) throw new Error("plan_work_group_order_mismatch");
    for (const dependencyId of group.depends_on_work_group_ids) {
      const source = workByGroup.get(dependencyId);
      if (source === undefined) throw new Error("plan_work_group_order_mismatch");
      relations.push(Object.freeze({
        relation_id: parseTaskRelationId(deriveCycleUuid(
          version, "work_dependency_relation", specification.plan_issue_id, dependencyId, group.work_group_id,
        )),
        relation_role: "work_dependency",
        type: "blocks",
        prerequisite_work_group_id: dependencyId,
        dependent_work_group_id: group.work_group_id,
        source_issue_id: source.issue_id,
        target_issue_id: target.issue_id,
      }));
    }
  }
  for (const group of specification.approved_work_groups) {
    const target = workByGroup.get(group.work_group_id);
    if (target === undefined) throw new Error("plan_work_group_order_mismatch");
    relations.push(Object.freeze({
      relation_id: parseTaskRelationId(deriveCycleUuid(
        version, "verify_barrier_relation", specification.plan_issue_id, group.work_group_id,
      )),
      relation_role: "verify_barrier",
      type: "blocks",
      prerequisite_work_group_id: group.work_group_id,
      source_issue_id: target.issue_id,
      target_issue_id: verifyIssueId,
    }));
  }
  const planInstruction = parseMarkdownText(input.plan_instruction_markdown, "invalid_plan_instruction");
  instructions[specification.plan_issue_id] = planInstruction;
  const manifest = parsePlanGraphManifest({
    cycle_id: specification.cycle_id,
    approval_record_id: input.basis.approval_record.record_id,
    specification_seal_digest: specification.specification_seal_digest,
    plan_issue_id: specification.plan_issue_id,
    plan: {
      kind: "plan",
      issue_id: specification.plan_issue_id,
      parent_issue_id: specification.cycle_id,
      completion_record_id: specification.plan_completion_record_id,
      invalidation_record_id: specification.plan_invalidation_record_id,
      title: input.plan_title,
      instruction_digest: digest(planInstruction),
    },
    ordered_work_nodes: workNodes,
    ordered_work_issue_ids: workNodes.map(({ issue_id }) => issue_id),
    verify_node: verifyNode,
    verify_issue_id: verifyIssueId,
    relations,
  }, input.basis);
  return Object.freeze({
    manifest,
    instructions_by_issue_id: Object.freeze(instructions),
  });
}

export function materializePersistedPlanGraphManifest(
  manifestValue: PlanGraphManifest,
  basis: SealedCycleBasis,
): BuiltPlanGraphManifest {
  const manifest = parsePlanGraphManifest(manifestValue, basis);
  const instructions: Record<string, MarkdownText> = {};
  if (digest(PERSISTED_PLAN_INSTRUCTION) !== manifest.plan.instruction_digest) {
    throw new Error("persisted_plan_instruction_mismatch");
  }
  instructions[manifest.plan.issue_id] = PERSISTED_PLAN_INSTRUCTION;

  const groups = new Map(
    basis.specification.approved_work_groups.map((group) => [group.work_group_id, group]),
  );
  for (const node of manifest.ordered_work_nodes) {
    const group = groups.get(node.approved_work_group_id);
    if (group === undefined) throw new Error("persisted_manifest_work_group_missing");
    const instruction = workInstruction(group, basis);
    if (digest(instruction) !== node.instruction_digest) {
      throw new Error("persisted_work_instruction_mismatch");
    }
    instructions[node.issue_id] = instruction;
  }

  const verifyInstructionMarkdown = verifyInstruction(basis);
  if (digest(verifyInstructionMarkdown) !== manifest.verify_node.instruction_digest) {
    throw new Error("persisted_verify_instruction_mismatch");
  }
  instructions[manifest.verify_issue_id] = verifyInstructionMarkdown;
  return Object.freeze({
    manifest,
    instructions_by_issue_id: Object.freeze(instructions),
  });
}
