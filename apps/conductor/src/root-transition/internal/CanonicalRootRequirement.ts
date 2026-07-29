import type { RootStateRequirement } from "../api/RootStateRequirement.js";

const OBJECTIVE = "# Objective";
const SCOPE = "## Requested Scope";
const CONSTRAINTS = "## Constraints";
const ACCEPTANCE = "## Acceptance Criteria";

export function renderCanonicalRootRequirement(requirement: RootStateRequirement): string {
  const sections = [OBJECTIVE, "", requirement.objective.trim(), "", SCOPE, "", requirement.requestedScope.trim()];
  if (requirement.constraints.length > 0) {
    sections.push("", CONSTRAINTS, "", ...requirement.constraints.map((value) => `- ${value.trim()}`));
  }
  sections.push("", ACCEPTANCE, "", ...requirement.acceptanceCriteria.map((value) => `- ${value.trim()}`));
  return sections.join("\n");
}

export function parseCanonicalRootRequirement(description: string): RootStateRequirement | undefined {
  const lines = description.split("\n");
  const objectiveAt = uniqueIndex(lines, OBJECTIVE);
  const scopeAt = uniqueIndex(lines, SCOPE);
  const constraintsAt = optionalUniqueIndex(lines, CONSTRAINTS);
  const acceptanceAt = uniqueIndex(lines, ACCEPTANCE);
  if (objectiveAt !== 0 || scopeAt <= objectiveAt || acceptanceAt <= scopeAt ||
      (constraintsAt !== undefined && (constraintsAt <= scopeAt || constraintsAt >= acceptanceAt))) return undefined;

  const objective = scalar(lines.slice(objectiveAt + 1, scopeAt));
  const scopeEnd = constraintsAt ?? acceptanceAt;
  const requestedScope = scalar(lines.slice(scopeAt + 1, scopeEnd));
  const constraints = constraintsAt === undefined
    ? []
    : list(lines.slice(constraintsAt + 1, acceptanceAt), true);
  const acceptanceCriteria = list(lines.slice(acceptanceAt + 1), false);
  if (!objective || !requestedScope || !constraints || !acceptanceCriteria || acceptanceCriteria.length === 0) {
    return undefined;
  }
  const requirement = { objective, requestedScope, constraints, acceptanceCriteria };
  return renderCanonicalRootRequirement(requirement) === description ? requirement : undefined;
}

export function isValidRootStateRequirement(requirement: RootStateRequirement): boolean {
  return requirement.objective.trim().length > 0 && requirement.requestedScope.trim().length > 0 &&
    requirement.acceptanceCriteria.length > 0 &&
    requirement.constraints.every((value) => value.trim().length > 0) &&
    requirement.acceptanceCriteria.every((value) => value.trim().length > 0) &&
    parseCanonicalRootRequirement(renderCanonicalRootRequirement(requirement)) !== undefined;
}

function scalar(lines: readonly string[]): string | undefined {
  if (lines.length < 3 || lines[0] !== "" || lines.at(-1) !== "") return undefined;
  const value = lines.slice(1, -1).join("\n");
  return value.trim() === value && value.length > 0 ? value : undefined;
}

function list(lines: readonly string[], trailingBlank: boolean): string[] | undefined {
  if (lines[0] !== "" || (trailingBlank && lines.at(-1) !== "")) return undefined;
  const values = lines.slice(1, trailingBlank ? -1 : undefined);
  if (values.length === 0 || values.some((line) => !line.startsWith("- ") || line.length <= 2)) return undefined;
  const parsed = values.map((line) => line.slice(2));
  return parsed.every((value) => value.trim() === value) ? parsed : undefined;
}

function uniqueIndex(lines: readonly string[], heading: string): number {
  const index = lines.indexOf(heading);
  return index >= 0 && lines.indexOf(heading, index + 1) < 0 ? index : -1;
}

function optionalUniqueIndex(lines: readonly string[], heading: string): number | undefined {
  const index = lines.indexOf(heading);
  if (index < 0) return undefined;
  return lines.indexOf(heading, index + 1) < 0 ? index : -1;
}
