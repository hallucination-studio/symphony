import { resolveEvidencePredicate } from "./parallel-black-box-contract.mjs";

const IDENTIFIER = /^[a-z][a-z0-9_-]{2,120}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PREDICATE_OUTCOMES = new Set(["satisfied", "violated", "inconclusive"]);

export async function createFinalCaseVerdict({
  e2eCase,
  caseRoots,
  snapshot,
  evaluateEvidencePredicate,
  observedAt = () => new Date().toISOString(),
} = {}) {
  const caseId = requiredIdentifier(e2eCase?.case_id, "parallel_black_box_campaign_verdict_invalid");
  const observedAtValue = timestamp(observedAt(), "parallel_black_box_campaign_verdict_invalid");
  const predicate = resolveEvidencePredicate(e2eCase?.evidence_predicate_id);

  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
      !["complete", "incomplete"].includes(snapshot.kind)) {
    return verdict(caseId, "incomplete", "fresh_evidence_invalid", [], observedAtValue);
  }
  if (snapshot.kind === "incomplete") {
    return verdict(caseId, "incomplete", "fresh_evidence_incomplete", [], observedAtValue);
  }
  const rootIssueIds = requiredRootIssueIds(caseRoots, "parallel_black_box_campaign_verdict_invalid");
  if (!completeSnapshotHasRoots(snapshot, rootIssueIds)) {
    return verdict(caseId, "incomplete", "fresh_evidence_root_missing", [], observedAtValue);
  }

  let evidenceRefs;
  try {
    evidenceRefs = snapshotReferences(snapshot);
  } catch {
    return verdict(caseId, "incomplete", "fresh_evidence_invalid", [], observedAtValue);
  }
  if (!predicate || typeof evaluateEvidencePredicate !== "function") {
    return verdict(caseId, "incomplete", "evidence_predicate_unavailable", evidenceRefs, observedAtValue);
  }
  let outcome;
  try {
    outcome = await evaluateEvidencePredicate({
      e2e_case: e2eCase,
      case_roots: caseRoots,
      snapshot: deepFreeze(snapshot),
      evidence_predicate: predicate,
    });
    assertPredicateOutcome(outcome);
  } catch {
    return verdict(caseId, "incomplete", "evidence_predicate_unavailable", evidenceRefs, observedAtValue);
  }

  if (outcome.kind === "satisfied") {
    return verdict(caseId, "passed", outcome.reason_code, evidenceRefs, observedAtValue);
  }
  if (outcome.kind === "violated") {
    return verdict(caseId, "failed", outcome.reason_code, evidenceRefs, observedAtValue);
  }
  return verdict(caseId, "incomplete", outcome.reason_code, evidenceRefs, observedAtValue);
}

function completeSnapshotHasRoots(snapshot, rootIssueIds) {
  return Array.isArray(snapshot.root_trees) && rootIssueIds.every((rootIssueId) =>
    snapshot.root_trees.some((tree) => tree && tree.root_issue_id === rootIssueId),
  ) &&
    Array.isArray(snapshot.repositories) && snapshot.repositories.length > 0;
}

function snapshotReferences(snapshot) {
  const references = new Set();
  for (const tree of snapshot.root_trees) {
    if (!identifier(tree?.root_issue_id)) throw stableError("parallel_black_box_campaign_verdict_invalid");
    references.add(`linear:${tree.root_issue_id}`);
  }
  for (const repository of snapshot.repositories) {
    if (!identifier(repository?.repository_identity)) throw stableError("parallel_black_box_campaign_verdict_invalid");
    references.add(`git:${repository.repository_identity}`);
  }
  return [...references];
}

function assertPredicateOutcome(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 2 || !PREDICATE_OUTCOMES.has(value.kind) || !identifier(value.reason_code)) {
    throw stableError("parallel_black_box_campaign_predicate_invalid");
  }
}

function verdict(caseId, status, reasonCode, evidenceRefs, observedAt) {
  return Object.freeze({
    case_id: caseId,
    status,
    reason_code: reasonCode,
    evidence_refs: Object.freeze([...evidenceRefs]),
    observed_at: observedAt,
  });
}

function requiredIdentifier(value, code) {
  if (!identifier(value)) throw stableError(code);
  return value;
}

function requiredRootIssueIds(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 ||
      !Array.isArray(value.root_issue_ids) || value.root_issue_ids.length === 0 || value.root_issue_ids.length > 8 ||
      !value.root_issue_ids.every(identifier) || new Set(value.root_issue_ids).size !== value.root_issue_ids.length) {
    throw stableError(code);
  }
  return value.root_issue_ids;
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function timestamp(value, code) {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw stableError(code);
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
