import type {
  RootStateTerminalSuccessorIntent,
} from "../api/RootStateTerminalSuccessorCompilerInterface.js";

const OBJECTIVE = "# Successor Objective";
const OUTCOMES = "## Required Outcomes";
const CONSTRAINTS = "## Preserved Constraints";

export function renderCanonicalTerminalSuccessor(
  intent: RootStateTerminalSuccessorIntent["intent"],
): string | undefined {
  if (!canonicalScalar(intent.successorObjective) || intent.requiredOutcomes.length === 0 ||
      !canonicalList(intent.requiredOutcomes) || !canonicalList(intent.preservedConstraints)) return undefined;
  const rendered = [
    OBJECTIVE, "", intent.successorObjective, "", OUTCOMES, "",
    ...intent.requiredOutcomes.map((value) => `- ${value}`), "", CONSTRAINTS, "",
    ...intent.preservedConstraints.map((value) => `- ${value}`),
  ].join("\n");
  return isCanonicalTerminalSuccessor(rendered) ? rendered : undefined;
}

export function isCanonicalTerminalSuccessor(description: string): boolean {
  const lines = description.split("\n");
  const objectiveAt = uniqueIndex(lines, OBJECTIVE);
  const outcomesAt = uniqueIndex(lines, OUTCOMES);
  const constraintsAt = uniqueIndex(lines, CONSTRAINTS);
  if (objectiveAt !== 0 || outcomesAt <= objectiveAt || constraintsAt <= outcomesAt) return false;
  const objective = scalar(lines.slice(objectiveAt + 1, outcomesAt));
  const outcomes = list(lines.slice(outcomesAt + 1, constraintsAt), true);
  const constraints = list(lines.slice(constraintsAt + 1), false, true);
  return objective !== undefined && outcomes !== undefined && outcomes.length > 0 && constraints !== undefined;
}

function scalar(lines: readonly string[]): string | undefined {
  if (lines.length < 3 || lines[0] !== "" || lines.at(-1) !== "") return undefined;
  const value = lines.slice(1, -1).join("\n");
  return canonicalScalar(value) ? value : undefined;
}

function list(lines: readonly string[], trailingBlank: boolean, allowEmpty = false): string[] | undefined {
  if (lines[0] !== "" || trailingBlank && lines.at(-1) !== "") return undefined;
  const values = lines.slice(1, trailingBlank ? -1 : undefined);
  if (values.length === 0) return allowEmpty ? [] : undefined;
  if (values.some((line) => !line.startsWith("- ") || line.length <= 2)) return undefined;
  const parsed = values.map((line) => line.slice(2));
  return canonicalList(parsed) ? parsed : undefined;
}

function canonicalScalar(value: string): boolean {
  return value.trim() === value && value.length > 0 &&
    !value.split("\n").some((line) => line === OBJECTIVE || line === OUTCOMES || line === CONSTRAINTS);
}

function canonicalList(values: readonly string[]): boolean {
  return new Set(values).size === values.length &&
    values.every((value) => value.trim() === value && value.length > 0 && !value.includes("\n"));
}

function uniqueIndex(lines: readonly string[], heading: string): number {
  const index = lines.indexOf(heading);
  return index >= 0 && lines.indexOf(heading, index + 1) < 0 ? index : -1;
}
