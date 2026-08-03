import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalTaskRevision,
  parseInvalidTaskIssueRecord,
  parseTaskIssueHistoryEntry,
  parseTaskIssueSnapshot,
  parseTaskRelationSnapshot,
  parseTaskResourceCreationEvidence,
  parseTaskSnapshot,
  parseTaskWorkflowStateMap,
} from "./task-management.js";

const states = {
  team_id: "team:1",
  revision: "symphony:v1:" + "a".repeat(64),
  todo_state_id: "state:todo",
  draft_state_id: "state:draft",
  in_progress_state_id: "state:progress",
  awaiting_acceptance_state_id: "state:acceptance",
  in_review_state_id: "state:review",
  done_state_id: "state:done",
  succeeded_state_id: "state:succeeded",
  rejected_state_id: "state:rejected",
  failed_state_id: "state:failed",
  canceled_state_id: "state:canceled",
} as const;

function issueSource() {
  const fields = {
    issue_id: "issue:work:1",
    provider_created_at: "2026-08-02T01:02:03.000Z",
    provider_updated_at: "2026-08-02T01:02:03.000Z",
    creation_actor_id: "actor:symphony",
    kind: "work",
    status_id: "state:progress",
    status: "In Progress",
    title: "Implement normalized records",
    description_markdown: "# Work\n\nImplement the exact instruction.",
    parent_issue_id: "issue:cycle:1",
    label_ids: ["label:work"],
    delegate_id: null,
    priority: 1,
    archived: false,
    trashed: false,
  } as const;
  return { ...fields, revision: canonicalTaskRevision(fields) };
}

function rootIssueSource() {
  const fields = {
    ...issueSource(),
    issue_id: "LIN-1",
    kind: "root",
    parent_issue_id: null,
    label_ids: ["label:root"],
  } as const;
  const basis = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "revision"));
  return { ...basis, revision: canonicalTaskRevision(basis) };
}

function snapshotSource() {
  return {
    root_id: "LIN-1",
    workflow_state_map: states,
    issues: [rootIssueSource()],
    relations: [],
    resource_creation_evidence: [],
    issue_history: [],
    issue_record_observations: [],
  } as const;
}

test("Task snapshots expose one complete normalized fact model and reject every legacy field", () => {
  const parsed = parseTaskSnapshot(snapshotSource());

  assert.equal(parsed.workflow_state_map.team_id, "team:1");
  assert.equal(parsed.issues[0]?.description_markdown.startsWith("# Work"), true);
  assert.deepEqual(parsed.resource_creation_evidence, []);
  assert.deepEqual(parsed.issue_history, []);
  assert.deepEqual(parsed.issue_record_observations, []);
  assert.ok(Object.isFrozen(parsed));

  assert.throws(
    () => parseTaskSnapshot({ ...snapshotSource(), provider: { sdk: true } }),
    /invalid_contract_keys/u,
  );
  assert.throws(
    () => parseTaskSnapshot({
      ...snapshotSource(),
      issues: [{
        issue_id: "LIN-1",
        revision: "revision:legacy",
        status: "Todo",
        title: "Legacy",
        description: null,
        parent_id: null,
        labels: [],
        delegate_id: null,
        priority: null,
      }],
    }),
    /invalid_contract_keys/u,
  );
});

test("Task Issue snapshots bind semantic status, provider provenance, and canonical revision", () => {
  const parsedStates = parseTaskWorkflowStateMap(states);
  const parsed = parseTaskIssueSnapshot(issueSource(), parsedStates);

  assert.equal(parsed.revision.startsWith("symphony:v1:"), true);
  assert.equal(parsed.status, "In Progress");
  assert.equal(parsed.status_id, "state:progress");
  assert.equal(parsed.creation_actor_id, "actor:symphony");
  assert.equal(parsed.parent_issue_id, "issue:cycle:1");
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.label_ids));

  const wrongStatusFields = { ...issueSource(), status_id: "state:todo" };
  const wrongStatusBasis = Object.fromEntries(
    Object.entries(wrongStatusFields).filter(([key]) => key !== "revision"),
  );
  assert.throws(
    () => parseTaskIssueSnapshot({
      ...wrongStatusFields,
      revision: canonicalTaskRevision(wrongStatusBasis),
    }, parsedStates),
    /task_issue_status_mismatch/u,
  );
  assert.throws(
    () => parseTaskIssueSnapshot({ ...issueSource(), title: "mutated" }, parsedStates),
    /task_issue_revision_mismatch/u,
  );
  assert.throws(
    () => parseTaskIssueSnapshot({ ...issueSource(), metadata: {} }, parsedStates),
    /invalid_contract_keys/u,
  );
});

test("workflow state maps require every active semantic state to have one distinct identity", () => {
  const parsed = parseTaskWorkflowStateMap(states);
  assert.equal(parsed.awaiting_acceptance_state_id, "state:acceptance");
  assert.ok(Object.isFrozen(parsed));

  assert.throws(
    () => parseTaskWorkflowStateMap({ ...states, failed_state_id: states.canceled_state_id }),
    /duplicate_workflow_state_id/u,
  );
  assert.throws(
    () => parseTaskWorkflowStateMap({ ...states, pending_state_id: "state:pending" }),
    /invalid_contract_keys/u,
  );
});

test("relation snapshots and creation evidence bind exact actor, time, endpoints, and digests", () => {
  const relationFields = {
    relation_id: "relation:1",
    provider_created_at: "2026-08-02T02:00:00.000Z",
    provider_updated_at: "2026-08-02T02:00:00.000Z",
    creation_actor_id: "actor:symphony",
    creation_evidence_id: "evidence:relation:1",
    type: "blocks",
    source_issue_id: "issue:work:1",
    target_issue_id: "issue:verify:1",
  } as const;
  const relation = parseTaskRelationSnapshot({
    ...relationFields,
    revision: canonicalTaskRevision(relationFields),
  });
  assert.equal(relation.source_issue_id, "issue:work:1");

  const evidenceFields = {
    evidence_id: "evidence:relation:1",
    resource_kind: "relation",
    resource_id: "relation:1",
    creation_actor_id: "actor:symphony",
    provider_created_at: "2026-08-02T02:00:00.000Z",
    evidence_source: "provider_audit",
  } as const;
  const evidence = parseTaskResourceCreationEvidence({
    ...evidenceFields,
    canonical_evidence_digest: canonicalTaskRevision(evidenceFields),
  });
  assert.equal(evidence.evidence_source, "provider_audit");

  const selfEdgeFields = { ...relationFields, target_issue_id: relationFields.source_issue_id };
  assert.throws(() => parseTaskRelationSnapshot({
    ...selfEdgeFields,
    revision: canonicalTaskRevision(selfEdgeFields),
  }), /task_relation_self_edge/u);
  assert.throws(
    () => parseTaskResourceCreationEvidence({ ...evidence, creation_actor_id: "actor:other" }),
    /task_creation_evidence_digest_mismatch/u,
  );
});

test("grouped history preserves bounded lifecycle facts without claiming mutation order", () => {
  const parsed = parseTaskIssueHistoryEntry({
    history_id: "history:1",
    issue_id: "issue:work:1",
    provider_created_at: "2026-08-02T03:00:00.000Z",
    provider_updated_at: "2026-08-02T03:00:01.000Z",
    actor_id: "actor:symphony",
    change_origin: "symphony",
    changed_fields: ["status", "relation"],
    from_status: "Todo",
    to_status: "In Progress",
    from_parent_issue_id: "issue:cycle:1",
    to_parent_issue_id: "issue:cycle:1",
    added_label_ids: [],
    removed_label_ids: [],
    archived: null,
    trashed: null,
    relation_changes: [{ type: "blocks", related_issue_identifier: "SYM-2" }],
  });
  assert.deepEqual(parsed.changed_fields, ["status", "relation"]);
  assert.ok(Object.isFrozen(parsed.relation_changes));

  assert.throws(
    () => parseTaskIssueHistoryEntry({ ...parsed, changed_fields: ["status", "status"] }),
    /duplicate_contract_identity/u,
  );
  assert.throws(
    () => parseTaskIssueHistoryEntry({ ...parsed, relation_changes: [] }),
    /task_history_relation_evidence_mismatch/u,
  );
});

test("invalid attached-record observations stay sanitized and routable", () => {
  const parsed = parseInvalidTaskIssueRecord({
    record_id: "record:stage:completion:1",
    issue_id: "issue:work:1",
    expected_record_kind: "stage_completion",
    observation_kind: "updated",
    provider_created_at: "2026-08-02T04:00:00.000Z",
    provider_updated_at: "2026-08-02T04:01:00.000Z",
    archived_at: null,
    observed_body_digest: "f".repeat(64),
    parse_error_code: "record_was_updated",
  });
  assert.equal(parsed.observation_kind, "updated");
  assert.equal("body" in parsed, false);

  assert.throws(
    () => parseInvalidTaskIssueRecord({ ...parsed, body: "raw provider body" }),
    /invalid_contract_keys/u,
  );
  assert.throws(
    () => parseInvalidTaskIssueRecord({
      ...parsed,
      observation_kind: "missing",
      provider_created_at: "2026-08-02T04:00:00.000Z",
    }),
    /invalid_missing_record_observation/u,
  );
});
