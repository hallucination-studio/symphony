import type { RootStateRecoverySuccessorAttemptIntent } from "../api/RootStateRecoverySuccessorAttemptIntent.js";

const GOAL = "# Recovery Goal";
const SOURCE = "## Recovery Source";
const EVIDENCE = "## Success Evidence";

type InterruptedSuccessorRole = "plan" | "work" | "verify";

export function renderCanonicalInterruptedSuccessor(
  role: InterruptedSuccessorRole,
  intent: RootStateRecoverySuccessorAttemptIntent["intent"],
): string | undefined {
  if (!canonicalScalar(intent.attemptGoal) || intent.successEvidenceRequirements.length === 0 ||
      !canonicalList(intent.successEvidenceRequirements)) return undefined;
  const rendered = [
    GOAL, "", intent.attemptGoal, "", SOURCE, "", recoverySource(role), "",
    EVIDENCE, "", ...intent.successEvidenceRequirements.map((value) => `- ${value}`),
  ].join("\n");
  return rendered.length <= 16_384 && isCanonicalInterruptedSuccessor(rendered, role)
    ? rendered
    : undefined;
}

export function isCanonicalInterruptedSuccessor(
  description: string,
  role: InterruptedSuccessorRole,
): boolean {
  const lines = description.split("\n");
  const goalAt = uniqueIndex(lines, GOAL);
  const sourceAt = uniqueIndex(lines, SOURCE);
  const evidenceAt = uniqueIndex(lines, EVIDENCE);
  if (goalAt !== 0 || sourceAt <= goalAt || evidenceAt <= sourceAt) return false;
  const goal = scalar(lines.slice(goalAt + 1, sourceAt));
  const source = scalar(lines.slice(sourceAt + 1, evidenceAt));
  const evidence = list(lines.slice(evidenceAt + 1));
  return goal !== undefined && source === recoverySource(role) &&
    evidence !== undefined && evidence.length > 0;
}

function recoverySource(role: InterruptedSuccessorRole): string {
  return role === "plan"
    ? "The predecessor Plan attempt was interrupted."
    : `The predecessor Cycle contains an interrupted ${role} attempt.`;
}

function scalar(lines: readonly string[]): string | undefined {
  if (lines.length < 3 || lines[0] !== "" || lines.at(-1) !== "") return undefined;
  const value = lines.slice(1, -1).join("\n");
  return canonicalScalar(value) ? value : undefined;
}

function list(lines: readonly string[]): string[] | undefined {
  if (lines[0] !== "") return undefined;
  const values = lines.slice(1);
  if (values.length === 0 || values.some((line) => !line.startsWith("- ") || line.length <= 2)) return undefined;
  const parsed = values.map((line) => line.slice(2));
  return canonicalList(parsed) ? parsed : undefined;
}

function canonicalScalar(value: string): boolean {
  return value.trim() === value && value.length > 0 &&
    !value.split("\n").some((line) => line === GOAL || line === SOURCE || line === EVIDENCE);
}

function canonicalList(values: readonly string[]): boolean {
  return new Set(values).size === values.length &&
    values.every((value) => value.trim() === value && value.length > 0 && !value.includes("\n"));
}

function uniqueIndex(lines: readonly string[], heading: string): number {
  const index = lines.indexOf(heading);
  return index >= 0 && lines.indexOf(heading, index + 1) < 0 ? index : -1;
}
