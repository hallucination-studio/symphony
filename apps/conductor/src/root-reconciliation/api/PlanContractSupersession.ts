import { createHash } from "node:crypto";

export function planContractSupersessionId(input: {
  rootIssueId: string;
  cycleIssueId: string;
  rootDirectiveId: string;
  supersededPlanContractDigest: string;
}): string {
  return createHash("sha256")
    .update([
      "plan_contract_supersession",
      input.rootIssueId,
      input.cycleIssueId,
      input.rootDirectiveId,
      input.supersededPlanContractDigest,
    ].join("\0"), "utf8")
    .digest("hex");
}
