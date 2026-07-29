import { createHash } from "node:crypto";

import type { FindingProposal } from "../api/StageContracts.js";

const CATEGORIES = new Set<FindingProposal["category"]>(["product", "code", "test", "infra", "requirement", "policy"]);
const SEVERITIES = new Set<FindingProposal["severity"]>(["critical", "high", "medium", "low"]);
const SOURCE_KINDS = new Set<FindingProposal["evidenceRefs"][number]["sourceKind"]>([
  "linear_issue", "linear_comment", "git", "check", "result",
]);

export const VERIFY_FINDING_CONVERGENCE_HEADING = "## Finding Convergence";

export function renderVerifyFindingIntent(findings: FindingProposal[]): string[] {
  const lines = [VERIFY_FINDING_CONVERGENCE_HEADING];
  findings.forEach((finding, index) => {
    lines.push(
      "",
      `### Finding ${index + 1}`,
      `Category: ${finding.category}`,
      `Severity: ${finding.severity}`,
      `Statement: ${oneLine(finding.description)}`,
      ...finding.evidenceRefs.map(({ sourceKind, referenceId }) => `Evidence: ${sourceKind} ${referenceId}`),
      ...finding.relatedWorkIssueIds.map((issueId) => `Related Work Issue: ${issueId}`),
    );
  });
  return lines;
}

export function parseVerifyFindingIntent(description: string): FindingProposal[] {
  const lines = description.split("\n");
  const start = lines.indexOf(VERIFY_FINDING_CONVERGENCE_HEADING);
  if (start < 0) throw new Error("verify_finding_intent_missing");
  const blocks: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (/^### Finding [1-9][0-9]*$/u.test(line)) {
      blocks.push([]);
      continue;
    }
    if (line && blocks.length > 0) blocks.at(-1)!.push(line);
  }
  if (blocks.length === 0 || blocks.length > 128) throw new Error("verify_finding_intent_count_invalid");
  return blocks.map((block, index) => parseBlock(block, index));
}

function parseBlock(block: string[], index: number): FindingProposal {
  const category = singleValue(block, "Category: ");
  const severity = singleValue(block, "Severity: ");
  const description = singleValue(block, "Statement: ");
  if (!CATEGORIES.has(category as FindingProposal["category"]) ||
      !SEVERITIES.has(severity as FindingProposal["severity"]) || !description) {
    throw new Error("verify_finding_intent_value_invalid");
  }
  const evidenceRefs = values(block, "Evidence: ").map((value) => {
    const separator = value.indexOf(" ");
    const sourceKind = separator < 0 ? "" : value.slice(0, separator);
    const referenceId = separator < 0 ? "" : value.slice(separator + 1);
    if (!SOURCE_KINDS.has(sourceKind as FindingProposal["evidenceRefs"][number]["sourceKind"]) || !identifier(referenceId)) {
      throw new Error("verify_finding_intent_evidence_invalid");
    }
    return { sourceKind, referenceId } as FindingProposal["evidenceRefs"][number];
  });
  const relatedWorkIssueIds = values(block, "Related Work Issue: ");
  if (relatedWorkIssueIds.some((value) => !identifier(value)) || new Set(relatedWorkIssueIds).size !== relatedWorkIssueIds.length) {
    throw new Error("verify_finding_intent_related_work_invalid");
  }
  const digest = createHash("sha256").update(JSON.stringify({ category, severity, description, evidenceRefs, relatedWorkIssueIds })).digest("hex");
  return {
    findingId: `recovered-${index + 1}-${digest.slice(0, 32)}`,
    category: category as FindingProposal["category"],
    severity: severity as FindingProposal["severity"],
    description,
    evidenceRefs,
    relatedWorkIssueIds,
  };
}

function singleValue(lines: string[], prefix: string): string {
  const matches = values(lines, prefix);
  if (matches.length !== 1) throw new Error("verify_finding_intent_field_invalid");
  return matches[0]!;
}

function values(lines: string[], prefix: string): string[] {
  return lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length));
}

function oneLine(value: string): string {
  return value.replace(/[\p{Cc}\s]+/gu, " ").replace(/`/gu, "'").trim();
}

function identifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}
