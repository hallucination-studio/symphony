import { createHash } from "node:crypto";

export interface FindingSetIdentityInput {
  cycle: { issueId: string; remoteVersion: string };
  verify: { issueId: string; remoteVersion: string };
  findings: Array<{ issueId: string; remoteVersion: string; status: string }>;
  relations: Array<{ relationKind: string; sourceIssueId: string; targetIssueId: string }>;
}

export function findingSetIdentityDigest(input: FindingSetIdentityInput): string {
  const normalized = {
    cycle: input.cycle,
    verify: input.verify,
    findings: [...input.findings].sort((left, right) => compareCodePoints(left.issueId, right.issueId)),
    relations: [...input.relations].sort((left, right) => compareCodePoints(relationKey(left), relationKey(right))),
  };
  return createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
}

function relationKey(value: FindingSetIdentityInput["relations"][number]): string {
  return `${value.relationKind}\0${value.sourceIssueId}\0${value.targetIssueId}`;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
