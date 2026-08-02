import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import {
  architectureRuleTables,
  auditArchitectureDocs,
  inspectArchitectureAuthority,
  inspectArchitectureCrossSemantics,
  inspectArchitecturePresentation,
  inspectArchitectureRuleModel,
  inspectArchitectureSources,
  inspectWorkflowRuleSemantics,
} from "../../tools/architecture/audit-docs.mjs";

function declaredType(source, name) {
  const match = new RegExp(`type ${name} = \\{[\\s\\S]*?\\n\\};`, "u").exec(source);
  assert.ok(match, `missing ${name} in installed Linear SDK declarations`);
  return match[0];
}

test("architecture documents have valid local links and references", async () => {
  assert.deepEqual(await auditArchitectureDocs(process.cwd()), []);
});

test("documentation audit accepts supported Markdown links", () => {
  const sources = new Map([
    ["README.md", [
      "[Inline](root-issue.md#module)",
      "[Angle](<root-issue.md#module> \"title\")",
      "[Reference][root-issue]",
      "[root-issue]: root-issue.md#module",
      "[Outside](../README.md)",
      "[External](https://example.com/guide.md)",
    ].join("\n")],
    ["root-issue.md", "# Module"],
    ["../README.md", "# Repository"],
  ]);

  assert.deepEqual(inspectArchitectureSources(sources), []);
});

test("documentation audit rejects missing files, anchors, and references", () => {
  const sources = new Map([
    ["README.md", [
      "[Missing](missing.md)",
      "[Anchor](root-issue.md#missing)",
      "[Undefined][unknown]",
    ].join("\n")],
    ["root-issue.md", "# Module"],
  ]);

  assert.deepEqual(inspectArchitectureSources(sources), [
    { code: "broken_architecture_anchor", file: "README.md", target: "root-issue.md#missing" },
    { code: "broken_architecture_link", file: "README.md", target: "missing.md" },
    { code: "undefined_architecture_reference", file: "README.md", target: "unknown" },
  ]);
});

test("architecture authority rejects tracked tasks and task references", () => {
  const sources = new Map([
    ["README.md", "# Architecture\n\nSee `tasks/scope-ledgers/root.md`."],
    ["root-issue.md", "# Root Issue"],
  ]);

  assert.deepEqual(
    inspectArchitectureAuthority(sources, [
      "docs/architecture/README.md",
      "tasks/plan.md",
      "tasks/scope-ledgers/root.md",
    ]),
    [
      { code: "architecture_references_execution_task", file: "README.md" },
      { code: "tracked_execution_task", file: "tasks/plan.md" },
      { code: "tracked_execution_task", file: "tasks/scope-ledgers/root.md" },
    ],
  );
});

test("architecture presentation rejects long prose blocks and dense table cells", () => {
  const valid = new Map([["valid.md", [
    "# Valid",
    "",
    "One short boundary statement.",
    "",
    "| Fact | Owner |",
    "|---|---|",
    `| ${"structured ".repeat(8)}<br>${"bounded ".repeat(8)} | owner |`,
    "",
    "```mermaid",
    "%% source-rules: WF-AUTH-001 WF-AUTH-002",
    "flowchart LR",
    "  A --> B",
    "```",
  ].join("\n")]]);
  assert.deepEqual(inspectArchitecturePresentation(valid), []);

  const invalid = new Map([["invalid.md", [
    "# Invalid",
    "",
    "This paragraph mixes several independent architecture constraints into one prose block.",
    "It keeps adding state, ownership, failure, provider, and persistence details instead of using a table.",
    "The result is difficult to scan and easy to contradict in another owner document.",
  ].join("\n")]]);
  assert.deepEqual(inspectArchitecturePresentation(invalid), [{
    code: "oversized_architecture_prose",
    file: "invalid.md",
    target: "3",
  }]);

  const denseTable = new Map([["dense-table.md", [
    "| Fact | Owner |",
    "|---|---|",
    `| ${"unbroken ".repeat(25)} | owner |`,
  ].join("\n")]]);
  assert.deepEqual(inspectArchitecturePresentation(denseTable), [{
    code: "oversized_architecture_table_cell",
    file: "dense-table.md",
    target: "3:1",
  }]);

  const giantContract = new Map([["giant-contract.md", [
    "# Giant contract",
    "",
    "```text",
    ...Array.from({ length: 81 }, (_, index) => `Field${index} { value }`),
    "```",
  ].join("\n")]]);
  assert.deepEqual(inspectArchitecturePresentation(giantContract), [{
    code: "oversized_architecture_contract_block",
    file: "giant-contract.md",
    target: "3",
  }]);

  const giantMermaidSource = new Map([["giant-mermaid-source.md", [
    "```mermaid",
    `%% source-rules: ${"WF-AUTH-001 ".repeat(12)}`,
    "flowchart LR",
    "  A --> B",
    "```",
  ].join("\n")]]);
  assert.deepEqual(inspectArchitecturePresentation(giantMermaidSource), [{
    code: "oversized_architecture_mermaid_source_rules",
    file: "giant-mermaid-source.md",
    target: "1",
  }]);

  const splitDenseTable = new Map([["split-dense-table.md", [
    "| Fact | Owner |",
    "|---|---|",
    `| ${"first ".repeat(25)}<br>${"second ".repeat(25)} | owner |`,
  ].join("\n")]]);
  assert.deepEqual(inspectArchitecturePresentation(splitDenseTable), [{
    code: "oversized_architecture_table_cell",
    file: "split-dense-table.md",
    target: "3:1",
  }]);

  const denseList = new Map([["dense-list.md", [
    "# Dense list",
    "",
    `- ${"unbroken ".repeat(30)}`,
  ].join("\n")]]);
  assert.deepEqual(inspectArchitecturePresentation(denseList), [{
    code: "oversized_architecture_list_item",
    file: "dense-list.md",
    target: "3",
  }]);

  const quotedProse = new Map([["quoted-prose.md", [
    "# Quoted prose",
    "",
    `> ${"unbroken ".repeat(30)}`,
  ].join("\n")]]);
  assert.deepEqual(inspectArchitecturePresentation(quotedProse), [{
    code: "oversized_architecture_prose",
    file: "quoted-prose.md",
    target: "3",
  }]);

  const quotedList = new Map([["quoted-list.md", [
    "# Quoted list",
    "",
    `> - ${"unbroken ".repeat(30)}`,
  ].join("\n")]]);
  assert.deepEqual(inspectArchitecturePresentation(quotedList), [{
    code: "oversized_architecture_list_item",
    file: "quoted-list.md",
    target: "3",
  }]);

  const quotedTable = new Map([["quoted-table.md", [
    "> | Fact | Owner |",
    "> |---|---|",
    `> | ${"unbroken ".repeat(25)} | owner |`,
  ].join("\n")]]);
  assert.deepEqual(inspectArchitecturePresentation(quotedTable), [{
    code: "oversized_architecture_table_cell",
    file: "quoted-table.md",
    target: "3:1",
  }]);

  const outerlessTable = new Map([["outerless-table.md", [
    "Fact | Owner",
    "---|---",
    `${"unbroken ".repeat(21)} | owner`,
  ].join("\n")]]);
  assert.deepEqual(inspectArchitecturePresentation(outerlessTable), [{
    code: "oversized_architecture_table_cell",
    file: "outerless-table.md",
    target: "3:1",
  }]);
});

test("architecture rule tables are parsed as structured authority", () => {
  const source = [
    "## Routing table",
    "",
    "| Rule | Facts | Consumer |",
    "|---|---|---|",
    "| `WF-ROUTE-001` | `cycle_active` | `CycleMachine` |",
  ].join("\n");

  assert.deepEqual(architectureRuleTables(source, "workflow-model.md"), [{
    file: "workflow-model.md",
    heading: "Routing table",
    headers: ["Rule", "Facts", "Consumer"],
    rows: [{ Rule: "`WF-ROUTE-001`", Facts: "`cycle_active`", Consumer: "`CycleMachine`" }],
  }]);

  const fenced = [
    "```text",
    "| Rule | Facts | Consumer |",
    "|---|---|---|",
    "| `WF-ROUTE-999` | `fake` | `Park` |",
    "```",
  ].join("\n");
  assert.deepEqual(architectureRuleTables(fenced, "workflow-model.md"), []);
});

test("architecture rule audit checks unique definitions, references, and Mermaid sources", () => {
  const valid = new Map([
    ["workflow-model.md", [
      "## Routing table",
      "| Rule | Facts | Consumer |",
      "|---|---|---|",
      "| `WF-ROUTE-001` | `cycle_active` | `CycleMachine` |",
      "```mermaid",
      "%% source-rules: WF-ROUTE-001",
      "flowchart LR",
      "  A --> B",
      "```",
    ].join("\n")],
    ["conductor.md", "Uses `WF-ROUTE-001`."],
  ]);
  assert.deepEqual(inspectArchitectureRuleModel(valid), []);

  const invalid = new Map([
    ["a.md", [
      "| Rule | Facts | Consumer |",
      "|---|---|---|",
      "| `WF-ROUTE-001` | `cycle_active` | `CycleMachine` |",
      "| `WF-ROUTE-002` |  | `RootBoundary` |",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "Uses WF-ROUTE-999.",
    ].join("\n")],
    ["b.md", [
      "| Rule | Facts | Consumer |",
      "|---|---|---|",
      "| `WF-ROUTE-001` | `other` | `Park` |",
    ].join("\n")],
  ]);
  assert.deepEqual(inspectArchitectureRuleModel(invalid), [
    { code: "incomplete_architecture_rule", file: "a.md", target: "WF-ROUTE-002" },
    { code: "mermaid_missing_source_rules", file: "a.md", target: "" },
    { code: "misplaced_architecture_rule_definition", file: "a.md", target: "WF-ROUTE-001" },
    { code: "misplaced_architecture_rule_definition", file: "a.md", target: "WF-ROUTE-002" },
    { code: "undefined_architecture_rule", file: "a.md", target: "WF-ROUTE-999" },
    { code: "duplicate_architecture_rule_id", file: "b.md", target: "WF-ROUTE-001" },
  ]);
});

test("pinned Linear SDK capabilities match the architecture assumptions", async () => {
  const declarationDirectory = "node_modules/@linear/sdk/dist";
  const declarationFiles = (await readdir(declarationDirectory))
    .filter((name) => /\.d\.(?:c|m)?ts$/u.test(name));
  const declarations = (await Promise.all(
    declarationFiles.map((name) => readFile(`${declarationDirectory}/${name}`, "utf8")),
  )).join("\n");

  assert.match(
    declarations,
    /Each history entry captures one or more property changes made to an issue within a short grouping window by the same actor/u,
  );
  const issueUpdateInput = declaredType(declarations, "IssueUpdateInput");
  assert.doesNotMatch(
    issueUpdateInput,
    /\b(?:expectedRevision|expected_revision|revision|version|ifMatch|compareAndSwap|cas)\??\s*:/iu,
  );
  const commentCreateInput = declaredType(declarations, "CommentCreateInput");
  assert.match(commentCreateInput, /\bid\??:\s*InputMaybe<[^\n]+String/u);
  assert.match(commentCreateInput, /\bcreatedAt\??:\s*InputMaybe<[^\n]+DateTime/u);
  const commentUpdateInput = declaredType(declarations, "CommentUpdateInput");
  assert.match(commentUpdateInput, /\bbody\??:\s*InputMaybe<[^\n]+String/u);
  const commentDeleteArgs = declaredType(declarations, "MutationCommentDeleteArgs");
  assert.match(commentDeleteArgs, /\bid:\s*Scalars\["String"\]/u);
  const issueCreateInput = declaredType(declarations, "IssueCreateInput");
  assert.match(issueCreateInput, /\bcreatedAt\??:\s*InputMaybe<[^\n]+DateTime/u);
  const issueRelationCreateArgs = declaredType(declarations, "MutationIssueRelationCreateArgs");
  assert.match(issueRelationCreateArgs, /\boverrideCreatedAt\??:\s*InputMaybe<[^\n]+DateTime/u);
  const issueDeleteArgs = declaredType(declarations, "MutationIssueDeleteArgs");
  assert.match(issueDeleteArgs, /\bpermanentlyDelete\??:\s*InputMaybe<[^\n]+Boolean/u);
});

test("workflow model tables preserve the closed state-machine semantics", async () => {
  const source = await readFile("docs/architecture/workflow-model.md", "utf8");
  const sources = new Map([["workflow-model.md", source]]);

  assert.deepEqual(inspectWorkflowRuleSemantics(sources), []);

  const tables = new Map(architectureRuleTables(source, "workflow-model.md")
    .filter((table) => table.headers.includes("Rule"))
    .map((table) => [table.heading, table]));
  assert.deepEqual([...tables.keys()], [
    "Authority table",
    "Topology table",
    "Transition table",
    "Routing table",
    "Failure table",
    "Restart table",
    "Persistence table",
  ]);
  assert.deepEqual(tables.get("Routing table").headers, [
    "Rule",
    "Priority",
    "Fresh facts",
    "Consumer",
    "Allowed action",
    "Root model turn",
  ]);
  assert.deepEqual(tables.get("Transition table").headers, [
    "Rule",
    "Machine",
    "From",
    "Event",
    "Record owner",
    "Projection owner",
    "Required durable fact before projection",
    "To",
    "Direct Root wake",
  ]);
  const rows = new Map([...tables.values()].flatMap((table) => table.rows)
    .map((row) => [row.Rule?.match(/\bWF-[A-Z]+-\d{3}\b/u)?.[0], row]));
  assert.equal(rows.get("WF-ROUTE-015")?.Priority, "`55`");
  assert.equal(rows.get("WF-ROUTE-015")?.["Root model turn"], "`no`");
  assert.equal(rows.get("WF-ROUTE-016")?.Priority, "`1`");
  assert.equal(rows.get("WF-ROUTE-016")?.["Root model turn"], "`no`");
  assert.equal(rows.get("WF-ROUTE-017")?.Priority, "`50`");
  assert.equal(rows.get("WF-ROUTE-017")?.["Root model turn"], "`no`");
  assert.equal(rows.get("WF-ROUTE-011")?.Consumer, "`CycleMachine`");
  assert.equal(rows.get("WF-ROUTE-015")?.Consumer, "`CycleMachine`");
  assert.equal(rows.get("WF-ROUTE-017")?.Consumer, "`CycleMachine`");
  assert.equal(rows.get("WF-ROUTE-003")?.Consumer, "`CycleMachine`");
  assert.equal(rows.get("WF-TR-005")?.["Record owner"], "`RootBoundary`");
  assert.equal(rows.get("WF-TR-005")?.["Projection owner"], "`CycleMachine`");
  assert.equal(rows.get("WF-TR-009")?.["Record owner"], "`RootBoundary`");
  assert.equal(rows.get("WF-TR-009")?.["Projection owner"], "`CycleMachine`");
  assert.equal(rows.get("WF-TR-014")?.From, "`Draft,In Progress,Awaiting Acceptance`");
  assert.equal(rows.get("WF-TR-014")?.To, "`Failed`");
  assert.equal(rows.get("WF-TR-015")?.To, "`Canceled`");
  assert.equal(rows.get("WF-FAIL-017")?.Owner, "`Router`");
  assert.equal(
    rows.get("WF-RESTART-002")?.["Persisted facts"],
    "selected terminal record present, non-terminal status",
  );
});

test("workflow semantic audit rejects a Root wake on internal Cycle progress", async () => {
  const source = await readFile("docs/architecture/workflow-model.md", "utf8");
  const invalid = source.replace(
    /(\| `WF-ROUTE-004` \|[^\n]+\| )`no`( \|)/u,
    "$1`yes`$2",
  );
  assert.notEqual(invalid, source);
  assert.ok(inspectWorkflowRuleSemantics(new Map([["workflow-model.md", invalid]])).some(
    (violation) => violation.code === "invalid_workflow_rule_semantics" ||
      violation.code === "invalid_root_wake_semantics",
  ));
});

test("workflow semantic audit rejects a direct Root wake from any projection", async () => {
  const source = await readFile("docs/architecture/workflow-model.md", "utf8");
  const invalid = source.replace(
    /(\| `WF-TR-007` \|[^\n]+\| )`no`( \|)/u,
    "$1`yes`$2",
  );
  assert.notEqual(invalid, source);
  assert.ok(inspectWorkflowRuleSemantics(new Map([["workflow-model.md", invalid]])).some(
    (violation) => violation.code === "direct_root_wake_from_transition",
  ));
});

test("workflow semantic audit rejects an undeclared transition", async () => {
  const source = await readFile("docs/architecture/workflow-model.md", "utf8");
  const invalid = source.replace(
    /\| `WF-TR-013`[^\n]+\n/u,
    (row) => `${row}| \`WF-TR-999\` | \`Cycle\` | \`In Progress\` | \`invented\` | \`CycleMachine\` | record read-back | \`Failed\` | \`no\` |\n`,
  );
  assert.ok(inspectWorkflowRuleSemantics(new Map([["workflow-model.md", invalid]])).some(
    (violation) => violation.code === "unexpected_workflow_rule" && violation.target === "WF-TR-999",
  ));
});

test("workflow semantic audit rejects Root external-edit priority above Cycle mechanics", async () => {
  const source = await readFile("docs/architecture/workflow-model.md", "utf8");
  const invalid = source.replace(
    /(\| `WF-ROUTE-005` \| )`130`( \|)/u,
    "$1`70`$2",
  );
  assert.notEqual(invalid, source);
  assert.ok(inspectWorkflowRuleSemantics(new Map([["workflow-model.md", invalid]])).some(
    (violation) => violation.code === "invalid_routing_priority_semantics" &&
      violation.target === "WF-ROUTE-005.Priority",
  ));
});

test("workflow semantic audit rejects invalidation projection loss on restart", async () => {
  const source = await readFile("docs/architecture/workflow-model.md", "utf8");
  const invalid = source.replace(
    "selected terminal record present, non-terminal status",
    "completion record present, non-terminal status",
  );
  assert.notEqual(invalid, source);
  assert.ok(inspectWorkflowRuleSemantics(new Map([["workflow-model.md", invalid]])).some(
    (violation) => violation.code === "invalid_workflow_rule_semantics" &&
      violation.target === "WF-RESTART-002.Persisted facts",
  ));
});

test("workflow semantic audit rejects closure before authoritative record projection", async () => {
  const source = await readFile("docs/architecture/workflow-model.md", "utf8");
  for (const [closedFact, unsafeFact, target] of [
    [
      "root_done_with_intact_active_cycle",
      "root_done_with_active_cycle",
      "WF-ROUTE-011.Fresh facts",
    ],
    [
      "active_root_admission_lost_non_done_and_no_cycle_record_projection_pending",
      "active_root_admission_lost_non_done",
      "WF-ROUTE-015.Fresh facts",
    ],
  ]) {
    const invalid = source.replace(closedFact, unsafeFact);
    assert.notEqual(invalid, source);
    assert.ok(inspectWorkflowRuleSemantics(new Map([[
      "workflow-model.md",
      invalid,
    ]])).some((violation) =>
      violation.code === "invalid_workflow_rule_semantics" && violation.target === target));
  }

  const missingProjectionClause = source.replace(
    "no Cycle record projection gap",
    "Cycle record projection gap allowed",
  );
  assert.notEqual(missingProjectionClause, source);
  assert.ok(inspectWorkflowRuleSemantics(new Map([[
    "workflow-model.md",
    missingProjectionClause,
  ]])).some((violation) =>
    violation.code === "incomplete_routing_predicate" &&
    violation.target === "intact_active_cycle"));
});

test("workflow semantic audit rejects weakened Verify cardinality and invalid-terminal policy", async () => {
  const source = await readFile("docs/architecture/workflow-model.md", "utf8");
  const invalidCardinality = source.replace(
    /(\| `WF-TOPO-004` \|[^\n]+\| )exactly one( \|)/u,
    "$1zero or more$2",
  );
  assert.notEqual(invalidCardinality, source);
  assert.ok(inspectWorkflowRuleSemantics(new Map([["workflow-model.md", invalidCardinality]])).some(
    (violation) => violation.code === "invalid_workflow_rule_semantics" &&
      violation.target === "WF-TOPO-004.Cardinality",
  ));

  const invalidPolicy = source.replace(
    "new intact record may allow successor<br>" +
      "selected invalidation conflict -> `WF-ROUTE-016`<br>" +
      "otherwise permanent quarantine",
    "`allowed` for every invalid terminal",
  );
  assert.notEqual(invalidPolicy, source);
  assert.ok(inspectWorkflowRuleSemantics(new Map([["workflow-model.md", invalidPolicy]])).some(
    (violation) => violation.code === "invalid_workflow_rule_semantics" &&
      violation.target === "WF-FAIL-005.Resolution",
  ));
});

test("cross-document semantics close Define, delivery, successor, and Root binding", async () => {
  const directory = "docs/architecture";
  const files = (await readdir(directory)).filter((file) => file.endsWith(".md"));
  const sources = new Map(await Promise.all(files.map(async (file) => [
    file,
    await readFile(`${directory}/${file}`, "utf8"),
  ])));

  assert.deepEqual(inspectArchitectureCrossSemantics(sources), []);

  const mixedProviderSnapshot = new Map(sources);
  mixedProviderSnapshot.set("contracts.md", sources.get("contracts.md").replace(
    "linear: LinearExecutionSnapshot,",
    "linear: CycleExecutionSnapshot,",
  ));
  assert.notEqual(mixedProviderSnapshot.get("contracts.md"), sources.get("contracts.md"));
  assert.ok(inspectArchitectureCrossSemantics(mixedProviderSnapshot).some(
    (violation) => violation.code === "invalid_provider_separated_execution_contract",
  ));

  const ambiguousDeliveryRoute = new Map(sources);
  ambiguousDeliveryRoute.set("contracts.md", sources.get("contracts.md").replace(
    "disposition: delivery_finalizer, selected_route: WF-ROUTE-010 | WF-ROUTE-012,",
    "disposition: projection_only, selected_route: WF-ROUTE-010 | WF-ROUTE-012,",
  ));
  assert.notEqual(ambiguousDeliveryRoute.get("contracts.md"), sources.get("contracts.md"));
  assert.ok(inspectArchitectureCrossSemantics(ambiguousDeliveryRoute).some(
    (violation) => violation.code === "invalid_root_routing_disposition_contract",
  ));

  const missingStateMap = new Map(sources);
  missingStateMap.set("contracts.md", sources.get("contracts.md").replace(
    "workflow_state_map: TaskWorkflowStateMap,",
    "workflow_state_map_digest: digest,",
  ));
  assert.notEqual(missingStateMap.get("contracts.md"), sources.get("contracts.md"));
  assert.ok(inspectArchitectureCrossSemantics(missingStateMap).some(
    (violation) => violation.code === "invalid_workflow_state_mapping_contract",
  ));

  const ambiguousInvalidSnapshot = new Map(sources);
  ambiguousInvalidSnapshot.set("contracts.md", sources.get("contracts.md").replace(
    "failure_kind: incomplete_known_identity_evidence,",
    "failure_kind: known_issue_missing,",
  ));
  assert.notEqual(ambiguousInvalidSnapshot.get("contracts.md"), sources.get("contracts.md"));
  assert.ok(inspectArchitectureCrossSemantics(ambiguousInvalidSnapshot).some(
    (violation) => violation.code === "invalid_task_snapshot_failure_contract",
  ));

  const observerPreselectsQuarantine = new Map(sources);
  observerPreselectsQuarantine.set("contracts.md", sources.get("contracts.md").replace(
    "sanitized_reason_code: incomplete_known_identity_evidence",
    "sanitized_reason_code: incomplete_known_identity_evidence,\n  disposition: permanently_quarantined",
  ));
  assert.notEqual(observerPreselectsQuarantine.get("contracts.md"), sources.get("contracts.md"));
  assert.ok(inspectArchitectureCrossSemantics(observerPreselectsQuarantine).some(
    (violation) => violation.code === "invalid_task_snapshot_failure_contract",
  ));

  const cachedCycleAdvance = new Map(sources);
  cachedCycleAdvance.set("contracts.md", sources.get("contracts.md").replace(
    "execution_snapshot: CycleExecutionSnapshot",
    "cached_cycle_id: CycleIssueId",
  ));
  assert.notEqual(cachedCycleAdvance.get("contracts.md"), sources.get("contracts.md"));
  assert.ok(inspectArchitectureCrossSemantics(cachedCycleAdvance).some(
    (violation) => violation.code === "invalid_cycle_advance_contract",
  ));

  const invalidAccepted = new Map(sources);
  invalidAccepted.set("contracts.md", sources.get("contracts.md").replace(
    "successor_policy: not_applicable,",
    "successor_policy: allowed,",
  ));
  assert.ok(inspectArchitectureCrossSemantics(invalidAccepted).some(
    (violation) => violation.code === "invalid_cycle_completion_outcome_policy_contract",
  ));

  const invalidRetryable = new Map(sources);
  invalidRetryable.set("contracts.md", sources.get("contracts.md").replace(
    "successor_policy: allowed,\n  completion: RejectedCycleCompletion | FailedCycleCompletion | CanceledCycleCompletion",
    "successor_policy: not_applicable,\n  completion: RejectedCycleCompletion | FailedCycleCompletion | CanceledCycleCompletion",
  ));
  assert.ok(inspectArchitectureCrossSemantics(invalidRetryable).some(
    (violation) => violation.code === "invalid_cycle_completion_outcome_policy_contract",
  ));

  const invalidInvalidation = new Map(sources);
  invalidInvalidation.set("contracts.md", sources.get("contracts.md").replace(
    "successor_policy: allowed,\n  successor_evidence: InvalidTerminalSuccessorEvidence",
    "successor_policy: allowed,\n  successor_evidence: null",
  ));
  assert.ok(inspectArchitectureCrossSemantics(invalidInvalidation).some(
    (violation) => violation.code === "invalid_cycle_invalidation_policy_contract",
  ));

  const invalidDeliveryEvidence = new Map(sources);
  invalidDeliveryEvidence.set("contracts.md", sources.get("contracts.md").replace(
    "invalidation_evidence: DeliveryInvalidationEvidence,",
    "convergence_proof: CrossProviderConvergenceProof,",
  ));
  assert.ok(inspectArchitectureCrossSemantics(invalidDeliveryEvidence).some(
    (violation) => violation.code === "invalid_delivery_invalidation_evidence_contract",
  ));

  const invalidDeliveryEvidenceOrder = new Map(sources);
  invalidDeliveryEvidenceOrder.set("contracts.md", sources.get("contracts.md").replace(
    /(DeliveryInvalidationEvidence = \{[\s\S]*?observation_order: )linear -> git -> delivery -> linear -> git -> delivery,/u,
    "$1linear -> git -> linear -> git,",
  ));
  assert.ok(inspectArchitectureCrossSemantics(invalidDeliveryEvidenceOrder).some(
    (violation) => violation.code === "invalid_delivery_invalidation_evidence_contract",
  ));

  const emptyVerifySet = new Map(sources);
  emptyVerifySet.set("contracts.md", sources.get("contracts.md").replace(
    "verify_directives: [VerificationDirective, ...VerificationDirective[]],",
    "verify_directives: VerificationDirective[],",
  ));
  assert.ok(inspectArchitectureCrossSemantics(emptyVerifySet).some(
    (violation) => violation.code === "empty_verify_directives_contract",
  ));

  const invalidTerminalMapping = new Map(sources);
  const invalidTerminalMappingSource = sources.get("contracts.md").replace(
    /(status:\s*Rejected,\s*projection_state:\s*none,[\s\S]*?completion:\s*)RejectedCycleCompletion/u,
    "$1InProgressFailedCycleCompletion",
  );
  assert.notEqual(invalidTerminalMappingSource, sources.get("contracts.md"));
  invalidTerminalMapping.set("contracts.md", invalidTerminalMappingSource);
  assert.ok(inspectArchitectureCrossSemantics(invalidTerminalMapping).some(
    (violation) => violation.code === "invalid_cycle_document_terminal_mapping",
  ));

  const invalidAcceptanceOrder = new Map(sources);
  invalidAcceptanceOrder.set("contracts.md", sources.get("contracts.md").replace(
    "observation_order: linear -> git -> linear -> git,",
    "observation_order: linear -> git -> delivery -> linear -> git -> delivery,",
  ));
  assert.ok(inspectArchitectureCrossSemantics(invalidAcceptanceOrder).some(
    (violation) => violation.code === "invalid_scope_specific_convergence_contract",
  ));

  const invalidDeliveryProof = new Map(sources);
  invalidDeliveryProof.set("contracts.md", sources.get("contracts.md").replace(
    "convergence_proof: DeliveryConvergenceProof",
    "convergence_proof: AcceptanceConvergenceProof",
  ));
  assert.ok(inspectArchitectureCrossSemantics(invalidDeliveryProof).some(
    (violation) => violation.code === "invalid_scope_specific_convergence_contract",
  ));

  const planSelectsVerify = new Map(sources);
  planSelectsVerify.set("contracts.md", sources.get("contracts.md").replace(
    "ordered_work_group_ids: [WorkGroupId, ...WorkGroupId[]] } |",
    "ordered_work_group_ids: [WorkGroupId, ...WorkGroupId[]],\n" +
      "    verify_directive_ids: VerificationDirectiveId[] } |",
  ));
  assert.ok(inspectArchitectureCrossSemantics(planSelectsVerify).some(
    (violation) => violation.code === "plan_selects_verify_directives",
  ));

  const invalidStageMapping = new Map(sources);
  invalidStageMapping.set("contracts.md", sources.get("contracts.md").replace(
    "typeof completion_record_id, typeof invalidation_record_id,\n  CompletedWorkCompletion,",
    "typeof completion_record_id, typeof invalidation_record_id,\n  PassedVerifyCompletion,",
  ));
  assert.ok(inspectArchitectureCrossSemantics(invalidStageMapping).some(
    (violation) => violation.code === "invalid_stage_document_terminal_mapping",
  ));

  const invalidStageProjection = new Map(sources);
  invalidStageProjection.set("contracts.md", sources.get("contracts.md").replace(
    "StageCompletionProjectionPending<CycleId, StageId, CompletionRecordId,\n" +
      "                                 DoneCompletion, FailedCompletion,\n" +
      "                                 CanceledCompletion> {\n  status: In Progress,",
    "StageCompletionProjectionPending<CycleId, StageId, CompletionRecordId,\n" +
      "                                 DoneCompletion, FailedCompletion,\n" +
      "                                 CanceledCompletion> {\n  status: Todo,",
  ));
  assert.ok(inspectArchitectureCrossSemantics(invalidStageProjection).some(
    (violation) => violation.code === "invalid_stage_document_terminal_mapping",
  ));

  const partialRootInput = new Map(sources);
  partialRootInput.set("contracts.md", sources.get("contracts.md").replace(
    "RootSemanticSnapshot {",
    "RootFactDiff {",
  ));
  assert.ok(inspectArchitectureCrossSemantics(partialRootInput).some(
    (violation) => violation.code === "partial_root_semantic_input_contract",
  ));

  const unroutedRootInput = new Map(sources);
  unroutedRootInput.set("contracts.md", sources.get("contracts.md").replace(
    "routing: RootRoutingDisposition & { disposition: root_boundary },",
    "routing_digest: digest,",
  ));
  assert.notEqual(unroutedRootInput.get("contracts.md"), sources.get("contracts.md"));
  assert.ok(inspectArchitectureCrossSemantics(unroutedRootInput).some(
    (violation) => violation.code === "partial_root_semantic_input_contract",
  ));

  const contaminatedVerify = new Map(sources);
  contaminatedVerify.set("performer.md", sources.get("performer.md").replace(
    "Plan/Work context、Work continuation、write capability",
    "Plan context、write capability",
  ));
  assert.ok(inspectArchitectureCrossSemantics(contaminatedVerify).some(
    (violation) => violation.code === "invalid_cross_document_rule_semantics" &&
      violation.target === "PF-CTX-003.Excluded input",
  ));

  const incompleteVerifyCover = new Map(sources);
  incompleteVerifyCover.set("root-issue.md", sources.get("root-issue.md").replace(
    "Plan Issue/completion/invalidation IDs equal",
    "Plan Issue/completion/invalidation IDs may differ",
  ));
  assert.ok(inspectArchitectureCrossSemantics(incompleteVerifyCover).some(
    (violation) => violation.code === "invalid_cross_document_rule_semantics" &&
      violation.target === "RI-MANIFEST-003.Exact check",
  ));

  const emptyWorkGraph = new Map(sources);
  emptyWorkGraph.set("contracts.md", sources.get("contracts.md").replace(
    "execution_directives: [ExecutionDirective, ...ExecutionDirective[]],",
    "execution_directives: ExecutionDirective[],",
  ));
  assert.ok(inspectArchitectureCrossSemantics(emptyWorkGraph).some(
    (violation) => violation.code === "empty_work_graph_contract",
  ));

  const failureCarriesManifest = new Map(sources);
  failureCarriesManifest.set("contracts.md", sources.get("contracts.md").replace(
    "FailedPlanCompletion { outcome: failed, instruction_digest, reason_markdown }",
    "FailedPlanCompletion { outcome: failed, instruction_digest, reason_markdown, manifest: PlanGraphManifest }",
  ));
  assert.ok(inspectArchitectureCrossSemantics(failureCarriesManifest).some(
    (violation) => violation.code === "invalid_plan_terminal_payload_split",
  ));

  const missingToolEnvelope = new Map(sources);
  missingToolEnvelope.set("contracts.md", sources.get("contracts.md").replace(
    "TaskMcpCall = TaskMcpCallCommon & (",
    "TaskMcpRequest = TaskMcpCallCommon & (",
  ));
  assert.ok(inspectArchitectureCrossSemantics(missingToolEnvelope).some(
    (violation) => violation.code === "missing_public_tool_contract",
  ));

  const crossThreadContinuation = new Map(sources);
  crossThreadContinuation.set("performer.md", sources.get("performer.md").replace(
    "same live provider thread transport may carry it",
    "any later provider request may carry it",
  ));
  assert.ok(inspectArchitectureCrossSemantics(crossThreadContinuation).some(
    (violation) => violation.code === "invalid_work_continuation_transport_scope",
  ));

  const mismatchedDeliveryAction = new Map(sources);
  mismatchedDeliveryAction.set("contracts.md", sources.get("contracts.md").replace(
    "disposition: delivery_finalizer, selected_route: WF-ROUTE-010 } }",
    "disposition: delivery_finalizer, selected_route: WF-ROUTE-012 } }",
  ));
  assert.ok(inspectArchitectureCrossSemantics(mismatchedDeliveryAction).some(
    (violation) => violation.code === "missing_conductor_action_contract",
  ));

  const unreachableExternalTerminal = new Map(sources);
  unreachableExternalTerminal.set("contracts.md", sources.get("contracts.md").replace(
    "cycle_document: CycleObservation,",
    "cycle_document: CycleDocument,",
  ));
  assert.ok(inspectArchitectureCrossSemantics(unreachableExternalTerminal).some(
    (violation) => violation.code === "unconstructible_external_terminal_route_input",
  ));

  const deliveryFactInGit = new Map(sources);
  deliveryFactInGit.set("contracts.md", sources.get("contracts.md").replace(
    "head_commit_proof: GitCommitProof | null\n}",
    "head_commit_proof: GitCommitProof | null, pull_request?\n}",
  ));
  assert.ok(inspectArchitectureCrossSemantics(deliveryFactInGit).some(
    (violation) => violation.code === "invalid_provider_separated_execution_contract",
  ));

  const mismatchedManifestVerify = new Map(sources);
  mismatchedManifestVerify.set("contracts.md", sources.get("contracts.md").replace(
    "verify_issue_id: typeof verify_node.issue_id,",
    "verify_issue_id: VerifyIssueId,",
  ));
  assert.ok(inspectArchitectureCrossSemantics(mismatchedManifestVerify).some(
    (violation) => violation.code === "invalid_exact_manifest_node_contract",
  ));
});

test("contract document declares the closed cross-module value families", async () => {
  const source = await readFile("docs/architecture/contracts.md", "utf8");
  const declared = new Set([...source.matchAll(/^([A-Z][A-Za-z0-9]+)(?:<[^>\n]+>)?\s*(?:=|\{)/gmu)]
    .map((match) => match[1]));

  for (const name of [
    "TaskObservationEvent",
    "TaskPollResult",
    "TaskWorkflowStateMap",
    "RootSemanticSnapshot",
    "TaskSnapshot",
    "InvalidTaskSnapshot",
    "AcceptanceConvergenceProof",
    "DeliveryConvergenceProof",
    "InvalidTerminalSuccessorEvidence",
    "CycleSpecification",
    "CycleDocument",
    "CycleObservation",
    "StageDocument",
    "StageObservation",
    "PlanStageDocument",
    "WorkStageDocument",
    "VerifyStageDocument",
    "PlanGraphManifest",
    "LinearExecutionSnapshot",
    "CycleExecutionSnapshot",
    "CycleAdvanceRequest",
    "CycleAdvanceResult",
    "CycleContextObservation",
    "TaskMcpCall",
    "TaskMcpResult",
    "GitToolCall",
    "GitToolResult",
    "DeliveryToolCall",
    "DeliveryToolResult",
    "TaskMutationResult",
    "PlanRequest",
    "WorkRequest",
    "WorkTurnResult",
    "VerifyRequest",
  ]) {
    assert.ok(declared.has(name), `missing public contract ${name}`);
  }
  assert.doesNotMatch(source, /\bRootFactDiff\b|\bCrossProviderConvergenceProof\b|\bverify_directive_ids\b/u);
});

test("round 9 adversarial closures are structurally executable", async () => {
  const workflow = await readFile("docs/architecture/workflow-model.md", "utf8");
  const contracts = await readFile("docs/architecture/contracts.md", "utf8");
  const rootIssue = await readFile("docs/architecture/root-issue.md", "utf8");
  const performer = await readFile("docs/architecture/performer.md", "utf8");
  const workflowRows = new Map(architectureRuleTables(workflow, "workflow-model.md")
    .flatMap((table) => table.rows)
    .map((row) => [row.Rule?.match(/\bWF-[A-Z]+-\d{3}\b/u)?.[0], row]));

  assert.equal(workflowRows.get("WF-ROUTE-018")?.Consumer, "`CycleMachine`");
  assert.match(workflowRows.get("WF-ROUTE-018")?.["Fresh facts"] ?? "", /external_cycle_terminal_without_matching_record/u);
  assert.equal(workflowRows.get("WF-ROUTE-018")?.["Root model turn"], "`no`");
  assert.match(contracts, /selected_route:\s*WF-ROUTE-018,[\s\S]*?outcome:\s*terminal_recorded,[\s\S]*?preserved_terminal_status:\s*Succeeded\s*\|\s*Rejected\s*\|\s*Failed\s*\|\s*Canceled/u);

  assert.match(contracts, /execution_directives:\s*\[ExecutionDirective,\s*\.\.\.ExecutionDirective\[\]\]/u);
  assert.match(contracts, /approved_work_groups:\s*\[ApprovedWorkGroup,\s*\.\.\.ApprovedWorkGroup\[\]\]/u);
  assert.match(contracts, /directive_ids:\s*\[DirectiveId,\s*\.\.\.DirectiveId\[\]\]/u);
  assert.match(contracts, /ordered_work_group_ids:\s*\[WorkGroupId,\s*\.\.\.WorkGroupId\[\]\]/u);
  assert.match(rootIssue, /at least one execution directive[\s\S]*at least one non-empty Work group/u);

  assert.match(workflowRows.get("WF-PERSIST-002")?.["Required content"] ?? "", /completed:/u);
  assert.match(workflowRows.get("WF-PERSIST-002")?.["Required content"] ?? "", /failed\/canceled:/u);

  for (const name of [
    "TaskMcpCall", "TaskMcpResult", "GitToolCall", "GitToolResult",
    "DeliveryToolCall", "DeliveryToolResult",
  ]) assert.match(contracts, new RegExp(`^${name}\\s*(?:=|\\{)`, "mu"));

  const stageInvalidationPending = /StageInvalidationProjectionPending<[\s\S]*?(?=```)/u
    .exec(contracts)?.[0] ?? "";
  assert.match(stageInvalidationPending, /TerminalRecordSelection<\s*never,/u);
  assert.match(stageInvalidationPending, /terminal_status:\s*Failed/u);

  assert.match(contracts, /RootFamilyInvalidationRecord\s*\{[\s\S]*?identity_derivation_version[\s\S]*?basis_issue_revision[\s\S]*?basis_status[\s\S]*?basis_document_digest/u);
  assert.match(rootIssue, /Root family invalidation[\s\S]*Root ID, record kind, derivation version/u);

  assert.doesNotMatch(contracts, /excluded from every serialization/u);
  assert.match(performer, /same live provider thread transport/u);

  for (const kind of ["unresolvable_record_slot", "sealed_fact_mutated"]) {
    assert.match(contracts, new RegExp(`\\b${kind}\\b`, "u"));
  }
});

test("round 10 adversarial closures preserve route and authority boundaries", async () => {
  const workflow = await readFile("docs/architecture/workflow-model.md", "utf8");
  const contracts = await readFile("docs/architecture/contracts.md", "utf8");
  const rows = new Map(architectureRuleTables(workflow, "workflow-model.md")
    .flatMap((table) => table.rows)
    .map((row) => [row.Rule?.match(/\bWF-[A-Z]+-\d{3}\b/u)?.[0], row]));

  assert.equal(
    rows.get("WF-ROUTE-011")?.["Fresh facts"],
    "`root_done_with_intact_active_cycle`",
  );
  assert.equal(
    rows.get("WF-ROUTE-015")?.["Fresh facts"],
    "`active_root_admission_lost_non_done_and_no_cycle_record_projection_pending`",
  );
  assert.match(contracts, /ExternalTerminalCycleObservation\s*=/u);
  assert.match(contracts, /ExternalTerminalStageObservation\s*=/u);
  assert.match(contracts, /CycleObservation\s*=\s*CycleDocument\s*\|\s*CycleTerminalMismatchObservation\s*\|\s*ExternalTerminalCycleObservation/u);
  assert.match(contracts, /cycle_document:\s*CycleObservation/u);
  assert.match(contracts, /StageObservation\s*=\s*StageDocument\s*\|\s*ExternalTerminalStageObservation\s*\|\s*InvalidStageObservation/u);

  const gitSnapshot = /GitSnapshot\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "";
  assert.doesNotMatch(gitSnapshot, /remote_ref|pull_request/iu);
  assert.match(contracts, /RemoteRefSnapshot\s*\{/u);

  assert.match(contracts, /OrderedManifestWorkNodes<CycleId>\s*=\s*branded\s*\[ManifestWorkNode<CycleId>,\s*\.\.\.ManifestWorkNode<CycleId>\[\]\]/u);
  assert.match(contracts, /ordered_work_issue_ids:\s*IssueIdsOf<ordered_work_nodes>/u);
  assert.match(contracts, /verify_issue_id:\s*typeof verify_node\.issue_id/u);
  assert.doesNotMatch(/PlanGraphManifest\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "", /\bnodes\s*:/u);
});

test("round 11 closures bind manifest ownership and preserve specific failures", async () => {
  const sources = new Map(await Promise.all([
    "README.md", "contracts.md", "root-issue.md", "workflow-model.md",
  ].map(async (file) => [file, await readFile(`docs/architecture/${file}`, "utf8")])));
  const contracts = sources.get("contracts.md");
  const workflowRows = new Map(architectureRuleTables(
    sources.get("workflow-model.md"),
    "workflow-model.md",
  ).flatMap((table) => table.rows).map((row) => [
    row.Rule?.match(/\bWF-[A-Z]+-\d{3}\b/u)?.[0],
    row,
  ]));

  assert.equal(
    workflowRows.get("WF-FAIL-015")?.Projection,
    "nonterminal affected Stage becomes `Failed`<br>terminal Stage is preserved<br>Cycle becomes `Failed`",
  );
  assert.match(contracts, /selected_route:\s*WF-ROUTE-004,[\s\S]*?terminal_status:\s*Failed/u);
  assert.match(contracts, /selected_route:\s*WF-ROUTE-011,[\s\S]*?terminal_status:\s*Canceled/u);
  assert.doesNotMatch(contracts, /selected_route:\s*WF-ROUTE-004\s*\|\s*WF-ROUTE-011,[\s\S]*?terminalized/u);

  const manifestMutations = [
    [
      "parent_issue_id: CycleId,\n  completion_record_id",
      "parent_issue_id: OtherCycleId,\n  completion_record_id",
    ],
    [
      "typeof cycle_id, typeof plan_issue_id,\n    typeof Basis.specification.plan_completion_record_id",
      "typeof cycle_id, PlanIssueId,\n    typeof Basis.specification.plan_completion_record_id",
    ],
    [
      "approval_record_id: typeof Basis.approval_record.record_id",
      "approval_record_id: ApprovalRecordId",
    ],
    [
      "issue_id: typeof Basis.specification.plan_issue_id,\n  parent_issue_id",
      "issue_id: PlanIssueId,\n  parent_issue_id",
    ],
  ];
  for (const [valid, invalid] of manifestMutations) {
    const mutated = contracts.replace(valid, invalid);
    assert.notEqual(mutated, contracts);
    const invalidSources = new Map(sources);
    invalidSources.set("contracts.md", mutated);
    assert.ok(inspectArchitectureCrossSemantics(invalidSources).some(
      (violation) => violation.code === "invalid_exact_manifest_node_contract",
    ));
  }

  const readme = sources.get("README.md");
  assert.match(readme, /Boundary map[\s\S]*?source-rules:[^\n]*WF-AUTH-008/u);
  assert.match(readme, /WF-AUTH-001` through `WF-AUTH-008/u);
});

test("round 12 closures preserve record precedence, identity binding, and Work-thread loss", async () => {
  const directory = "docs/architecture";
  const files = (await readdir(directory)).filter((file) => file.endsWith(".md"));
  const sources = new Map(await Promise.all(files.map(async (file) => [
    file,
    await readFile(`${directory}/${file}`, "utf8"),
  ])));
  const contracts = sources.get("contracts.md");
  const workflow = sources.get("workflow-model.md");

  const expectContractViolation = (mutated, code) => {
    assert.notEqual(mutated, contracts);
    const invalidSources = new Map(sources);
    invalidSources.set("contracts.md", mutated);
    assert.ok(inspectArchitectureCrossSemantics(invalidSources).some(
      (violation) => violation.code === code,
    ));
  };

  const invalidSelection = contracts.replace(
    "invalidation_record: Invalidation,\n  terminal_record: Invalidation",
    "invalidation_record: Invalidation,\n  terminal_record: SupersededCompletion",
  );
  expectContractViolation(invalidSelection, "invalid_terminal_record_selection_contract");

  const missingMismatchObservation = contracts.replace(
    "terminal_selection: NoTerminalRecordSelection,\n" +
      "  completion_record_observation: CompletionObservation | null,",
    "terminal_selection: TerminalRecordSelection<unknown, unknown, unknown>,\n" +
      "  completion_record_observation: CompletionObservation | null,",
  );
  expectContractViolation(
    missingMismatchObservation,
    "unconstructible_external_terminal_route_input",
  );

  for (const equality of [
    "record_id: typeof specification.approval_record_id",
    "issue_id: typeof specification.cycle_id",
    "cycle_id: typeof specification.cycle_id",
    "identity_derivation_version: typeof specification.identity_derivation_version",
    "predecessor_cycle_issue_id: typeof specification.predecessor_cycle_issue_id",
    "predecessor_terminal_record_id: typeof specification.predecessor_terminal_record_id",
    "plan_issue_id: typeof specification.plan_issue_id",
    "plan_completion_record_id: typeof specification.plan_completion_record_id",
    "plan_invalidation_record_id: typeof specification.plan_invalidation_record_id",
    "cycle_completion_record_id: typeof specification.cycle_completion_record_id",
    "cycle_invalidation_record_id: typeof specification.cycle_invalidation_record_id",
    "delivery_completion_record_id: typeof specification.delivery_completion_record_id",
    "delivery_invalidation_record_id: typeof specification.delivery_invalidation_record_id",
    "specification_seal_digest: typeof specification.specification_seal_digest",
    "workspace_base_revision: typeof specification.workspace_base_revision",
  ]) {
    expectContractViolation(
      contracts.replace(equality, `${equality.split(":", 1)[0]}: ForeignAnchor`),
      "invalid_exact_manifest_node_contract",
    );
  }

  const approvalAnchorMissing = contracts.replace(
    "plan_issue_id, plan_completion_record_id, plan_invalidation_record_id,",
    "plan_issue_id, plan_completion_record_id,",
  );
  expectContractViolation(approvalAnchorMissing, "incomplete_cycle_anchor_contract");

  const specificationStart = contracts.indexOf("CycleSpecification {");
  const beforeSpecification = contracts.slice(0, specificationStart);
  const specification = contracts.slice(specificationStart).replace(
    "plan_completion_record_id, plan_invalidation_record_id,",
    "plan_completion_record_id,",
  );
  expectContractViolation(
    `${beforeSpecification}${specification}`,
    "incomplete_cycle_anchor_contract",
  );

  const completionIdentity = [
    "record_id: RecordId, issue_id: StageId, cycle_id: CycleId,",
    "    stage_id: StageId, basis_status: In Progress, completion: C",
  ].join("\n");
  for (const [field, replacement] of [
    ["record_id: RecordId", "record_id: OtherRecordId"],
    ["issue_id: StageId", "issue_id: OtherStageId"],
    ["cycle_id: CycleId", "cycle_id: OtherCycleId"],
    ["stage_id: StageId", "stage_id: OtherStageId"],
  ]) {
    expectContractViolation(
      contracts.replace(completionIdentity, completionIdentity.replace(field, replacement)),
      "invalid_exact_manifest_node_contract",
    );
  }

  const foreignRelationEndpoint = contracts.replace(
    "target_issue_id: typeof WorkNodeFor<dependent_work_group_id, Works>.issue_id",
    "target_issue_id: WorkIssueId",
  );
  expectContractViolation(
    foreignRelationEndpoint,
    "incomplete_manifest_dependency_relation_contract",
  );

  for (const field of [
    "context_observation: CycleContextObservation",
    "input_context_observation_digest",
  ]) {
    expectContractViolation(
      contracts.replace(field, `removed_${field}`),
      "invalid_cycle_advance_contract",
    );
  }

  const invalidPrecedence = workflow.replace(
    "invalidation; retain completion slot as superseded evidence",
    "completion",
  );
  assert.notEqual(invalidPrecedence, workflow);
  assert.ok(inspectWorkflowRuleSemantics(new Map([[
    "workflow-model.md",
    invalidPrecedence,
  ]])).some((violation) => violation.code === "invalid_terminal_record_precedence"));

  const unsafeRestart = workflow.replace(
    "apply `WF-FAIL-018`, then `WF-TR-008`",
    "dispatch next Work",
  );
  assert.notEqual(unsafeRestart, workflow);
  assert.ok(inspectWorkflowRuleSemantics(new Map([[
    "workflow-model.md",
    unsafeRestart,
  ]])).some((violation) =>
    violation.target === "WF-RESTART-004.Restart action"));
});

test("round 13 closures keep invalid facts and runtime loss mechanically routable", async () => {
  const directory = "docs/architecture";
  const files = (await readdir(directory)).filter((file) => file.endsWith(".md"));
  const sources = new Map(await Promise.all(files.map(async (file) => [
    file,
    await readFile(`${directory}/${file}`, "utf8"),
  ])));
  const contracts = sources.get("contracts.md");
  const workflow = sources.get("workflow-model.md");

  const expectContractViolation = (mutated, code) => {
    assert.notEqual(mutated, contracts);
    const invalidSources = new Map(sources);
    invalidSources.set("contracts.md", mutated);
    assert.ok(inspectArchitectureCrossSemantics(invalidSources).some(
      (violation) => violation.code === code,
    ));
  };

  expectContractViolation(contracts.replace(
    "    CycleAnyCompletionRecord<Basis>,\n" +
      "    CycleTypedInvalidationRecord<Basis, Invalidation>",
    "    CycleTypedCompletionRecord<Basis, SelectedCompletion>,\n" +
      "    CycleTypedInvalidationRecord<Basis, Invalidation>",
  ), "invalid_cycle_document_terminal_mapping");

  expectContractViolation(contracts.replace(
    "record_id: typeof Basis.specification.cycle_completion_record_id,",
    "record_id: ForeignCompletionRecordId,",
  ), "invalid_cycle_document_terminal_mapping");

  expectContractViolation(contracts.replace(
    "} branded with status != terminal_record_observation.expected_source_status",
    "}",
  ), "invalid_cycle_observation_contract");

  const stageSourceMismatch = contracts.lastIndexOf(
    "} branded with status != terminal_record_observation.expected_source_status",
  );
  assert.notEqual(stageSourceMismatch, -1);
  expectContractViolation(
    contracts.slice(0, stageSourceMismatch) + "}" + contracts.slice(
      stageSourceMismatch +
        "} branded with status != terminal_record_observation.expected_source_status".length,
    ),
    "invalid_stage_document_terminal_mapping",
  );

  expectContractViolation(contracts.replace(
    "revision, observed_cycle_document_digest,",
    "revision,",
  ), "invalid_cycle_observation_contract");

  expectContractViolation(contracts.replace(
    "completion_record_id, invalidation_record_id, instruction_digest",
    "completion_record_id, instruction_digest",
  ), "invalid_stage_document_terminal_mapping");

  expectContractViolation(contracts.replace(
    "StageObservation = StageDocument | ExternalTerminalStageObservation |\n" +
      "                   InvalidStageObservation",
    "StageObservation = StageDocument | ExternalTerminalStageObservation",
  ), "invalid_stage_document_terminal_mapping");

  expectContractViolation(contracts.replace(
    "state: lost_during_active_stage,",
    "state: lost_during_unknown_stage,",
  ), "invalid_cycle_advance_contract");

  expectContractViolation(contracts.replace(
    "cycle_document: CycleObservation,",
    "cycle_document: CycleDocument,",
  ), "unconstructible_external_terminal_route_input");

  const unsafeProjection = workflow.replace(
    "wrong source -> `WF-FAIL-006`",
    "wrong source -> project target",
  );
  assert.notEqual(unsafeProjection, workflow);
  assert.ok(inspectWorkflowRuleSemantics(new Map([[
    "workflow-model.md",
    unsafeProjection,
  ]])).some((violation) => violation.target === "WF-RESTART-002.Restart action"));
});

test("round 14 closures cover projection, fencing, mutation basis, and cleanup", async () => {
  const directory = "docs/architecture";
  const files = (await readdir(directory)).filter((file) => file.endsWith(".md"));
  const sources = new Map(await Promise.all(files.map(async (file) => [
    file,
    await readFile(`${directory}/${file}`, "utf8"),
  ])));
  const contracts = sources.get("contracts.md");
  const workflow = sources.get("workflow-model.md");

  const expectContractViolation = (mutated, code) => {
    assert.notEqual(mutated, contracts);
    const invalidSources = new Map(sources);
    invalidSources.set("contracts.md", mutated);
    assert.ok(inspectArchitectureCrossSemantics(invalidSources).some(
      (violation) => violation.code === code,
    ));
  };
  const expectWorkflowViolation = (mutated, target) => {
    assert.notEqual(mutated, workflow);
    assert.ok(inspectWorkflowRuleSemantics(new Map([[
      "workflow-model.md",
      mutated,
    ]])).some((violation) => violation.target === target));
  };

  expectWorkflowViolation(workflow.replace(
    "| `WF-TR-012` | `Stage` | `Todo,In Progress` |",
    "| `WF-TR-012` | `Stage` | `In Progress` |",
  ), "WF-TR-012.From");

  expectContractViolation(contracts.replace(
    "| StageInvalidationProjectionPending<\n" +
      "  Todo, CycleId, StageId, CompletionRecordId, InvalidationRecordId,",
    "| StageInvalidationProjectionPending<\n" +
      "  In Progress, CycleId, StageId, CompletionRecordId, InvalidationRecordId,",
  ), "invalid_stage_document_terminal_mapping");

  expectContractViolation(contracts.replace(
    "projection_state: terminal_status_mismatch,",
    "projection_state: terminal_source_mismatch,",
  ), "invalid_cycle_observation_contract");

  const stageStatusMismatch = contracts.lastIndexOf(
    "} branded with status != terminal_record_observation.record_terminal_status",
  );
  assert.notEqual(stageStatusMismatch, -1);
  expectContractViolation(
    contracts.slice(0, stageStatusMismatch) + "}" + contracts.slice(
      stageStatusMismatch +
        "} branded with status != terminal_record_observation.record_terminal_status".length,
    ),
    "invalid_stage_document_terminal_mapping",
  );

  expectWorkflowViolation(workflow.replace(
    "selected invalidation -> never replace it",
    "selected invalidation -> write replacement invalidation",
  ), "WF-FAIL-006.Required write");

  const missingInvalidCompletionRow = workflow.replace(
    "| invalid observation | absent | no selection; record kind and phase choose `WF-FAIL-008` or `WF-FAIL-015` |\n",
    "",
  );
  assert.notEqual(missingInvalidCompletionRow, workflow);
  assert.ok(inspectWorkflowRuleSemantics(new Map([[
    "workflow-model.md",
    missingInvalidCompletionRow,
  ]])).some((violation) => violation.code === "invalid_terminal_record_precedence"));

  expectContractViolation(contracts.replace(
    "runtime_generation, correlation_id\n}",
    "correlation_id\n}",
  ), "unfenced_role_envelope");
  expectContractViolation(contracts.replace(
    "  input_request_digest\n}",
    "  request_digest_removed\n}",
  ), "unfenced_role_envelope");

  const invalidCleanup = new Map(sources);
  invalidCleanup.set("conductor.md", sources.get("conductor.md").replace(
    "no non-terminal Cycle、no dispatched open Stage and no delivery gap",
    "no non-terminal Cycle、all Stage statuses terminal and no delivery gap",
  ));
  assert.notEqual(invalidCleanup.get("conductor.md"), sources.get("conductor.md"));
  assert.ok(inspectArchitectureCrossSemantics(invalidCleanup).some(
    (violation) => violation.code === "invalid_terminal_cycle_cleanup_gate",
  ));

  expectContractViolation(contracts.replace(
    "resource_id: ResourceId, revision",
    "revision",
  ), "unbound_task_mutation_basis");
  expectContractViolation(contracts.replace(
    "destination: TaskMutationBasis<TargetId>",
    "destination: TaskMutationBasis<SourceId>",
  ), "unbound_task_mutation_basis");

  expectContractViolation(contracts.replace(
    "priority | archived | trashed | relation",
    "priority | archived | relation",
  ), "incomplete_grouped_history_contract");
});

test("round 15 closures separate terminal observations and preserve routing ownership", async () => {
  const directory = "docs/architecture";
  const files = (await readdir(directory)).filter((file) => file.endsWith(".md"));
  const sources = new Map(await Promise.all(files.map(async (file) => [
    file,
    await readFile(`${directory}/${file}`, "utf8"),
  ])));
  const contracts = sources.get("contracts.md");
  const workflow = sources.get("workflow-model.md");

  const expectContractViolation = (mutated, code) => {
    assert.notEqual(mutated, contracts);
    const invalidSources = new Map(sources);
    invalidSources.set("contracts.md", mutated);
    assert.ok(inspectArchitectureCrossSemantics(invalidSources).some(
      (violation) => violation.code === code,
    ));
  };
  const expectWorkflowViolation = (mutated, target) => {
    assert.notEqual(mutated, workflow);
    assert.ok(inspectWorkflowRuleSemantics(new Map([[
      "workflow-model.md",
      mutated,
    ]])).some((violation) => violation.target === target));
  };

  expectContractViolation(contracts.replace(
    "stage_id: StageId, basis_status: In Progress, completion: C",
    "stage_id: StageId, completion: C",
  ), "invalid_stage_document_terminal_mapping");
  expectContractViolation(contracts.replace(
    "CycleId, StageId, RecordId, Todo | In Progress, StageInvalidationRecord",
    "CycleId, StageId, RecordId, In Progress, StageInvalidationRecord",
  ), "invalid_stage_document_terminal_mapping");

  expectContractViolation(contracts.replace(
    "ExternalTerminalRecordSetObservation<\n" +
      "    InvalidCompletionRecordObservation & {",
    "ExternalTerminalRecordSetObservation<\n" +
      "    CycleTerminalRecordStatusMismatch & {",
  ), "unconstructible_external_terminal_route_input");

  expectContractViolation(contracts.replace(
    "    expected_record_kind: stage_completion\n" +
      "  },\n  invalidation_record_observation: null\n" +
      "}\nInvalidStageObservation =",
    "    expected_record_kind: stage_completion\n" +
      "  }\n}\nInvalidStageObservation =",
  ), "invalid_stage_document_terminal_mapping");

  for (const rule of ["WF-FAIL-004", "WF-FAIL-005", "WF-FAIL-006"]) {
    const mutated = workflow.split("\n").map((line) =>
      line.startsWith(`| \`${rule}\` |`)
        ? line.replace("selected invalidation conflict -> `WF-ROUTE-016`", "permanent quarantine")
        : line).join("\n");
    expectWorkflowViolation(mutated, `${rule}.Resolution`);
  }

  const narrowedCleanup = new Map(sources);
  narrowedCleanup.set("git-worktree-delivery.md", sources.get("git-worktree-delivery.md").replace(
    "global cleanup eligibility remains Conductor-owned",
    "delivery finalizer owns global cleanup eligibility",
  ));
  assert.notEqual(narrowedCleanup.get("git-worktree-delivery.md"), sources.get("git-worktree-delivery.md"));
  assert.ok(inspectArchitectureCrossSemantics(narrowedCleanup).some(
    (violation) => violation.code === "invalid_terminal_cycle_cleanup_gate",
  ));
});

test("mechanical routes, terminal evidence, and manifest relations are closed contracts", async () => {
  const contracts = await readFile("docs/architecture/contracts.md", "utf8");
  const taskManagement = await readFile("docs/architecture/task-management.md", "utf8");
  const rootIssue = await readFile("docs/architecture/root-issue.md", "utf8");

  assert.match(
    contracts,
    /RootSemanticSnapshot\s*\{[\s\S]*?task:\s*TaskSnapshot,\s*git:\s*GitSnapshot,[\s\S]*?routing:\s*RootRoutingDisposition\s*&\s*\{\s*disposition:\s*root_boundary\s*\}/u,
  );
  assert.match(
    contracts,
    /disposition:\s*cycle_machine,\s*selected_route:\s*WF-ROUTE-003\s*\|\s*WF-ROUTE-004\s*\|\s*WF-ROUTE-006\s*\|\s*WF-ROUTE-011\s*\|\s*WF-ROUTE-015\s*\|\s*WF-ROUTE-017\s*\|\s*WF-ROUTE-018,/u,
  );
  assert.match(
    contracts,
    /CycleAdvanceRequest\s*\{[\s\S]*?selected_route:\s*WF-ROUTE-003\s*\|\s*WF-ROUTE-004\s*\|\s*WF-ROUTE-006\s*\|\s*WF-ROUTE-011\s*\|\s*WF-ROUTE-015\s*\|\s*WF-ROUTE-017\s*\|\s*WF-ROUTE-018,[\s\S]*?execution_snapshot:\s*CycleExecutionSnapshot/u,
  );
  assert.match(contracts, /WorkCompletionEvidence\s*\{[\s\S]*?normalized_handoff_markdown[\s\S]*?\}/u);
  assert.match(contracts, /VerifyCompletionEvidence\s*\{[\s\S]*?evidence_markdown[\s\S]*?\}/u);
  assert.match(contracts, /ManifestDependencyRelation<Works,\s*VerifyId>\s*=/u);
  const invalidRecordRouting = architectureRuleTables(taskManagement, "task-management.md")
    .find((table) => table.headers.includes("Invalid record observation"));
  assert.deepEqual(invalidRecordRouting?.rows, [{
    "Invalid record observation": "missing",
    "Failure selection": "`WF-FAIL-001` through `WF-FAIL-003`",
  }, {
    "Invalid record observation": "malformed、updated or archived",
    "Failure selection": "record kind and phase select `WF-FAIL-008`, `WF-FAIL-009`, `WF-FAIL-011` or `WF-FAIL-015`",
  }]);
  assert.match(
    rootIssue,
    /one exact `blocks` relation per Work dependency[\s\S]*one Verify barrier per Work[\s\S]*no extra relation/u,
  );
  assert.match(
    rootIssue,
    /Plan record provider time is earlier than every materialized Work、Verify and relation provider time/u,
  );
});

test("invalidation, quarantine, and turn outcomes are fully discriminated", async () => {
  const contracts = await readFile("docs/architecture/contracts.md", "utf8");
  const taskPlan = await readFile("tasks/plan.md", "utf8");

  assert.match(
    contracts,
    /CycleInvalidationRecordCommon\s*=[\s\S]*?observed_execution_graph_digest,[\s\S]*?offending_resources:\s*\[CycleInvalidationResourceEvidence,[\s\S]*?CycleInvalidationResourceEvidence\[\]\]/u,
  );
  for (const evidenceKind of [
    "present_digest_mismatch",
    "present_relation_mismatch",
    "unexpected_resource",
    "missing_manifest_resource",
    "authoritative_body_lost",
  ]) assert.match(contracts, new RegExp(`evidence_kind:\\s*${evidenceKind}`, "u"));
  assert.match(contracts, /DraftFailedCycleCompletion\s*=\s*DraftTerminalCycleEvidence\s*&\s*\{\s*outcome:\s*failed\s*\}/u);
  assert.match(contracts, /DraftCanceledCycleCompletion\s*=\s*DraftTerminalCycleEvidence\s*&\s*\{\s*outcome:\s*canceled\s*\}/u);
  assert.match(contracts, /InProgressFailedCycleCompletion\s*=\s*InProgressTerminalCycleEvidence\s*&\s*\{\s*outcome:\s*failed\s*\}/u);
  assert.match(contracts, /InProgressCanceledCycleCompletion\s*=\s*InProgressTerminalCycleEvidence\s*&\s*\{\s*outcome:\s*canceled\s*\}/u);
  assert.doesNotMatch(contracts, /DraftFailedCycleCompletion\s*\|\s*DraftCanceledCycleCompletion\s*\{/u);
  assert.match(contracts, /selected_failure:\s*WF-FAIL-009,[\s\S]*?reason_code:\s*invalid_invalidation_record/u);
  assert.match(contracts, /selected_failure:\s*WF-FAIL-010,[\s\S]*?reason_code:\s*multiple_non_terminal_cycles/u);
  assert.match(contracts, /selected_failure:\s*WF-FAIL-013,[\s\S]*?reason_code:\s*unsupported_external_destruction/u);
  assert.match(contracts, /selected_failure:\s*WF-FAIL-017,[\s\S]*?reason_code:\s*incomplete_known_identity_evidence/u);
  assert.doesNotMatch(contracts, /reason_code:[^\n]*invalid_delivery_record/u);
  assert.match(contracts, /RootTurnOutcomeCommon\s*\{[\s\S]*?input_task_digest[\s\S]*?\}/u);
  assert.match(contracts, /RootTurnOutcome\s*=\s*RootTurnOutcomeCommon\s*&/u);
  assert.match(contracts, /outcome:\s*draft_closed,[\s\S]*?selected_route:\s*WF-ROUTE-002,[\s\S]*?closure_status:\s*Failed\s*\|\s*Canceled/u);
  assert.match(contracts, /outcome:\s*acceptance_closed,[\s\S]*?selected_route:\s*WF-ROUTE-007,[\s\S]*?closure_status:\s*Rejected\s*\|\s*Canceled/u);
  assert.match(contracts, /selected_route:\s*WF-ROUTE-015,[\s\S]*?outcome:\s*terminalized,[\s\S]*?terminal_status:\s*Canceled/u);
  assert.match(contracts, /ConductorActionRequest\s*=\s*ConductorActionRequestCommon\s*&/u);
  assert.match(contracts, /ConductorActionResult\s*=\s*ConductorActionResultCommon\s*&/u);
  assert.match(contracts, /CycleTerminalProjectionPending/u);
  assert.doesNotMatch(taskPlan, /Root writes `invalid_terminal`/u);
});

test("cross-contract audit rejects a valid declaration shadowed in another fence", async () => {
  const directory = "docs/architecture";
  const files = (await readdir(directory)).filter((file) => file.endsWith(".md"));
  const sources = new Map(await Promise.all(files.map(async (file) => [
    file,
    await readFile(`${directory}/${file}`, "utf8"),
  ])));
  const contracts = sources.get("contracts.md");
  const declaration = /RootTurnOutcomeCommon\s*\{[\s\S]*?\n\)/u.exec(contracts)?.[0];
  assert.ok(declaration);
  const mutated = contracts.replace("outcome: quiescent", "outcome: shadowed_quiescent") +
    `\n\n\`\`\`text\n${declaration}\n\`\`\`\n`;
  sources.set("contracts.md", mutated);
  assert.ok(inspectArchitectureCrossSemantics(sources).some(
    (violation) => violation.code === "duplicate_contract_declaration" ||
      violation.code === "missing_root_turn_outcome_contract",
  ));
});

test("roadmap maps implementation and E2E scope to architecture rules", async () => {
  const source = await readFile("docs/architecture/roadmap.md", "utf8");
  const tables = architectureRuleTables(source, "roadmap.md");
  const ruleIds = new Set(tables.flatMap((table) => table.rows)
    .map((row) => row.Rule?.match(/\b[A-Z]{2}(?:-[A-Z][A-Z0-9]*)*-\d{3}\b/u)?.[0])
    .filter(Boolean));

  for (const id of [
    "RM-SEQ-001", "RM-SEQ-009",
    "RM-E2E-001", "RM-E2E-009",
    "RM-NON-001", "RM-NON-006",
    "RM-GATE-001", "RM-GATE-005",
  ]) {
    assert.ok(ruleIds.has(id), `missing roadmap rule ${id}`);
  }
});

test("architecture vocabulary excludes superseded guarantees and scheduling scope", async () => {
  const directory = "docs/architecture";
  const files = (await readdir(directory)).filter((file) => file.endsWith(".md"));
  const source = (await Promise.all(files.map((file) => readFile(`${directory}/${file}`, "utf8"))))
    .join("\n");

  assert.doesNotMatch(
    source,
    /joint fresh read|joint read|joint-read|tamper-evident|串行处理两个Roots|多Root串行scheduling/u,
  );
});
