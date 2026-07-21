import type { FindingDispositionRecord, FindingRecord } from "../api/ManagedRecords.js";

export interface FindingSummary {
  findingId: string;
  category: FindingRecord["category"];
  severity: FindingRecord["severity"];
  summary: string;
}
export interface FindingProposal { category: FindingRecord["category"]; severity: FindingRecord["severity"]; summary: string; }
export interface FindingDispositionProposal { findingId: string; disposition: "resolved" | "still_open" | "waived" | "rejected"; }
export interface FindingPolicyInput {
  sourceVerifyId: string;
  artifactRevision: string;
  priorOpenFindings: FindingSummary[];
  newFindings: FindingProposal[];
  dispositions: FindingDispositionProposal[];
}
export interface AcceptedFindingPolicyResult { newFindings: FindingRecord[]; dispositions: FindingDispositionRecord[]; }

export function acceptVerifyFindings(input: FindingPolicyInput): AcceptedFindingPolicyResult {
  const priorIds = new Set(input.priorOpenFindings.map((finding) => finding.findingId));
  if (priorIds.size !== input.priorOpenFindings.length) throw new Error("finding_prior_duplicate");
  const seen = new Set<string>();
  for (const disposition of input.dispositions) {
    if (!priorIds.has(disposition.findingId)) throw new Error("finding_disposition_unknown");
    if (seen.has(disposition.findingId)) throw new Error("finding_disposition_duplicate");
    seen.add(disposition.findingId);
  }
  for (const finding of input.priorOpenFindings) if (!seen.has(finding.findingId)) throw new Error("finding_disposition_missing");
  const newFindings = input.newFindings.map((proposal, index): FindingRecord => ({
    kind: "finding", version: 1, findingId: `finding:${input.sourceVerifyId}:${index + 1}`, sourceVerifyId: input.sourceVerifyId,
    category: proposal.category, severity: proposal.severity,
    evidence: [{ evidenceId: `evidence:${input.sourceVerifyId}:${index + 1}`, sourceKind: "log", sourceId: input.sourceVerifyId, summary: proposal.summary, artifactRevision: input.artifactRevision }],
    affectedScope: [], retryable: true, suggestedRemediation: [proposal.summary], acceptanceCriteria: [],
  }));
  const dispositions = input.dispositions.map((proposal): FindingDispositionRecord => ({
    kind: "finding_disposition", version: 1, findingId: proposal.findingId, sourceVerifyId: input.sourceVerifyId,
    disposition: proposal.disposition === "rejected" ? "waived" : proposal.disposition,
    evidence: [{ evidenceId: `disposition-evidence:${input.sourceVerifyId}:${proposal.findingId}`, sourceKind: "log", sourceId: input.sourceVerifyId, summary: `Verify disposition: ${proposal.disposition}.`, artifactRevision: input.artifactRevision }],
  }));
  return { newFindings, dispositions };
}

export function openFindingSummaries(findings: FindingRecord[], dispositions: FindingDispositionRecord[]): FindingSummary[] {
  const latest = new Map<string, FindingDispositionRecord>();
  for (const disposition of dispositions) latest.set(disposition.findingId, disposition);
  return findings.filter((finding) => !latest.has(finding.findingId) || latest.get(finding.findingId)?.disposition === "still_open")
    .map((finding) => ({ findingId: finding.findingId, category: finding.category, severity: finding.severity, summary: finding.evidence[0]?.summary ?? "Open finding." }));
}
