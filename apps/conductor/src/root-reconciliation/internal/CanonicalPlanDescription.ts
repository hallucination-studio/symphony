import type {
  PlanContractProposal,
  ProposedWorkDag,
} from "../api/StageContracts.js";

export interface CanonicalPlanDocument {
  summary: string;
  planContract: PlanContractProposal;
  proposedWorkDag: ProposedWorkDag;
  risks: string[];
  requiredPermissions: string[];
}

export function renderCanonicalPlanDescription(document: CanonicalPlanDocument): string {
  const lines = ["# Plan Result", ""];
  scalar(lines, "Summary", document.summary);
  lines.push("## Plan Contract", "");
  scalar(lines, "Objective", document.planContract.objective);
  stringList(lines, "Included Scope", document.planContract.includedScope);
  stringList(lines, "Excluded Scope", document.planContract.excludedScope);
  stringList(lines, "Assumptions", document.planContract.assumptions);
  stringList(lines, "Constraints", document.planContract.constraints);
  criteria(lines, "Acceptance Criteria", document.planContract.acceptanceCriteria);
  stringList(lines, "Verification Requirements", document.planContract.verificationRequirements);

  lines.push("## Work Proposals", `Items: ${document.proposedWorkDag.workNodes.length}`, "");
  document.proposedWorkDag.workNodes.forEach((node, index) => {
    lines.push(`### Work ${index + 1}`, "");
    scalar(lines, "Proposal Key", node.proposalKey);
    scalar(lines, "Title", node.title);
    scalar(lines, "Description", node.description);
    scalar(lines, "Expected Outcome", node.expectedOutcome);
    stringList(lines, "Required Checks", node.requiredChecks, 4);
    stringList(lines, "Dependency Proposal Keys", node.dependencyProposalKeys, 4);
  });

  lines.push("## Verify Proposal", "");
  scalar(lines, "Title", document.proposedWorkDag.verifyNode.title);
  criteria(lines, "Acceptance Criteria", document.proposedWorkDag.verifyNode.acceptanceCriteria, 3);
  stringList(lines, "Required Checks", document.proposedWorkDag.verifyNode.requiredChecks, 3);
  stringList(lines, "Risks", document.risks);
  stringList(lines, "Required Permissions", document.requiredPermissions);
  return lines.join("\n");
}

export function parseCanonicalPlanDescription(description: string): CanonicalPlanDocument {
  const parser = new Parser(description);
  parser.expect("# Plan Result");
  parser.blank();
  const summary = parser.scalar("Summary");
  parser.expect("## Plan Contract");
  parser.blank();
  const objective = parser.scalar("Objective");
  const includedScope = parser.stringList("Included Scope");
  const excludedScope = parser.stringList("Excluded Scope");
  const assumptions = parser.stringList("Assumptions");
  const constraints = parser.stringList("Constraints");
  const acceptanceCriteria = parser.criteria("Acceptance Criteria");
  const verificationRequirements = parser.stringList("Verification Requirements");

  parser.expect("## Work Proposals");
  const workCount = parser.count();
  parser.blank();
  const workNodes: ProposedWorkDag["workNodes"] = [];
  for (let index = 0; index < workCount; index += 1) {
    parser.expect(`### Work ${index + 1}`);
    parser.blank();
    workNodes.push({
      proposalKey: parser.scalar("Proposal Key"),
      title: parser.scalar("Title"),
      description: parser.scalar("Description"),
      expectedOutcome: parser.scalar("Expected Outcome"),
      requiredChecks: parser.stringList("Required Checks", 4),
      dependencyProposalKeys: parser.stringList("Dependency Proposal Keys", 4),
    });
  }

  parser.expect("## Verify Proposal");
  parser.blank();
  const verifyTitle = parser.scalar("Title");
  const verifyCriteria = parser.criteria("Acceptance Criteria", 3);
  const verifyChecks = parser.stringList("Required Checks", 3);
  const risks = parser.stringList("Risks");
  const requiredPermissions = parser.stringList("Required Permissions");
  parser.done();
  return {
    summary,
    planContract: {
      objective, includedScope, excludedScope, assumptions, constraints,
      acceptanceCriteria, verificationRequirements,
    },
    proposedWorkDag: {
      workNodes, dependencyEdges: [],
      verifyNode: { title: verifyTitle, acceptanceCriteria: verifyCriteria, requiredChecks: verifyChecks },
    },
    risks,
    requiredPermissions,
  };
}

function scalar(lines: string[], label: string, value: string): void {
  const fence = "`".repeat(Math.max(3, longestRun(value, "`") + 1));
  lines.push(`${label}:`, `${fence}text`, ...value.split("\n"), fence, "");
}

function stringList(lines: string[], heading: string, values: string[], level = 3): void {
  lines.push(`${"#".repeat(level)} ${heading}`, `Items: ${values.length}`, "");
  values.forEach((value, index) => {
    scalar(lines, `Item ${index + 1}`, value);
  });
}

function criteria(
  lines: string[],
  heading: string,
  values: PlanContractProposal["acceptanceCriteria"],
  level = 3,
): void {
  lines.push(`${"#".repeat(level)} ${heading}`, `Items: ${values.length}`, "");
  values.forEach((criterion, index) => {
    lines.push(`${"#".repeat(level + 1)} Criterion ${index + 1}`, "");
    scalar(lines, "Key", criterion.criterionKey);
    scalar(lines, "Statement", criterion.statement);
    scalar(lines, "Verification Method", criterion.verificationMethod);
  });
}

function longestRun(value: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const point of value) {
    current = point === character ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

class Parser {
  private readonly lines: string[];
  private offset = 0;

  constructor(description: string) {
    this.lines = description.split("\n");
  }

  expect(value: string): void {
    if (this.lines[this.offset] !== value) throw new Error("plan_description_structure_invalid");
    this.offset += 1;
  }

  blank(): void {
    this.expect("");
  }

  count(): number {
    const match = /^Items: (0|[1-9][0-9]*)$/u.exec(this.lines[this.offset] ?? "");
    if (!match) throw new Error("plan_description_structure_invalid");
    this.offset += 1;
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value > 512) throw new Error("plan_description_count_invalid");
    return value;
  }

  scalar(label: string): string {
    this.expect(`${label}:`);
    const opening = this.lines[this.offset] ?? "";
    const match = /^(`{3,})text$/u.exec(opening);
    if (!match) throw new Error("plan_description_structure_invalid");
    this.offset += 1;
    const fence = match[1]!;
    const values: string[] = [];
    while (this.offset < this.lines.length && this.lines[this.offset] !== fence) {
      values.push(this.lines[this.offset++]!);
    }
    this.expect(fence);
    this.blank();
    return values.join("\n");
  }

  stringList(heading: string, level = 3): string[] {
    this.expect(`${"#".repeat(level)} ${heading}`);
    const count = this.count();
    this.blank();
    return Array.from({ length: count }, (_, index) => this.scalar(`Item ${index + 1}`));
  }

  criteria(heading: string, level = 3): PlanContractProposal["acceptanceCriteria"] {
    this.expect(`${"#".repeat(level)} ${heading}`);
    const count = this.count();
    this.blank();
    return Array.from({ length: count }, (_, index) => {
      this.expect(`${"#".repeat(level + 1)} Criterion ${index + 1}`);
      this.blank();
      return {
        criterionKey: this.scalar("Key"),
        statement: this.scalar("Statement"),
        verificationMethod: this.scalar("Verification Method"),
      };
    });
  }

  done(): void {
    if (this.offset !== this.lines.length) throw new Error("plan_description_trailing_content");
  }
}
