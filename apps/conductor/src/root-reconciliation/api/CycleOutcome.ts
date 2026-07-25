import { createHash } from "node:crypto";

export function cycleOutcomeId(input: {
  rootIssueId: string;
  cycleIssueId: string;
  rootDirectiveId: string;
}): string {
  return createHash("sha256")
    .update([
      "cycle_outcome",
      input.rootIssueId,
      input.cycleIssueId,
      input.rootDirectiveId,
    ].join("\0"), "utf8")
    .digest("hex");
}
