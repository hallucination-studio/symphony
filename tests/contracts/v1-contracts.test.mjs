import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const schemaRoot = path.join(root, "packages/contracts/schemas");
const generatedRoot = path.join(root, "packages/contracts/generated");
const protocolFamilies = [
  "common",
  "podium-client",
  "desktop-host",
  "podium-conductor",
  "conductor-performer",
];

async function loadSchema(family) {
  const schemaPath = path.join(schemaRoot, family, `${family}.schema.json`);
  return JSON.parse(await readFile(schemaPath, "utf8"));
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
}

test("all active protocol families are closed JSON Schema 2020-12 sources", async () => {
  for (const family of protocolFamilies) {
    const schema = await loadSchema(family);
    assert.equal(
      schema.$schema,
      "https://json-schema.org/draft/2020-12/schema",
      family,
    );
    assert.equal(typeof schema.$id, "string", family);
    assert.ok(schema.$defs && Object.keys(schema.$defs).length > 0, family);

    for (const [name, definition] of Object.entries(schema.$defs)) {
      if (definition.type === "object") {
        assert.equal(
          definition.additionalProperties,
          false,
          `${family}#${name} must reject unknown fields`,
        );
      }
    }
  }
});

test("the schemas include only the approved active protocol vocabulary", async () => {
  const schemas = await Promise.all(protocolFamilies.map(loadSchema));
  const source = JSON.stringify(schemas);

  for (const requiredName of [
    "ProtocolError",
    "ConnectLinearCommand",
    "DesktopOverviewView",
    "OpenExternalUrlCommand",
    "ResolveConductorProjectQuery",
    "WorkflowMutationCommand",
    "ConductorPerformerMessage",
    "RootBootstrapSnapshot",
    "RootDelta",
    "AdvanceRootReconcilerRequest",
    "RootDirective",
    "UserCommentReply",
    "CancelRootDirective",
    "PlanTurnRequest",
    "WorkTurnRequest",
    "VerifyTurnRequest",
    "PlanResult",
    "WorkResult",
    "VerifyResult",
  ]) {
    assert.match(source, new RegExp(`"${requiredName}"`), requiredName);
  }

  for (const forbiddenName of [
    "PriorityRootScheduling",
    "BlockerScheduling",
    "StartOperation",
    "GetOperationStatus",
    "DeliveryReceipt",
    "PlanRevision",
    "ProviderConfigMap",
    "PlanTurnCommand",
    "WorkTurnCommand",
    "RootGateTurnCommand",
    "PerformerTurnEvent",
    "turn_kind",
    "GetRootScopeQuery",
    "RootScopeResult",
    "RootScopeIssueSnapshot",
    "Conductor" + "Heartbeat",
    "Conductor" + "RuntimeReport",
    "GetIssueTreeQuery",
    "IssueTreePageResult",
    "ListRootUsageQuery",
    "RootUsagePageResult",
    "LinearIssueTreeSnapshot",
    "LinearMutationCommand",
    "LinearMutationResult",
    ["RootReconciler", "Observation"].join(""),
    ["ExternalLinearChange", "Input"].join(""),
    ["ExternalLinearChange", "Disposition"].join(""),
    ["UserComment", "Disposition"].join(""),
    "comment_" + "dispositions",
    "external_" + "change_dispositions",
    "based_on_" + "root_tree_digest",
    "resolve_" + "invalid_lifecycle",
    "revise_" + "cycle_tree",
    "create_" + "successor_cycle",
  ]) {
    assert.doesNotMatch(source, new RegExp(forbiddenName), forbiddenName);
  }
});

test("Roadmap 2 Root scheduling facts are closed and bounded", async () => {
  const schema = await loadSchema("podium-conductor");
  const root = schema.$defs.RootIssueSnapshot;
  const issue = schema.$defs.LinearIssueNodeSnapshot;
  const priority = schema.$defs.LinearPriority;
  const blocker = schema.$defs.LinearBlockerSnapshot;

  assert.ok(root.required.includes("priority"));
  assert.ok(root.required.includes("blockers"));
  assert.ok(root.required.includes("root_managed_comments"));
  assert.equal(root.properties.priority.$ref, "#/$defs/LinearPriority");
  assert.deepEqual(priority.enum, [
    "urgent",
    "high",
    "normal",
    "low",
    "no_priority",
  ]);
  assert.equal(root.properties.blockers.maxItems, 512);
  assert.equal(
    root.properties.blockers.items.$ref,
    "#/$defs/LinearBlockerSnapshot",
  );
  assert.equal(root.properties.root_managed_comments.maxItems, 2);
  assert.equal(
    root.properties.root_managed_comments.items.$ref,
    "#/$defs/LinearCommentSnapshot",
  );
  assert.equal(issue.properties.order.type, "number");
  assert.equal(issue.properties.order.minimum, -1000000000);
  assert.equal(issue.properties.order.maximum, 1000000000);
  assert.equal(blocker.additionalProperties, false);
  assert.deepEqual(blocker.required, [
    "source_issue_id",
    "target_issue_id",
    "target_state",
  ]);
});

test("Project resolution carries a closed Conductor pool and Root routing labels", async () => {
  const schema = await loadSchema("podium-conductor");
  const resolved = schema.$defs.ResolvedConductorProject;
  const root = schema.$defs.RootIssueSnapshot;
  const pool = schema.$defs.ConductorPool;

  assert.ok(resolved.required.includes("conductor_pool"));
  assert.equal(resolved.properties.conductor_pool.items.$ref, "#/$defs/ConductorPool");
  assert.deepEqual(pool.required, ["conductor_short_hash"]);
  assert.equal(pool.additionalProperties, false);
  assert.ok(root.required.includes("root_conductor_labels"));
  assert.equal(root.properties.root_conductor_labels.maxItems, 1);
  assert.equal(root.properties.root_conductor_labels.items.$ref, "#/$defs/ConductorPool");
});

test("Agent execution policies are closed, bounded, and shared by Profile contracts", async () => {
  const client = await loadSchema("podium-client");
  const relay = await loadSchema("podium-conductor");

  const policy = client.$defs.AgentExecutionPolicy;
  const rule = client.$defs.AgentCommandRule;
  assert.equal(policy.additionalProperties, false);
  assert.deepEqual(policy.required, [
    "sandbox_mode",
    "command_allowlist",
    "command_denylist",
  ]);
  assert.deepEqual(policy.properties.sandbox_mode.enum, [
    "read_only",
    "workspace_write",
    "unrestricted",
  ]);
  assert.equal(policy.properties.sandbox_mode.default, "workspace_write");
  assert.deepEqual(policy.properties.command_allowlist.default, []);
  assert.deepEqual(policy.properties.command_denylist.default, []);
  assert.match(policy.$comment, /denylist rules take precedence/u);
  assert.equal(policy.properties.command_allowlist.maxItems, 64);
  assert.equal(policy.properties.command_denylist.maxItems, 64);
  assert.equal(rule.additionalProperties, false);
  assert.deepEqual(rule.required, ["executable", "argv_prefix"]);
  assert.equal(rule.properties.argv_prefix.maxItems, 16);

  for (const name of [
    "CreatePerformerProfileCommand",
    "UpdatePerformerProfileCommand",
    "PerformerProfileSummaryView",
  ]) {
    const definition = client.$defs[name];
    assert.ok(definition.required.includes("execution_policy"));
    assert.equal(
      definition.properties.execution_policy.$ref,
      "#/$defs/AgentExecutionPolicy",
    );
  }

  const relayVariants = relay.$defs.ProfileRelayMetadata.oneOf;
  for (const kind of ["create_profile", "update_profile"]) {
    const variant = relayVariants.find(({ properties }) =>
      properties.kind?.const === kind
    );
    assert.ok(variant.required.includes("execution_policy"));
    assert.equal(
      variant.properties.execution_policy.$ref,
      "podium-client.schema.json#/$defs/AgentExecutionPolicy",
    );
  }
});

test("Agent Wire is closed, correlated, and covers each role outcome", async () => {
  const schema = await loadSchema("conductor-performer");
  const message = schema.$defs.ConductorPerformerMessage;
  assert.deepEqual(message.oneOf.map(({ $ref }) => $ref), [
    "#/$defs/OpenRootReconcilerRequest",
    "#/$defs/RootReconcilerOpenedResult",
    "#/$defs/AdvanceRootReconcilerRequest",
    "#/$defs/RootDirective",
    "#/$defs/PlanTurnRequest",
    "#/$defs/PlanResult",
    "#/$defs/WorkTurnRequest",
    "#/$defs/WorkResult",
    "#/$defs/VerifyTurnRequest",
    "#/$defs/VerifyResult",
    "#/$defs/CloseCycleStageSessionsCommand",
    "#/$defs/CloseCycleStageSessionsResult",
    "#/$defs/CloseRootReconcilerCommand",
    "#/$defs/CloseRootReconcilerResult",
    "#/$defs/PerformerProfileControlMetadata",
    "#/$defs/PerformerProfileControlResult",
  ]);
  const open = schema.$defs.OpenRootReconcilerRequest;
  assert.ok(open.required.includes("bootstrap"));
  assert.equal(open.properties.bootstrap.$ref, "#/$defs/RootBootstrap");
  const advance = schema.$defs.AdvanceRootReconcilerRequest;
  assert.deepEqual(advance.required, [
    "protocol_version", "request_id", "kind", "reconciler_session_id",
    "reconciler_turn_id", "observed_at", "delta", "limits",
  ]);
  assert.equal(advance.properties.delta.$ref, "#/$defs/RootDelta");
  assert.equal(
    Object.hasOwn(advance.properties, "root_snapshot"),
    false,
  );
  assert.deepEqual(schema.$defs.RootDeltaChange.oneOf.map(({ $ref }) => $ref), [
    "#/$defs/IssueCurrentValue", "#/$defs/IssueDetached",
    "#/$defs/CommentCurrentValue", "#/$defs/CommentRemoved",
    "#/$defs/RelationCurrentValue", "#/$defs/RelationRemoved",
    "#/$defs/ManagedRecordCurrentValue", "#/$defs/ManagedRecordRemoved",
    "#/$defs/PlanContractCurrentValue", "#/$defs/PlanCompletedResultCurrentValue",
    "#/$defs/PlanContractRemoved", "#/$defs/PlanCompletedResultRemoved",
    "#/$defs/GitFactsCurrentValue",
    "#/$defs/MechanicalViolationsCurrentValue",
  ]);
  for (const name of ["PlanTurnRequest", "WorkTurnRequest", "VerifyTurnRequest", "PlanResult", "WorkResult", "VerifyResult"]) {
    const definition = schema.$defs[name];
    assert.equal(definition.additionalProperties, false, name);
    assert.ok(definition.required.includes("role"), name);
    assert.ok(definition.required.includes("role_session_id"), name);
    assert.ok(definition.required.includes("role_turn_id"), name);
  }
  assert.deepEqual(schema.$defs.PlanResultOutcome.oneOf.map(({ $ref }) => $ref), [
    "#/$defs/PlanCompletedResult",
    "#/$defs/PlanNeedsInformationResult",
    "#/$defs/PlanBlockedResult",
    "#/$defs/StageBudgetExhaustedResult",
    "#/$defs/StageCanceledResult",
    "#/$defs/StageExecutionFailedResult",
  ]);
  assert.deepEqual(schema.$defs.WorkResultOutcome.oneOf.map(({ $ref }) => $ref), [
    "#/$defs/WorkCompletedResult",
    "#/$defs/WorkBlockedResult",
    "#/$defs/WorkSpecialResult",
    "#/$defs/StageBudgetExhaustedResult",
    "#/$defs/StageCanceledResult",
    "#/$defs/StageExecutionFailedResult",
  ]);
  assert.deepEqual(schema.$defs.VerifyResultOutcome.oneOf.map(({ $ref }) => $ref), [
    "#/$defs/VerifyPassedResult",
    "#/$defs/VerifyChangesRequiredResult",
    "#/$defs/VerifyInconclusiveResult",
    "#/$defs/VerifyPlanContractViolationResult",
    "#/$defs/VerifyBlockedResult",
    "#/$defs/StageBudgetExhaustedResult",
    "#/$defs/StageCanceledResult",
    "#/$defs/StageExecutionFailedResult",
  ]);
});

test("workflow gateway contracts expose catalog, complete Tree facts, and stable writes", async () => {
  const schema = await loadSchema("podium-conductor");

  const status = schema.$defs.WorkflowStatusSnapshot;
  assert.deepEqual(status.required, ["status_id", "name", "category", "position"]);
  assert.deepEqual(schema.$defs.WorkflowStatusCategory.enum, [
    "backlog", "unstarted", "started", "completed", "canceled",
  ]);

  const tree = schema.$defs.WorkflowRootTreeSnapshot;
  assert.deepEqual(tree.required, [
    "root_issue_id", "status_catalog", "issues", "comments", "relations", "observed_at",
    "source_manifest", "coverage",
  ]);
  assert.equal(schema.$defs.WorkflowSourceManifestEntry.additionalProperties, false);
  assert.deepEqual(schema.$defs.WorkflowSourceManifestEntry.required, [
    "source_kind", "source_id", "source_version", "actor_kind",
  ]);
  assert.equal(schema.$defs.WorkflowSourceCoverage.additionalProperties, false);
  assert.deepEqual(schema.$defs.WorkflowSourceCoverage.required, ["is_complete", "omissions"]);
  assert.equal(schema.$defs.WorkflowIssueSnapshot.properties.remote_version.$ref,
    "common.schema.json#/$defs/OpaqueIdentifier");
  assert.equal(schema.$defs.WorkflowCommentSnapshot.properties.remote_version.$ref,
    "common.schema.json#/$defs/OpaqueIdentifier");
  assert.equal(schema.$defs.WorkflowRelationSnapshot.additionalProperties, false);

  assert.deepEqual(schema.$defs.WorkflowMutationCommand.oneOf.map(({ $ref }) => $ref), [
    "#/$defs/CreateWorkflowIssueCommand",
    "#/$defs/UpdateWorkflowIssueCommand",
    "#/$defs/AppendWorkflowCommentCommand",
    "#/$defs/ArchiveWorkflowIssueCommand",
    "#/$defs/RestoreWorkflowIssueCommand",
    "#/$defs/CreateWorkflowRelationCommand",
    "#/$defs/RemoveWorkflowRelationCommand",
  ]);
  for (const name of [
    "CreateWorkflowIssueCommand",
    "UpdateWorkflowIssueCommand",
    "AppendWorkflowCommentCommand",
    "ArchiveWorkflowIssueCommand",
    "RestoreWorkflowIssueCommand",
    "CreateWorkflowRelationCommand",
  ]) {
    assert.ok(schema.$defs[name].required.includes("write_id"), name);
    assert.ok(schema.$defs[name].required.includes("conductor_short_hash"), name);
    assert.ok(schema.$defs[name].required.includes("expected_project_id"), name);
    assert.ok(schema.$defs[name].required.includes("root_issue_id"), name);
    assert.ok(schema.$defs[name].required.includes("expected_root_remote_version"), name);
  }
  assert.ok(schema.$defs.CreateWorkflowIssueCommand.required.includes("label_names"));
  assert.equal(schema.$defs.CreateWorkflowIssueCommand.properties.label_names.type, "array");
  assert.equal(schema.$defs.CreateWorkflowIssueCommand.properties.label_names.items.$ref,
    "common.schema.json#/$defs/ShortText");
  assert.equal(schema.$defs.CreateWorkflowIssueCommand.properties.label_names.uniqueItems, true);
  assert.deepEqual(schema.$defs.WorkflowMutationResult.oneOf.map(({ properties }) => properties.kind.const), [
    "applied", "already_applied", "write_unconfirmed", "precondition_conflict", "failed",
  ]);
});

test("generation is deterministic and check mode detects drift", async () => {
  const first = run("npm", ["run", "contracts:generate"]);
  assert.equal(first.status, 0, first.stderr);

  const generatedFiles = [
    "typescript/contracts.ts",
    "python/contracts.py",
    "rust/src/lib.rs",
  ];
  const before = await Promise.all(
    generatedFiles.map((file) =>
      readFile(path.join(generatedRoot, file), "utf8"),
    ),
  );

  const second = run("npm", ["run", "contracts:generate"]);
  assert.equal(second.status, 0, second.stderr);
  const after = await Promise.all(
    generatedFiles.map((file) =>
      readFile(path.join(generatedRoot, file), "utf8"),
    ),
  );
  assert.deepEqual(after, before);
  assert.match(before[0], /export type PodiumClientConnectLinearCommand/);
  assert.match(before[1], /class ConductorPerformerRootDirective/);
  assert.match(
    before[2],
    /define_contract_type!\(DesktopHostOpenExternalUrlCommand/,
  );

  const check = run("npm", ["run", "contracts:check"]);
  assert.equal(check.status, 0, check.stderr);

  const target = path.join(generatedRoot, generatedFiles[0]);
  try {
    await writeFile(target, `${before[0]}\n// drift\n`);
    const drift = run("npm", ["run", "contracts:check"]);
    assert.notEqual(drift.status, 0);
    assert.match(drift.stderr, /generated contract drift/i);
  } finally {
    await writeFile(target, before[0]);
  }
});

test("TypeScript, Python, and Rust reject the same invalid fixtures", async () => {
  const fixtureRoot = path.join(
    root,
    "packages/contracts/fixtures/cross-language",
  );
  const validPath = path.join(fixtureRoot, "valid");
  const invalidPath = path.join(fixtureRoot, "invalid");

  const typescript = run("npm", [
    "run",
    "contracts:validate:typescript",
    "--",
    validPath,
    invalidPath,
  ]);
  assert.equal(typescript.status, 0, typescript.stderr);

  const python = run(".venv/bin/python", [
    "packages/contracts/tools/validate_python.py",
    validPath,
    invalidPath,
  ]);
  assert.equal(python.status, 0, python.stderr);

  const cargoTarget = await mkdtemp(path.join(tmpdir(), "symphony-contracts-"));
  const rust = run(
    "cargo",
    [
      "run",
      "--quiet",
      "--manifest-path",
      "packages/contracts/generated/rust/Cargo.toml",
      "--example",
      "validate",
      "--",
      validPath,
      invalidPath,
    ],
    { env: { ...process.env, CARGO_TARGET_DIR: cargoTarget } },
  );
  assert.equal(rust.status, 0, rust.stderr);
});

test("all generated decoders count string bounds by Unicode code point", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "symphony-unicode-"));
  const validPath = path.join(fixtureRoot, "valid");
  const invalidPath = path.join(fixtureRoot, "invalid");
  await mkdir(validPath);
  await mkdir(invalidPath);
  await writeFile(
    path.join(validPath, "unicode.json"),
    JSON.stringify({
      schema: "common.schema.json#/$defs/ShortText",
      value: "😀".repeat(130),
    }),
  );

  const typescript = run("npm", [
    "run",
    "contracts:validate:typescript",
    "--",
    validPath,
    invalidPath,
  ]);
  assert.equal(typescript.status, 0, typescript.stderr);

  const python = run(".venv/bin/python", [
    "packages/contracts/tools/validate_python.py",
    validPath,
    invalidPath,
  ]);
  assert.equal(python.status, 0, python.stderr);

  const cargoTarget = await mkdtemp(path.join(tmpdir(), "symphony-unicode-rust-"));
  const rust = run(
    "cargo",
    [
      "run",
      "--quiet",
      "--manifest-path",
      "packages/contracts/generated/rust/Cargo.toml",
      "--example",
      "validate",
      "--",
      validPath,
      invalidPath,
    ],
    { env: { ...process.env, CARGO_TARGET_DIR: cargoTarget } },
  );
  assert.equal(rust.status, 0, rust.stderr);
});
