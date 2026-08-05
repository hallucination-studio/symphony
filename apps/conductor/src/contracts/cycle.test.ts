import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseTaskRevision,
} from "./identity.js";
import {
  parseCycleAdvanceResult,
  parseCycleDraftMarkdown,
  parseCycleExecutionSnapshot,
  parseCycleSpecification,
  parsePlanGraph,
  parseRootDefinition,
  parseSealedExecutionGraph,
  sealCycleSpecification,
} from "./cycle.js";
import { markdownSemanticallyEqual, MAX_MARKDOWN_TEXT_LENGTH, parseMarkdownText } from "./validation.js";
import { canonicalTaskRevision } from "./task-management.js";

const rootTarget = Object.freeze({
  root_id: parseRootIssueId("LIN-ROOT"),
  root_revision: parseTaskRevision("revision:root:1"),
  correlation_id: parseCorrelationId("corr:root:1"),
});

const rootDescription = [
  "# Delivery Root",
  "",
  "## Requirement",
  "",
  "Deliver the approved immutable Cycle workflow.",
  "",
  "## Domain Knowledge",
  "",
  "Task Manager and Git are the durable fact authorities.",
  "",
  "## Root ADR",
  "",
  "Keep semantic decisions at Cycle boundaries.",
  "",
  "## Acceptance",
  "",
  "The exact verified revision reaches one reviewable PR.",
].join("\n");

const rootSource = {
  schema_version: 1,
  ...rootTarget,
  root_description_markdown: rootDescription,
};

function parsedRootDefinition() {
  return parseRootDefinition(structuredClone(rootSource), rootTarget);
}

test("MarkdownText accepts visible bounded Markdown and rejects hidden control or credential material", () => {
  assert.equal(parseMarkdownText("## Design\n\nUse a closed typed contract."), "## Design\n\nUse a closed typed contract.");
  const deeplyNestedMarkdown = `${"> ".repeat(10_000)}Visible text`;
  assert.equal(parseMarkdownText(deeplyNestedMarkdown), deeplyNestedMarkdown);

  for (const invalid of [
    "",
    " \n\t ",
    "contains\0nul",
    "unpaired \ud800 surrogate",
    "{\"next_action\":\"mutate\"}",
    "<!-- {\"runtime_generation\":4} -->\nVisible text",
    "Authorization: Bearer provider-token-value",
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "Cookie: session=provider-session-value",
    "-----BEGIN PRIVATE KEY-----\nnot-a-real-key",
    "x".repeat(MAX_MARKDOWN_TEXT_LENGTH + 1),
  ]) {
    assert.throws(() => parseMarkdownText(invalid), /invalid_markdown_text/u);
  }
});

test("Markdown semantic equality ignores provider blank-line formatting but preserves content", () => {
  assert.equal(
    markdownSemanticallyEqual("## Design\n\n- one\n- two\n\nBody.", "## Design\n\n- one\n\n- two\n\n\nBody."),
    true,
  );
  assert.equal(markdownSemanticallyEqual("## Design\n\nBody one.", "## Design\n\nBody two."), false);
});

test("RootDefinition is derived from one closed Root description document", () => {
  const parsed = parsedRootDefinition();

  assert.equal(parsed.root_id, rootTarget.root_id);
  assert.equal(parsed.root_revision, rootTarget.root_revision);
  assert.equal(parsed.correlation_id, rootTarget.correlation_id);
  assert.match(parsed.requirement_markdown, /^## Requirement[\s\S]+## Domain Knowledge/u);
  assert.match(parsed.root_adr_markdown, /^## Root ADR[\s\S]+Cycle boundaries\.$/u);
  assert.match(parsed.acceptance_markdown, /^## Acceptance[\s\S]+reviewable PR\.$/u);
  assert.ok(Object.isFrozen(parsed));

  for (const extra of [
    { metadata: {} },
    { provider_receipt: { id: "provider-1" } },
    { task_manager_token: "not-a-token" },
    { runtime_state: { next_action: "continue" } },
  ]) {
    assert.throws(
      () => parseRootDefinition({ ...rootSource, ...extra }, rootTarget),
      /invalid_contract_keys/u,
    );
  }
});

test("RootDefinition rejects missing, reordered, duplicate, extra, or empty closed sections", () => {
  const reordered = rootDescription.replace(
    [
      "## Domain Knowledge",
      "",
      "Task Manager and Git are the durable fact authorities.",
      "",
      "## Root ADR",
      "",
      "Keep semantic decisions at Cycle boundaries.",
    ].join("\n"),
    [
      "## Root ADR",
      "",
      "Keep semantic decisions at Cycle boundaries.",
      "",
      "## Domain Knowledge",
      "",
      "Task Manager and Git are the durable fact authorities.",
    ].join("\n"),
  );
  const invalidDescriptions = [
    rootDescription.replace("## Domain Knowledge", "## Context"),
    reordered,
    `${rootDescription}\n\n## Notes\n\nUnapproved section.`,
    rootDescription.replace(
      "Task Manager and Git are the durable fact authorities.",
      "Task Manager and Git are the durable fact authorities.\n\n# Runtime State\n\nUnapproved control text.",
    ),
    rootDescription.replace(
      "Task Manager and Git are the durable fact authorities.",
      "Visible [runtime details][runtime].\n\n[runtime]: data:application/json,%7B%22next_action%22%3A%22mutate%22%7D",
    ),
    rootDescription.replace(
      "Task Manager and Git are the durable fact authorities.",
      "> Visible [runtime details][runtime].\n>\n> [runtime]: data:application/json,%7B%22next_action%22%3A%22mutate%22%7D",
    ),
    rootDescription.replace("Keep semantic decisions at Cycle boundaries.", "---"),
    rootDescription.replace("Keep semantic decisions at Cycle boundaries.", ""),
    `Preamble outside the schema.\n\n${rootDescription}`,
  ];

  for (const root_description_markdown of invalidDescriptions) {
    assert.throws(
      () => parseRootDefinition({ ...rootSource, root_description_markdown }, rootTarget),
      /invalid_root_definition_markdown/u,
    );
  }

  assert.throws(
    () => parseRootDefinition({ ...rootSource, root_revision: "revision:root:2" }, rootTarget),
    /root_definition_target_mismatch/u,
  );
  assert.throws(
    () => parseRootDefinition({ ...rootSource, correlation_id: "corr:other" }, rootTarget),
    /root_definition_correlation_mismatch/u,
  );
});

test("RootDefinition validates deeply nested visible section content without recursion failure", () => {
  const nestedRequirement = `${"> ".repeat(10_000)}Deliver the approved immutable Cycle workflow.`;
  const parsed = parseRootDefinition({
    ...rootSource,
    root_description_markdown: rootDescription.replace(
      "Deliver the approved immutable Cycle workflow.",
      nestedRequirement,
    ),
  }, rootTarget);

  assert.equal(parsed.requirement_markdown.includes(nestedRequirement), true);
});

const cycleTarget = Object.freeze({
  root_id: rootTarget.root_id,
  cycle_id: parseCycleIssueId("LIN-CYCLE"),
  root_definition_revision: rootTarget.root_revision,
  cycle_revision: parseTaskRevision("revision:cycle:seal"),
  correlation_id: parseCorrelationId("corr:cycle:seal"),
});

const cycleDescription = [
  "# Cycle Draft",
  "",
  "## Root Definition Revision",
  "",
  "`revision:root:1`",
  "",
  "## Requirement",
  "",
  "Deliver the approved immutable Cycle workflow.",
  "",
  "## Domain Knowledge",
  "",
  "Task Manager and Git are the durable fact authorities.",
  "",
  "## Root ADR",
  "",
  "Keep semantic decisions at Cycle boundaries.",
  "",
  "## Acceptance",
  "",
  "The exact verified revision reaches one reviewable PR.",
  "",
  "## Architecture",
  "",
  "Keep semantic approval in Root and mechanical execution in Conductor.",
  "",
  "## Feature Design",
  "",
  "Define, review, and approve one complete Cycle Draft.",
  "",
  "## Code Design",
  "",
  "Validate closed Markdown before every Root mutation.",
  "",
  "## Boundaries",
  "",
  "Root can update only the Root definition or an unapproved Draft.",
  "",
  "## Acceptance Mapping",
  "",
  "Map the Root acceptance criterion to exact revision and seal checks.",
  "",
  "## Failure Strategy",
  "",
  "Fail closed on malformed Markdown, stale revisions, or read-back mismatch.",
].join("\n");

function unsealedCycleSpecification() {
  return {
    schema_version: 1,
    ...cycleTarget,
    cycle_description_markdown: cycleDescription,
    root_adr_markdown: parsedRootDefinition().root_adr_markdown,
    status: "in_progress",
  };
}

function sealedCycleSpecification() {
  return sealCycleSpecification(
    unsealedCycleSpecification(),
    parsedRootDefinition(),
    cycleTarget,
  );
}

test("CycleSpecification seal binds exact Root/Cycle revisions and the pinned Root ADR", () => {
  const sealed = sealedCycleSpecification();
  const parsed = parseCycleSpecification(structuredClone(sealed), cycleTarget);

  assert.deepEqual(parsed, sealed);
  assert.match(parsed.seal_digest, /^[0-9a-f]{64}$/u);
  assert.equal(parsed.root_adr_markdown, parsedRootDefinition().root_adr_markdown);
  assert.ok(Object.isFrozen(parsed));

  assert.throws(
    () => sealCycleSpecification(
      { ...unsealedCycleSpecification(), root_adr_markdown: "## Root ADR\n\nA different decision." },
      parsedRootDefinition(),
      cycleTarget,
    ),
    /cycle_root_adr_mismatch/u,
  );
  assert.throws(
    () => sealCycleSpecification(
      { ...unsealedCycleSpecification(), root_definition_revision: "revision:root:other" },
      parsedRootDefinition(),
      cycleTarget,
    ),
    /cycle_specification_target_mismatch/u,
  );
});

test("Cycle Draft Markdown is a complete closed decision snapshot", () => {
  const parsed = parseCycleDraftMarkdown(cycleDescription);

  assert.equal(parsed.root_definition_revision, rootTarget.root_revision);
  assert.equal(parsed.requirement_markdown, parsedRootDefinition().requirement_markdown);
  assert.equal(parsed.root_adr_markdown, parsedRootDefinition().root_adr_markdown);
  assert.equal(parsed.acceptance_markdown, parsedRootDefinition().acceptance_markdown);
  assert.match(parsed.architecture_markdown, /^## Architecture[\s\S]+Conductor\.$/u);
  assert.match(parsed.feature_design_markdown, /^## Feature Design[\s\S]+Draft\.$/u);
  assert.match(parsed.code_design_markdown, /^## Code Design[\s\S]+mutation\.$/u);
  assert.match(parsed.boundaries_markdown, /^## Boundaries[\s\S]+Draft\.$/u);
  assert.match(parsed.acceptance_mapping_markdown, /^## Acceptance Mapping[\s\S]+checks\.$/u);
  assert.match(parsed.failure_strategy_markdown, /^## Failure Strategy[\s\S]+mismatch\.$/u);
  assert.ok(Object.isFrozen(parsed));
});

test("Cycle Draft Markdown rejects missing, reordered, duplicate, extra, or empty sections", () => {
  const architecture = [
    "## Architecture",
    "",
    "Keep semantic approval in Root and mechanical execution in Conductor.",
  ].join("\n");
  const feature = [
    "## Feature Design",
    "",
    "Define, review, and approve one complete Cycle Draft.",
  ].join("\n");
  const invalidDescriptions = [
    cycleDescription.replace("`revision:root:1`", "revision:root:1"),
    cycleDescription.replace("## Failure Strategy", "## Recovery"),
    cycleDescription.replace(`${architecture}\n\n${feature}`, `${feature}\n\n${architecture}`),
    `${cycleDescription}\n\n## Notes\n\nUnapproved section.`,
    cycleDescription.replace(
      "Keep semantic approval in Root and mechanical execution in Conductor.",
      "Keep semantic approval in Root and mechanical execution in Conductor.\n\n# Runtime State\n\nUnapproved control text.",
    ),
    cycleDescription.replace(
      "Fail closed on malformed Markdown, stale revisions, or read-back mismatch.",
      "",
    ),
    cycleDescription.replace(
      "Keep semantic approval in Root and mechanical execution in Conductor.",
      "[hidden]: data:application/json,%7B%22next_action%22%3A%22mutate%22%7D",
    ),
    cycleDescription.replace(
      "Keep semantic approval in Root and mechanical execution in Conductor.",
      "Visible [runtime details][runtime].\n\n[runtime]: data:application/json,%7B%22next_action%22%3A%22mutate%22%7D",
    ),
    cycleDescription.replace(
      "Keep semantic approval in Root and mechanical execution in Conductor.",
      "---",
    ),
    `Preamble outside the schema.\n\n${cycleDescription}`,
  ];

  for (const description of invalidDescriptions) {
    assert.throws(() => parseCycleDraftMarkdown(description), /invalid_cycle_draft_markdown/u);
  }
});

test("Cycle sealing rejects Requirement, ADR, or Acceptance snapshot drift", () => {
  const changes = [
    ["Deliver the approved immutable Cycle workflow.", "Deliver a different workflow."],
    ["Keep semantic decisions at Cycle boundaries.", "Move decisions into execution."],
    ["The exact verified revision reaches one reviewable PR.", "Any revision may be delivered."],
  ] as const;

  for (const [before, after] of changes) {
    assert.throws(
      () => sealCycleSpecification(
        {
          ...unsealedCycleSpecification(),
          cycle_description_markdown: cycleDescription.replace(before, after),
        },
        parsedRootDefinition(),
        cycleTarget,
      ),
      /cycle_(?:(?:requirement|root_adr|acceptance)_snapshot|root_adr)_mismatch/u,
    );
  }

  assert.throws(
    () => sealCycleSpecification(
      {
        ...unsealedCycleSpecification(),
        cycle_description_markdown: cycleDescription.replace(
          "`revision:root:1`",
          "`revision:root:other`",
        ),
      },
      parsedRootDefinition(),
      cycleTarget,
    ),
    /cycle_root_revision(?:_snapshot)?_mismatch/u,
  );
});

test("Cycle sealing snapshots an untrusted description accessor exactly once", () => {
  let descriptionReads = 0;
  const changingDescription = cycleDescription
    .replace("Deliver the approved immutable Cycle workflow.", "EVIL requirement.")
    .replace("The exact verified revision reaches one reviewable PR.", "NOPE acceptance.");
  const value = {
    ...unsealedCycleSpecification(),
    get cycle_description_markdown() {
      descriptionReads += 1;
      return descriptionReads === 1 ? cycleDescription : changingDescription;
    },
  };

  const sealed = sealCycleSpecification(value, parsedRootDefinition(), cycleTarget);

  assert.equal(descriptionReads, 1);
  assert.equal(sealed.cycle_description_markdown, cycleDescription);
});

test("CycleSpecification rejects stale seals, unknown states, mutable fields, and envelope mismatches", () => {
  const sealed = sealedCycleSpecification();

  assert.throws(
    () => parseCycleSpecification({
      ...sealed,
      cycle_description_markdown: cycleDescription.replace(
        "Validate closed Markdown before every Root mutation.",
        "Changed after approval.",
      ),
    }, cycleTarget),
    /cycle_seal_mismatch/u,
  );
  assert.throws(
    () => parseCycleSpecification({ ...sealed, status: "awaiting_acceptance" }, cycleTarget),
    /invalid_contract_variant/u,
  );
  assert.throws(
    () => parseCycleSpecification({ ...sealed, cycle_revision: "revision:cycle:other" }, cycleTarget),
    /cycle_specification_target_mismatch/u,
  );
  assert.throws(
    () => parseCycleSpecification({ ...sealed, correlation_id: "corr:other" }, cycleTarget),
    /cycle_specification_correlation_mismatch/u,
  );
  assert.throws(
    () => parseCycleSpecification({ ...sealed, metadata: {} }, cycleTarget),
    /invalid_contract_keys/u,
  );
});

test("CycleSpecification seal binds the approval correlation", () => {
  const sealed = sealedCycleSpecification();
  const otherTarget = Object.freeze({
    ...cycleTarget,
    correlation_id: parseCorrelationId("corr:cycle:other"),
  });

  assert.throws(
    () => parseCycleSpecification({
      ...sealed,
      correlation_id: otherTarget.correlation_id,
    }, otherTarget),
    /cycle_seal_mismatch/u,
  );
  assert.notEqual(
    sealCycleSpecification({
      ...unsealedCycleSpecification(),
      correlation_id: otherTarget.correlation_id,
    }, parsedRootDefinition(), otherTarget).seal_digest,
    sealed.seal_digest,
  );
});

const planGraph = {
  plan_summary_markdown: "## Plan\n\nCompile the approved design into two ordered Work items.",
  work_items: [
    {
      local_key: "contracts",
      title: "Define immutable contracts",
      description_markdown: "## Work\n\nImplement the closed Cycle contract validators.",
      depends_on_local_keys: [],
    },
    {
      local_key: "guards",
      title: "Add contract guards",
      description_markdown: "## Work\n\nProve malformed and mutable inputs fail closed.",
      depends_on_local_keys: ["contracts"],
    },
  ],
  verify: {
    title: "Verify immutable contracts",
    description_markdown: "## Verify\n\nRun contract tests, typecheck, and lint.",
  },
  traceability_markdown: "## Traceability\n\nEvery Cycle acceptance criterion maps to Work and Verify evidence.",
};

test("PlanGraph is a bounded, identity-free, deeply frozen Markdown DAG", () => {
  const parsed = parsePlanGraph(structuredClone(planGraph));

  assert.deepEqual(parsed, planGraph);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.work_items));
  assert.ok(Object.isFrozen(parsed.work_items[0]));
  assert.ok(Object.isFrozen(parsed.work_items[1]?.depends_on_local_keys));
  assert.ok(Object.isFrozen(parsed.verify));

  for (const extra of [
    { provider_receipt: { id: "provider-1" } },
    { metadata: {} },
    { created_issue_ids: ["LIN-WORK"] },
  ]) {
    assert.throws(() => parsePlanGraph({ ...planGraph, ...extra }), /invalid_contract_keys/u);
  }
  assert.throws(
    () => parsePlanGraph({
      ...planGraph,
      work_items: [{ ...planGraph.work_items[0], issue_id: "LIN-WORK" }],
    }),
    /invalid_contract_keys/u,
  );
});

test("PlanGraph rejects malformed local keys and incomplete or cyclic dependencies", () => {
  const invalidGraphs = [
    { work_items: [], error: /plan_work_items_required/u },
    {
      work_items: [{ ...planGraph.work_items[0], local_key: "LIN-WORK" }],
      error: /invalid_plan_local_key/u,
    },
    {
      work_items: [planGraph.work_items[0], { ...planGraph.work_items[1], local_key: "contracts" }],
      error: /duplicate_plan_local_key/u,
    },
    {
      work_items: [{ ...planGraph.work_items[0], depends_on_local_keys: ["missing"] }],
      error: /unknown_plan_dependency/u,
    },
    {
      work_items: [{ ...planGraph.work_items[0], depends_on_local_keys: ["contracts"] }],
      error: /self_plan_dependency/u,
    },
    {
      work_items: [
        { ...planGraph.work_items[0], depends_on_local_keys: ["guards"] },
        { ...planGraph.work_items[1], depends_on_local_keys: ["contracts"] },
      ],
      error: /cyclic_plan_dependencies/u,
    },
  ];

  for (const { work_items, error } of invalidGraphs) {
    assert.throws(
      () => parsePlanGraph({ ...planGraph, work_items }),
      error,
    );
  }
  assert.throws(
    () => parsePlanGraph({
      ...planGraph,
      work_items: [{
        ...planGraph.work_items[0],
        description_markdown: "{\"provider_receipt\":\"hidden\"}",
      }],
    }),
    /invalid_plan_work_markdown/u,
  );
});

const sealedGraphSource = {
  plan_issue: {
    issue_id: "LIN-PLAN",
    sealed_revision: "revision:plan:sealed",
    kind: "plan",
    title: "Compile the sealed design",
    description_markdown: "## Plan\n\nMaterialize the approved Work and Verify graph once.",
    parent_cycle_id: cycleTarget.cycle_id,
  },
  work_issues: [
    {
      issue_id: "LIN-WORK-1",
      sealed_revision: "revision:work:1:sealed",
      kind: "work",
      title: planGraph.work_items[0]?.title,
      description_markdown: planGraph.work_items[0]?.description_markdown,
      parent_cycle_id: cycleTarget.cycle_id,
    },
    {
      issue_id: "LIN-WORK-2",
      sealed_revision: "revision:work:2:sealed",
      kind: "work",
      title: planGraph.work_items[1]?.title,
      description_markdown: planGraph.work_items[1]?.description_markdown,
      parent_cycle_id: cycleTarget.cycle_id,
    },
  ],
  verify_issue: {
    issue_id: "LIN-VERIFY",
    sealed_revision: "revision:verify:sealed",
    kind: "verify",
    title: planGraph.verify.title,
    description_markdown: planGraph.verify.description_markdown,
    parent_cycle_id: cycleTarget.cycle_id,
  },
  relations: [
    {
      relation_id: "REL-WORK-1-2",
      revision: "revision:relation:1",
      prerequisite_issue_id: "LIN-WORK-1",
      dependent_issue_id: "LIN-WORK-2",
    },
    {
      relation_id: "REL-WORK-1-VERIFY",
      revision: "revision:relation:2",
      prerequisite_issue_id: "LIN-WORK-1",
      dependent_issue_id: "LIN-VERIFY",
    },
    {
      relation_id: "REL-WORK-2-VERIFY",
      revision: "revision:relation:3",
      prerequisite_issue_id: "LIN-WORK-2",
      dependent_issue_id: "LIN-VERIFY",
    },
  ],
};

function sealedExecutionGraph() {
  return parseSealedExecutionGraph(structuredClone(sealedGraphSource), cycleTarget.cycle_id);
}

const snapshotTarget = Object.freeze({
  root_id: rootTarget.root_id,
  cycle_id: cycleTarget.cycle_id,
  runtime_generation: parseRuntimeGeneration(5),
  correlation_id: parseCorrelationId("corr:cycle:advance:1"),
  cycle_revision: parseTaskRevision("revision:cycle:current"),
  specification: sealedCycleSpecification(),
  sealed_graph: sealedExecutionGraph(),
});

function executionStage(
  stage: (typeof sealedGraphSource.work_issues)[number] | typeof sealedGraphSource.plan_issue | typeof sealedGraphSource.verify_issue,
  revision: string,
  status: string,
) {
  return {
    issue_id: stage.issue_id,
    revision,
    kind: stage.kind,
    title: stage.title,
    description_markdown: stage.description_markdown,
    parent_cycle_id: stage.parent_cycle_id,
    status,
  };
}

function cycleExecutionSnapshotSource() {
  return {
    schema_version: 1,
    root_id: snapshotTarget.root_id,
    cycle_id: snapshotTarget.cycle_id,
    runtime_generation: snapshotTarget.runtime_generation,
    correlation_id: snapshotTarget.correlation_id,
    cycle_revision: snapshotTarget.cycle_revision,
    cycle_status: "in_progress",
    specification: snapshotTarget.specification,
    plan_issue: executionStage(sealedGraphSource.plan_issue, "revision:plan:current", "done"),
    sealed_work_issues: [
      executionStage(sealedGraphSource.work_issues[0]!, "revision:work:1:current", "done"),
      executionStage(sealedGraphSource.work_issues[1]!, "revision:work:2:current", "in_progress"),
    ],
    verify_issue: executionStage(sealedGraphSource.verify_issue, "revision:verify:current", "todo"),
    sealed_relations: sealedGraphSource.relations,
    resource_creation_evidence: [],
    issue_history: [],
    issue_record_observations: [],
    git: {
      repository_id: "repo:symphony",
      base_branch: "main",
      head_branch: "symphony/root-LIN-ROOT",
      head_revision: null,
      workspace_state: "dirty",
      diff_digest: "digest:worktree:1",
      pull_request: null,
    },
  };
}

function parsedCycleExecutionSnapshot() {
  return parseCycleExecutionSnapshot(cycleExecutionSnapshotSource(), snapshotTarget);
}

test("CycleExecutionSnapshot binds current Cycle facts to one frozen specification and sealed graph", () => {
  const parsed = parsedCycleExecutionSnapshot();

  assert.equal(parsed.cycle_status, "in_progress");
  assert.equal(parsed.cycle_revision, snapshotTarget.cycle_revision);
  assert.equal(parsed.specification.seal_digest, snapshotTarget.specification.seal_digest);
  assert.equal(parsed.sealed_graph_digest, snapshotTarget.sealed_graph.seal_digest);
  assert.equal(parsed.sealed_work_issues[1]?.status, "in_progress");
  assert.deepEqual(parsed.resource_creation_evidence, []);
  assert.deepEqual(parsed.issue_history, []);
  assert.deepEqual(parsed.issue_record_observations, []);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.sealed_work_issues));
  assert.ok(Object.isFrozen(parsed.sealed_relations));
  assert.ok(Object.isFrozen(parsed.git));
});

test("CycleExecutionSnapshot preserves complete Task evidence and rejects malformed evidence", () => {
  const source = cycleExecutionSnapshotSource();
  const creationFields = {
    evidence_id: "evidence:work:1",
    resource_kind: "issue" as const,
    resource_id: "LIN-WORK-1",
    creation_actor_id: "actor:symphony",
    provider_created_at: "2026-07-30T00:00:00.000Z",
    evidence_source: "current_resource" as const,
  };
  const history = {
    history_id: "history:work:1",
    issue_id: "LIN-WORK-1",
    provider_created_at: "2026-07-30T00:00:00.000Z",
    provider_updated_at: "2026-07-30T00:00:01.000Z",
    actor_id: "actor:external",
    change_origin: "external",
    changed_fields: ["status"],
    from_status: "Todo",
    to_status: "Done",
    from_parent_issue_id: "LIN-CYCLE",
    to_parent_issue_id: "LIN-CYCLE",
    added_label_ids: [],
    removed_label_ids: [],
    archived: null,
    trashed: null,
    relation_changes: [],
  } as const;
  const recordObservation = {
    record_id: "record:work:completion:missing",
    issue_id: "LIN-WORK-1",
    expected_record_kind: "stage_completion",
    observation_kind: "missing",
    provider_created_at: null,
    provider_updated_at: null,
    archived_at: null,
    observed_body_digest: null,
    parse_error_code: "record_missing",
  } as const;
  const parsed = parseCycleExecutionSnapshot({
    ...source,
    resource_creation_evidence: [{
      ...creationFields,
      canonical_evidence_digest: canonicalTaskRevision(creationFields),
    }],
    issue_history: [history],
    issue_record_observations: [recordObservation],
  }, snapshotTarget);

  assert.equal(parsed.resource_creation_evidence[0]?.resource_id, "LIN-WORK-1");
  assert.equal(parsed.issue_history[0]?.to_status, "Done");
  const observedRecord = parsed.issue_record_observations[0];
  assert.ok(observedRecord !== undefined && "observation_kind" in observedRecord);
  assert.equal(observedRecord.observation_kind, "missing");
  assert.throws(
    () => parseCycleExecutionSnapshot({
      ...source,
      resource_creation_evidence: [{
        ...creationFields,
        canonical_evidence_digest: `symphony:v1:${"0".repeat(64)}`,
      }],
    }, snapshotTarget),
    /task_creation_evidence_digest_mismatch/u,
  );
  assert.throws(
    () => parseCycleExecutionSnapshot({
      ...source,
      issue_history: [{ ...history, changed_fields: [] }],
    }, snapshotTarget),
    /empty_task_history_entry/u,
  );
});

test("CycleExecutionSnapshot accepts empty and Plan-only pre-materialization graphs", () => {
  for (const graphSource of [
    { plan_issue: null, work_issues: [], verify_issue: null, relations: [] },
    { plan_issue: sealedGraphSource.plan_issue, work_issues: [], verify_issue: null, relations: [] },
  ]) {
    const sealedGraph = parseSealedExecutionGraph(graphSource, cycleTarget.cycle_id);
    const parsed = parseCycleExecutionSnapshot({
      ...cycleExecutionSnapshotSource(),
      plan_issue: graphSource.plan_issue === null
        ? null
        : executionStage(graphSource.plan_issue, "revision:plan:current", "in_progress"),
      sealed_work_issues: [],
      verify_issue: null,
      sealed_relations: [],
    }, { ...snapshotTarget, sealed_graph: sealedGraph });

    assert.equal(parsed.plan_issue?.status ?? null, graphSource.plan_issue === null ? null : "in_progress");
    assert.equal(parsed.verify_issue, null);
    assert.deepEqual(parsed.sealed_work_issues, []);
  }
});

test("CycleExecutionSnapshot rejects mutable sealed fields, membership, relations, and unknown states", () => {
  const source = cycleExecutionSnapshotSource();
  const changedWork = {
    ...source.sealed_work_issues[0],
    description_markdown: "## Work\n\nChanged after graph seal.",
  };
  const invalidSnapshots = [
    { value: { ...source, sealed_work_issues: [changedWork, source.sealed_work_issues[1]] }, error: /sealed_execution_graph_mismatch/u },
    { value: { ...source, sealed_work_issues: source.sealed_work_issues.slice(0, 1) }, error: /sealed_execution_graph_mismatch/u },
    { value: { ...source, sealed_relations: source.sealed_relations.slice(1) }, error: /sealed_execution_graph_mismatch/u },
    { value: { ...source, cycle_status: "draft" }, error: /invalid_contract_variant/u },
    { value: { ...source, plan_issue: { ...source.plan_issue, status: "waiting" } }, error: /invalid_contract_variant/u },
    { value: { ...source, metadata: {} }, error: /invalid_contract_keys/u },
  ];

  for (const { value, error } of invalidSnapshots) {
    assert.throws(() => parseCycleExecutionSnapshot(value, snapshotTarget), error);
  }
  assert.throws(
    () => parseCycleExecutionSnapshot({ ...source, cycle_revision: "revision:cycle:other" }, snapshotTarget),
    /cycle_execution_target_mismatch/u,
  );
  assert.throws(
    () => parseCycleExecutionSnapshot({ ...source, correlation_id: "corr:other" }, snapshotTarget),
    /cycle_execution_correlation_mismatch/u,
  );

  const foreignRootId = parseRootIssueId("LIN-OTHER-ROOT");
  assert.throws(
    () => parseCycleExecutionSnapshot(
      { ...source, root_id: foreignRootId },
      { ...snapshotTarget, root_id: foreignRootId },
    ),
    /cycle_execution_target_mismatch/u,
  );
  const foreignCycleId = parseCycleIssueId("LIN-OTHER-CYCLE");
  assert.throws(
    () => parseCycleExecutionSnapshot(
      { ...source, cycle_id: foreignCycleId },
      { ...snapshotTarget, cycle_id: foreignCycleId },
    ),
    /cycle_execution_target_mismatch/u,
  );
});

test("sealed execution graph rejects malformed kinds, parents, dependencies, and partial materialization", () => {
  const invalidGraphs = [
    { value: { ...sealedGraphSource, work_issues: [{ ...sealedGraphSource.work_issues[0], kind: "verify" }] }, error: /invalid_sealed_stage_kind/u },
    { value: { ...sealedGraphSource, work_issues: [{ ...sealedGraphSource.work_issues[0], parent_cycle_id: "LIN-OTHER" }] }, error: /sealed_stage_parent_mismatch/u },
    { value: { ...sealedGraphSource, verify_issue: null }, error: /partial_execution_graph/u },
    { value: { ...sealedGraphSource, relations: sealedGraphSource.relations.slice(0, 1) }, error: /verify_dependency_coverage/u },
    { value: { ...sealedGraphSource, provider_receipt: {} }, error: /invalid_contract_keys/u },
  ];

  for (const { value, error } of invalidGraphs) {
    assert.throws(() => parseSealedExecutionGraph(value, cycleTarget.cycle_id), error);
  }
});

test("CycleAdvanceResult is a closed union bound to the exact request envelope", () => {
  const request = parsedCycleExecutionSnapshot();
  const base = {
    schema_version: 1,
    root_id: request.root_id,
    cycle_id: request.cycle_id,
    runtime_generation: request.runtime_generation,
    correlation_id: request.correlation_id,
    seal_digest: request.specification.seal_digest,
    from_cycle_revision: request.cycle_revision,
    to_cycle_revision: "revision:cycle:next",
  };

  for (const outcome of ["advanced", "awaiting_acceptance", "no_action"] as const) {
    const parsed = parseCycleAdvanceResult({ ...base, outcome, reason_markdown: null }, request);
    assert.equal(parsed.outcome, outcome);
    assert.ok(Object.isFrozen(parsed));
  }
  for (const outcome of ["terminal_failed", "precondition_failed"] as const) {
    const parsed = parseCycleAdvanceResult({
      ...base,
      outcome,
      reason_markdown: "## Reason\n\nThe fresh facts do not permit the requested transition.",
    }, request);
    assert.equal(parsed.outcome, outcome);
  }

  assert.throws(
    () => parseCycleAdvanceResult({ ...base, outcome: "retry", reason_markdown: null }, request),
    /invalid_contract_variant/u,
  );
  assert.throws(
    () => parseCycleAdvanceResult({ ...base, outcome: "terminal_failed", reason_markdown: null }, request),
    /cycle_advance_reason_required/u,
  );
  assert.throws(
    () => parseCycleAdvanceResult({ ...base, outcome: "advanced", reason_markdown: "Unexpected" }, request),
    /cycle_advance_reason_forbidden/u,
  );
  assert.throws(
    () => parseCycleAdvanceResult({ ...base, from_cycle_revision: "revision:cycle:other", outcome: "advanced", reason_markdown: null }, request),
    /cycle_advance_revision_mismatch/u,
  );
  assert.throws(
    () => parseCycleAdvanceResult({ ...base, correlation_id: "corr:other", outcome: "advanced", reason_markdown: null }, request),
    /cycle_advance_correlation_mismatch/u,
  );
  assert.throws(
    () => parseCycleAdvanceResult({ ...base, next_action: "retry", outcome: "advanced", reason_markdown: null }, request),
    /invalid_contract_keys/u,
  );
});
