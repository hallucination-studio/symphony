import type { CanonicalFact, CanonicalFactInput, CanonicalFactValue, CanonicalObservation } from "../api/CanonicalFact.js";
import type { CanonicalObservationDiffPolicyInterface } from "../api/CanonicalObservationDiffPolicyInterface.js";
import type { CanonicalObservationPolicyInterface } from "../api/CanonicalObservationPolicyInterface.js";
import type {
  RootStateFactReadResult,
  RootStateRecoveryFailure,
  RootStateRecoveryInterface,
  RootStateRecoveryResult,
  RootStateRecoverySourceInterface,
} from "../api/RootStateRecoveryInterface.js";
import { CanonicalObservationDiffPolicyImpl } from "./CanonicalObservationDiffPolicyImpl.js";
import { CanonicalObservationPolicyImpl } from "./CanonicalObservationPolicyImpl.js";

type LinearIssueValue = Extract<CanonicalFactValue, { kind: "linear_issue" }>;
type LinearStatusValue = Extract<CanonicalFactValue, { kind: "linear_status" }>;
type LinearIssueFact = CanonicalFact & { value: LinearIssueValue };
type LinearStatusFact = CanonicalFact & { value: LinearStatusValue };
type LinearIssueKind = NonNullable<LinearIssueValue["issueKind"]>;

export class RootStateRecoveryImpl implements RootStateRecoveryInterface {
  constructor(
    private readonly source: RootStateRecoverySourceInterface,
    private readonly canonicalPolicy: CanonicalObservationPolicyInterface = new CanonicalObservationPolicyImpl(),
    private readonly diffPolicy: CanonicalObservationDiffPolicyInterface = new CanonicalObservationDiffPolicyImpl(canonicalPolicy),
  ) {}

  async recover(rootIssueId: string): Promise<RootStateRecoveryResult> {
    if (rootIssueId.length === 0) return failed("root_issue_id_invalid", "schema", false);

    const linear = await this.read("linear", rootIssueId);
    if (linear.kind === "failed") return linear;
    const git = await this.read("git", rootIssueId);
    if (git.kind === "failed") return git;

    if (linear.facts.some(({ value }) => value.kind === "git_worktree")) {
      return failed("root_linear_fact_kind_invalid", "schema", false);
    }
    if (git.facts.some(({ value }) => value.kind !== "git_worktree")) {
      return failed("root_git_fact_kind_invalid", "schema", false);
    }
    if (git.facts.length === 0) return failed("root_git_authority_missing", "git", false);
    if (git.facts.length !== 1) return failed("root_git_authority_ambiguous", "git", false);
    const gitValue = git.facts[0]!.value;
    if (gitValue.kind !== "git_worktree" || !validGitFact(gitValue, rootIssueId)) {
      return failed("root_git_authority_invalid", "git", false);
    }

    let observation: CanonicalObservation;
    try {
      observation = this.canonicalPolicy.canonicalize([...linear.facts, ...git.facts]);
    } catch {
      return failed("root_canonicalization_failed", "schema", false);
    }
    const graphFailure = validateGraph(observation, rootIssueId);
    if (graphFailure !== undefined) return failed(graphFailure, "schema", false);

    const sealed = this.diffPolicy.seal(observation);
    return {
      kind: "recovered",
      state: deepFreeze({
        rootIssueId,
        contentDigest: sealed.contentDigest,
        observation: sealed.observation,
      }),
    };
  }

  private async read(kind: "linear" | "git", rootIssueId: string): Promise<
    | { kind: "complete"; facts: readonly CanonicalFactInput[] }
    | { kind: "failed"; failure: RootStateRecoveryFailure }
  > {
    let result: RootStateFactReadResult;
    try {
      result = kind === "linear"
        ? await this.source.readLinearRootFacts(rootIssueId)
        : await this.source.readGitRootFacts(rootIssueId);
    } catch {
      return failed(`root_${kind}_read_failed`, "transport", true);
    }
    if (result.kind === "failed") return result;
    if (result.kind === "incomplete") {
      return failed(`root_${kind}_coverage_incomplete`, "coverage", true);
    }
    return result;
  }
}

function validateGraph(observation: CanonicalObservation, rootIssueId: string): string | undefined {
  const issues = observation.facts.filter(isIssueFact);
  const statuses = observation.facts.filter(isStatusFact);
  const issueById = new Map(issues.map((fact) => [fact.value.issueId, fact]));
  const statusById = new Map(statuses.map((fact) => [fact.value.statusId, fact]));
  if (statuses.length === 0 || new Set(statuses.map(({ value }) => value.name)).size !== statuses.length) {
    return "root_graph_status_catalog_invalid";
  }
  const roots = issues.filter(({ value }) => value.issueKind === "root");
  if (roots.length !== 1 || roots[0]?.value.issueId !== rootIssueId) return "root_graph_root_invalid";

  const root = roots[0].value;
  if (root.parentIssueId !== undefined || root.depth !== 0) return `root_graph_root_topology_invalid:${rootIssueId}`;

  for (const issueFact of issues) {
    const issue = issueFact.value;
    if (issue.issueKind === undefined) return `root_graph_issue_kind_missing:${issue.issueId}`;
    if (!hasExactPrimaryKindLabel(issue.labels, issue.issueKind)) {
      return `root_graph_issue_kind_label_invalid:${issue.issueId}`;
    }
    if (issue.projectId !== root.projectId) return `root_graph_project_mismatch:${issue.issueId}`;
    const status = statusById.get(issue.statusId)?.value;
    if (status === undefined
      || status.name !== issue.statusName
      || status.category !== issue.statusCategory
      || status.position !== issue.statusPosition) {
      return `root_graph_status_mismatch:${issue.issueId}`;
    }
    if (issue.issueId === rootIssueId) continue;
    const parent = issue.parentIssueId === undefined ? undefined : issueById.get(issue.parentIssueId)?.value;
    if (parent === undefined) return `root_graph_parent_missing:${issue.issueId}`;
    if (!validParentKind(parent.issueKind, issue.issueKind) || issue.depth !== parent.depth + 1) {
      return `root_graph_parent_kind_invalid:${issue.issueId}`;
    }
  }

  const comments = new Map(
    observation.facts
      .filter(({ value }) => value.kind === "linear_comment")
      .map((fact) => [fact.identity.sourceId, fact]),
  );
  const attachments = new Set(
    observation.facts
      .filter(({ value }) => value.kind === "linear_attachment")
      .map(({ identity }) => identity.sourceId),
  );
  for (const fact of observation.facts) {
    const value = fact.value;
    if (value.kind === "linear_comment") {
      const missingIssue = missingReference(issueById, value.issueId, fact);
      if (missingIssue !== undefined) return missingIssue;
      if (!comments.has(value.threadRootCommentId)) return missingReferenceCode(fact, value.threadRootCommentId);
      if (value.parentCommentId === undefined && value.threadRootCommentId !== value.commentId) {
        return `root_graph_comment_thread_invalid:${value.commentId}`;
      }
      if (value.parentCommentId !== undefined && !comments.has(value.parentCommentId)) {
        return missingReferenceCode(fact, value.parentCommentId);
      }
      if (value.parentCommentId === value.commentId) return `root_graph_comment_thread_invalid:${value.commentId}`;
    } else if (value.kind === "linear_attachment") {
      const missingIssue = missingReference(issueById, value.issueId, fact);
      if (missingIssue !== undefined) return missingIssue;
    } else if (value.kind === "linear_activity") {
      const missingIssue = missingReference(issueById, value.issueId, fact);
      if (missingIssue !== undefined) return missingIssue;
      if (value.attachmentId !== undefined && !attachments.has(value.attachmentId)) {
        return missingReferenceCode(fact, value.attachmentId);
      }
      if (value.fromStateId !== undefined && !statusById.has(value.fromStateId)) {
        return missingReferenceCode(fact, value.fromStateId);
      }
      if (value.toStateId !== undefined && !statusById.has(value.toStateId)) {
        return missingReferenceCode(fact, value.toStateId);
      }
    } else if (value.kind === "linear_relation") {
      if (!issueById.has(value.sourceIssueId)) return missingReferenceCode(fact, value.sourceIssueId);
      if (!issueById.has(value.targetIssueId)) return missingReferenceCode(fact, value.targetIssueId);
      if (value.sourceIssueId === value.targetIssueId) return `root_graph_relation_self_reference:${value.relationId}`;
    }
  }
  return undefined;
}

function isIssueFact(fact: CanonicalFact): fact is LinearIssueFact {
  return fact.value.kind === "linear_issue";
}

function isStatusFact(fact: CanonicalFact): fact is LinearStatusFact {
  return fact.value.kind === "linear_status";
}

function validParentKind(parent: LinearIssueKind | undefined, child: LinearIssueKind): boolean {
  if (child === "cycle") return parent === "root";
  if (child === "plan" || child === "work" || child === "verify" || child === "finding") return parent === "cycle";
  return false;
}

function hasExactPrimaryKindLabel(labels: readonly string[], issueKind: LinearIssueKind): boolean {
  const primary = labels.filter((label) => label.startsWith("symphony:kind/"));
  return primary.length === 1 && primary[0] === `symphony:kind/${issueKind}`;
}

function missingReference(
  issues: ReadonlyMap<string, LinearIssueFact>,
  issueId: string,
  fact: CanonicalFact,
): string | undefined {
  return issues.has(issueId) ? undefined : missingReferenceCode(fact, issueId);
}

function missingReferenceCode(fact: CanonicalFact, sourceId: string): string {
  return `root_graph_reference_missing:${fact.identity.sourceKind}:${fact.identity.sourceId}:${sourceId}`;
}

function validGitFact(
  value: Extract<CanonicalFactInput["value"], { kind: "git_worktree" }>,
  rootIssueId: string,
): boolean {
  return value.rootIssueId === rootIssueId
    && value.repositoryId.length > 0
    && value.branch.length > 0
    && value.headRevision.length > 0
    && value.baseRevision.length > 0;
}

function failed(
  code: string,
  category: RootStateRecoveryFailure["category"],
  retryable: boolean,
): { kind: "failed"; failure: RootStateRecoveryFailure } {
  return { kind: "failed", failure: { code, category, retryable } };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
