export type TerminalStageRecoveryTrigger = "stage_blocked" | "stage_failed" | "stage_inconclusive";

export function classifyTerminalStageRecovery(input: {
  role: "plan" | "work" | "verify";
  status: string;
  description: string;
  labels: string[];
}): TerminalStageRecoveryTrigger | undefined {
  const outcome = canonicalOutcomeLine(input.description);
  if (input.role === "plan" && input.status === "Failed") {
    return outcome === "Plan Blocked." || outcome === "Plan Needs Information." ? "stage_blocked" : undefined;
  }
  if (input.role === "work" && input.status === "Failed") {
    if (["Work Blocked.", "Work Permission Required.", "Work Information Required."].includes(outcome ?? "")) {
      return "stage_blocked";
    }
    if (["Work Plan Assumption Invalid.", "Work Scope Conflict."].includes(outcome ?? "")) return "stage_failed";
    return undefined;
  }
  if (input.role === "verify" && input.status === "Failed" && outcome === "Verify Blocked.") return "stage_blocked";
  if (input.role === "verify" && input.status === "Done" && outcome === "Verify Inconclusive." &&
      input.labels.includes("Inconclusive")) return "stage_inconclusive";
  if (input.role === "verify" && input.status === "Done" && outcome === "Verify Plan Contract Violation." &&
      input.labels.includes("Contract Violation")) return "stage_failed";
  return undefined;
}

function canonicalOutcomeLine(description: string): string | undefined {
  const lines = description.split("\n");
  const headings = lines.flatMap((line, index) => line === "## Outcome" ? [index] : []);
  if (headings.length !== 1) return undefined;
  const value = lines[headings[0]! + 1];
  return value && value.trim() === value && value.length <= 128 ? value : undefined;
}
