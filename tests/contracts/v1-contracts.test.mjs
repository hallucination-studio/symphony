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
const retiredRootListContracts = [
  ["List", "Root", "Issues", "Query"].join(""),
  ["Root", "Issues", "Page", "Result"].join(""),
  ["Root", "Issue", "Snapshot"].join(""),
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

test("generated contract names do not repeat an existing schema-family prefix", async () => {
  const generated = await readFile(path.join(generatedRoot, "typescript/contracts.ts"), "utf8");
  for (const repeated of [
    "ConductorPerformerConductorPerformerMessage",
    "DesktopHostDesktopHostMessage",
    "PodiumClientPodiumClientMessage",
    "PodiumConductorPodiumConductorMessage",
  ]) {
    assert.equal(generated.includes(repeated), false, repeated);
  }
});

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
    "ListProjectRootIndexPageQuery",
    "ProjectRootIndexPageResult",
    "ProjectRootIndexPage",
    "RootHeader",
    "WorkflowMutationCommand",
    "ConductorPerformerMessage",
    "RootBootstrapSnapshot",
    "RootDelta",
    "RootConvergenceSnapshot",
    "RootContextCurrentValue",
    "RootContextReplacement",
    "RootContextTombstone",
    "ProviderTurnContinuity",
    "AdvanceRootReconcilerRequest",
    "RootDirective",
    "RootReconcilerTurnFailure",
    "RootReconcilerTurnResult",
    "UserCommentReply",
    "UserCommentThreadStateInput",
    "CancelRootDirective",
    "MaterializePlanNodeAction",
    "PlanTurnRequest",
    "WorkTurnRequest",
    "VerifyTurnRequest",
    "PlanResult",
    "WorkResult",
    "VerifyResult",
    "CreateCommentReplyCommand",
    "SetCommentReceiptReactionCommand",
    "SetCommentThreadStateCommand",
    "TurnUsage",
    "ModelTurnRecord",
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
    "IssueCurrentValue",
    "IssueDetached",
    "CommentCurrentValue",
    "CommentRemoved",
    "RelationCurrentValue",
    "RelationRemoved",
    "WorktreeGateCurrentValue",
    "MechanicalViolationsCurrentValue",
    "ConvergenceCurrentValue",
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
    "managed" + "_marker",
    "managed" + "Marker",
    "expected" + "_managed" + "_marker",
    "Usage" + "Snapshot",
    "WorkflowCommentThread" + "ChangeSnapshot",
    "UserCommentThread" + "ChangeInput",
    "Archive" + "WorkflowIssueCommand",
    "Restore" + "WorkflowIssueCommand",
    "Remove" + "WorkflowRelationCommand",
    ...retiredRootListContracts,
  ]) {
    assert.doesNotMatch(source, new RegExp(forbiddenName), forbiddenName);
  }
});

test("Project Root Index discovery facts are closed, bounded, and redacted", async () => {
  const schema = await loadSchema("podium-conductor");
  const root = schema.$defs.RootHeader;
  const query = schema.$defs.ListProjectRootIndexPageQuery;
  const page = schema.$defs.ProjectRootIndexPage;
  const result = schema.$defs.ProjectRootIndexPageResult;
  const priority = schema.$defs.LinearPriority;
  const blocker = schema.$defs.LinearBlockerSnapshot;

  assert.deepEqual(root.required, [
    "root_issue_id",
    "identifier",
    "project_id",
    "state",
    "is_archived",
    "updated_at",
    "priority",
    "blockers",
    "root_conductor_labels",
    "is_delegated_to_symphony",
  ]);
  assert.deepEqual(Object.keys(root.properties).sort(), [
    "blockers",
    "identifier",
    "is_archived",
    "is_delegated_to_symphony",
    "priority",
    "project_id",
    "root_conductor_labels",
    "root_issue_id",
    "state",
    "updated_at",
  ]);
  assert.equal(root.properties.priority.$ref, "#/$defs/LinearPriority");
  assert.deepEqual(priority.enum, ["urgent", "high", "normal", "low", "no_priority"]);
  assert.equal(root.properties.blockers.maxItems, 250);
  assert.equal(
    root.properties.blockers.items.$ref,
    "#/$defs/LinearBlockerSnapshot",
  );
  assert.equal(root.properties.root_conductor_labels.maxItems, 1);
  assert.equal(Object.hasOwn(schema.$defs, "RootOwnershipHeader"), false);
  assert.equal(query.properties.kind.const, "list_project_root_index_page");
  assert.deepEqual(query.required, ["kind", "binding_id", "instance_id", "expected_project_id", "page"]);
  assert.equal(page.properties.headers.items.$ref, "#/$defs/RootHeader");
  assert.equal(page.properties.headers.maxItems, 250);
  assert.equal(result.properties.kind.const, "project_root_index_page");
  assert.equal(result.properties.page.$ref, "#/$defs/ProjectRootIndexPage");
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
  const root = schema.$defs.RootHeader;
  const pool = schema.$defs.ConductorPool;

  assert.ok(resolved.required.includes("conductor_pool"));
  assert.equal(resolved.properties.conductor_pool.items.$ref, "#/$defs/ConductorPool");
  assert.deepEqual(pool.required, ["conductor_short_hash"]);
  assert.equal(pool.additionalProperties, false);
  assert.ok(root.required.includes("root_conductor_labels"));
  assert.equal(root.properties.root_conductor_labels.maxItems, 1);
  assert.equal(root.properties.root_conductor_labels.items.$ref, "#/$defs/ConductorPool");
});

test("private channel registration binds one transient Binding generation before Conductor traffic", async () => {
  const schema = await loadSchema("podium-conductor");
  const registration = schema.$defs.ConductorChannelRegistrationCommand;
  const accepted = schema.$defs.ConductorChannelRegistrationResult;

  assert.equal(registration.additionalProperties, false);
  assert.deepEqual(registration.required, ["kind", "binding_id", "conductor_id", "instance_id"]);
  assert.equal(registration.properties.kind.const, "conductor_channel_registration");
  assert.equal(accepted.additionalProperties, false);
  assert.deepEqual(accepted.required, ["kind", "binding_id", "conductor_id", "instance_id"]);
  assert.equal(accepted.properties.kind.const, "conductor_channel_registered");
  assert.ok(schema.$defs.PodiumConductorBody.oneOf.some(
    ({ $ref }) => $ref === "#/$defs/ConductorChannelRegistrationCommand",
  ));
  assert.ok(schema.$defs.PodiumConductorBody.oneOf.some(
    ({ $ref }) => $ref === "#/$defs/ConductorChannelRegistrationResult",
  ));
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
    "#/$defs/RootReconcilerTurnFailure",
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
  const opened = schema.$defs.RootReconcilerOpenedResult;
  assert.ok(opened.required.includes("initial_result"));
  assert.equal(opened.properties.initial_result.$ref, "#/$defs/RootReconcilerTurnResult");
  assert.equal(Object.hasOwn(opened.properties, "initial_" + "directive"), false);
  assert.deepEqual(schema.$defs.RootReconcilerTurnResult.oneOf.map(({ $ref }) => $ref), [
    "#/$defs/RootDirective",
    "#/$defs/RootReconcilerTurnFailure",
  ]);
  assert.deepEqual(schema.$defs.RootReconcilerTurnFailure.required, [
    "protocol_version", "request_id", "kind", "root_issue_id", "failure",
  ]);
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
    "#/$defs/RootContextCurrentValue",
    "#/$defs/RootContextReplacement",
    "#/$defs/RootContextTombstone",
  ]);
  assert.deepEqual(schema.$defs.RootContextSourceKind.enum, [
    "issue", "comment", "comment_thread", "activity", "relation",
    "attachment", "git", "mechanical_violation",
  ]);
  assert.ok(schema.$defs.RootContextReplacement.required.includes("replaces_source_version_or_digest"));
  assert.ok(schema.$defs.RootContextTombstone.required.includes("removes_source_version_or_digest"));
  assert.equal(Object.hasOwn(schema.$defs.RootContextTombstone.properties, "value"), false);
  assert.deepEqual(schema.$defs.CycleObservation.required, [
    "cycle_issue", "cycle_status", "is_archived", "issues", "relations",
  ]);
  const retiredRecord = ["Managed", "Record"].join("");
  for (const retired of [
    `${retiredRecord}CurrentValue`, `${retiredRecord}Removed`,
    "RecordReference",
    "PlanContractCurrentValue", "PlanCompletedResultCurrentValue",
    "PlanContractRemoved", "PlanCompletedResultRemoved",
  ]) {
    assert.equal(Object.hasOwn(schema.$defs, retired), false, retired);
  }
  assert.deepEqual(schema.$defs.EvidenceRef.properties.source_kind.enum, [
    "linear_issue", "linear_comment", "git", "check", "result",
  ]);
  assert.deepEqual(schema.$defs.IssueSnapshot.properties.issue_kind.enum, [
    "root", "cycle", "plan", "work", "verify", "finding",
  ]);
  assert.deepEqual(schema.$defs.PlanTurnContext.required, [
    "root_contract", "cycle", "current_plan_issue", "prior_plan_attempt_facts",
    "prior_approved_plan_facts", "unresolved_finding_issue_facts",
    "human_action_thread_facts", "current_git_facts", "required_output",
  ]);
  assert.deepEqual(schema.$defs.WorkTurnContext.required, [
    "approved_plan_contract", "current_active_work_dag", "selected_work",
    "completed_work_evidence", "prior_work_attempt_facts", "human_action_thread_facts",
    "git_baseline", "workspace_capability",
  ]);
  assert.deepEqual(schema.$defs.VerifyTurnContext.required, [
    "approved_plan_contract", "complete_active_cycle_dag", "archived_cycle_nodes",
    "completed_work_issue_facts", "unresolved_finding_issue_facts",
    "human_action_thread_facts", "verification_requirements",
    "immutable_target_revision", "repository_snapshot",
  ]);
  for (const [requestName, role, initialName, deltaName] of [
    ["PlanTurnRequest", "plan", "PlanRoleContextInitial", "PlanRoleContextDelta"],
    ["WorkTurnRequest", "work", "WorkRoleContextInitial", "WorkRoleContextDelta"],
    ["VerifyTurnRequest", "verify", "VerifyRoleContextInitial", "VerifyRoleContextDelta"],
  ]) {
    const request = schema.$defs[requestName];
    assert.ok(request.required.includes("role_context_update"), requestName);
    assert.equal(Object.hasOwn(request.properties, "context"), false, requestName);
    const update = schema.$defs[`${role[0].toUpperCase()}${role.slice(1)}RoleContextUpdate`];
    assert.deepEqual(update.oneOf.map(({ $ref }) => $ref), [
      `#/$defs/${initialName}`,
      `#/$defs/${deltaName}`,
    ]);
  }
  assert.deepEqual(schema.$defs.ProviderTurnContinuity.oneOf.map(({ $ref }) => $ref), [
    "#/$defs/RetainedProviderTurnContinuity",
    "#/$defs/ClosedProviderTurnContinuity",
  ]);
  assert.deepEqual(schema.$defs.RetainedProviderTurnContinuity.properties.append_outcome.enum, [
    "not_accepted", "accepted",
  ]);
  assert.deepEqual(schema.$defs.ClosedProviderTurnContinuity.properties.append_outcome.enum, [
    "acceptance_unknown", "session_lost",
  ]);
  assert.ok(schema.$defs.RootReconcilerFailure.required.includes("continuity"));
  assert.ok(schema.$defs.StageExecutionFailedResult.required.includes("continuity"));
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

test("Root bootstrap uses native authority and one closed worktree gate result", async () => {
  const schema = await loadSchema("conductor-performer");
  const root = schema.$defs.RootObservation;
  const bootstrap = schema.$defs.RootBootstrapSnapshot;
  const gate = schema.$defs.RootWorktreeGateResult;

  assert.equal(root.additionalProperties, false);
  assert.equal(root.required.includes("ownership"), false);
  assert.equal(Object.hasOwn(root.properties, "ownership"), false);
  assert.equal(bootstrap.required.includes("managed_records"), false);
  assert.equal(Object.hasOwn(bootstrap.properties, "managed_records"), false);
  assert.equal(bootstrap.required.includes("delivery"), false);
  assert.equal(Object.hasOwn(bootstrap.properties, "delivery"), false);
  assert.equal(bootstrap.required.includes("git_facts"), false);
  assert.equal(Object.hasOwn(bootstrap.properties, "git_facts"), false);
  assert.ok(bootstrap.required.includes("worktree_gate"));
  assert.equal(bootstrap.properties.worktree_gate.$ref, "#/$defs/RootWorktreeGateResult");
  assert.ok(Array.isArray(gate.oneOf));
  assert.ok(gate.oneOf.length >= 3);
  for (const { $ref } of gate.oneOf) {
    const definition = schema.$defs[$ref.slice("#/$defs/".length)];
    assert.equal(definition.additionalProperties, false);
    assert.ok(definition.required.includes("kind"));
  }
});

test("workflow gateway contracts expose catalog, complete Tree facts, and stable writes", async () => {
  const schema = await loadSchema("podium-conductor");
  const generationBoundQueries = [
    "ResolveConductorProjectQuery",
    "ListProjectRootIndexPageQuery",
    "GetWorkflowIssueTreeQuery",
  ];
  const generationBoundMutations = schema.$defs.WorkflowMutationCommand.oneOf.map(
    ({ $ref }) => $ref.slice("#/$defs/".length),
  );

  for (const definitionName of [...generationBoundQueries, ...generationBoundMutations]) {
    const definition = schema.$defs[definitionName];
    assert.ok(definition.required.includes("instance_id"), `${definitionName} must require instance_id`);
    assert.equal(
      definition.properties.instance_id.$ref,
      "common.schema.json#/$defs/Identifier",
      `${definitionName}.instance_id must be an Identifier`,
    );
  }

  const status = schema.$defs.WorkflowStatusSnapshot;
  assert.deepEqual(status.required, ["status_id", "name", "category", "position"]);
  assert.deepEqual(schema.$defs.WorkflowStatusCategory.enum, [
    "backlog", "unstarted", "started", "completed", "canceled",
  ]);

  const tree = schema.$defs.WorkflowRootTreeSnapshot;
  assert.deepEqual(tree.required, [
    "root_issue_id", "status_catalog", "issues", "comments", "relations", "attachments", "activities", "observed_at",
    "source_manifest", "coverage",
  ]);
  assert.equal(tree.properties.attachments.items.$ref, "#/$defs/WorkflowAttachmentSnapshot");
  assert.equal(tree.properties.attachments.maxItems, 1024);
  assert.equal(tree.properties.activities.items.$ref, "#/$defs/WorkflowActivitySnapshot");
  assert.equal(tree.properties.activities.maxItems, 8192);
  assert.equal(tree.properties.source_manifest.maxItems, 16384);
  assert.deepEqual(schema.$defs.WorkflowAttachmentSnapshot.required, [
    "attachment_id", "issue_id", "title", "url", "source_type", "remote_version", "created_at", "updated_at",
  ]);
  assert.equal(schema.$defs.WorkflowAttachmentSnapshot.additionalProperties, false);
  assert.deepEqual(schema.$defs.WorkflowActivitySnapshot.required, [
    "activity_id", "issue_id", "activity_kinds", "actor_kind", "remote_version", "created_at",
  ]);
  assert.equal(schema.$defs.WorkflowActivitySnapshot.additionalProperties, false);
  assert.deepEqual(schema.$defs.WorkflowActivityKind.enum, [
    "status_changed", "description_changed", "archive_changed", "labels_changed",
    "parent_changed", "delegation_changed", "attachment_changed",
  ]);
  assert.equal(schema.$defs.WorkflowActivitySnapshot.properties.activity_kinds.minItems, 1);
  assert.equal(schema.$defs.WorkflowActivitySnapshot.properties.activity_kinds.uniqueItems, true);
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
  assert.deepEqual(schema.$defs.WorkflowCommentSnapshot.required, [
    "comment_id", "issue_id", "body", "author_kind", "author_id", "thread_root_comment_id",
    "thread_state", "reactions", "created_at", "remote_version", "updated_at",
  ]);
  assert.equal(Object.hasOwn(tree.properties, "comment_" + "thread_changes"), false);
  assert.deepEqual(schema.$defs.WorkflowSourceManifestEntry.properties.source_kind.enum, [
    "linear_issue", "linear_comment", "linear_relation",
    "linear_attachment", "linear_activity", "linear_status_catalog",
  ]);
  assert.equal(schema.$defs.WorkflowRelationSnapshot.additionalProperties, false);
  assert.ok(schema.$defs.UpdateWorkflowIssueCommand.required.includes("is_archived"));
  assert.ok(schema.$defs.UpdateWorkflowIssueCommand.required.includes("parent_assignment"));
  assert.deepEqual(schema.$defs.WorkflowParentAssignment.oneOf.map(({ properties }) => properties.mode.const), [
    "retain", "set", "clear",
  ]);

  assert.deepEqual(schema.$defs.WorkflowMutationCommand.oneOf.map(({ $ref }) => $ref), [
    "#/$defs/CreateWorkflowIssueCommand",
    "#/$defs/UpdateWorkflowIssueCommand",
    "#/$defs/AppendWorkflowCommentCommand",
    "#/$defs/CreateWorkflowAttachmentCommand",
    "#/$defs/CreateCommentReplyCommand",
    "#/$defs/SetCommentReceiptReactionCommand",
    "#/$defs/SetCommentThreadStateCommand",
    "#/$defs/CreateWorkflowRelationCommand",
  ]);
  for (const name of [
    "CreateWorkflowIssueCommand",
    "UpdateWorkflowIssueCommand",
    "AppendWorkflowCommentCommand",
    "CreateWorkflowAttachmentCommand",
    "CreateCommentReplyCommand",
    "SetCommentReceiptReactionCommand",
    "SetCommentThreadStateCommand",
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

test("turn facts and comment replies have closed transient contract shapes", async () => {
  const schema = await loadSchema("conductor-performer");

  assert.deepEqual(schema.$defs.TurnUsage.oneOf.map(({ $ref }) => $ref), [
    "#/$defs/MeasuredTurnUsage",
    "#/$defs/UnavailableTurnUsage",
  ]);
  assert.deepEqual(schema.$defs.MeasuredTurnUsage.required, [
    "status", "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens",
    "total_tokens",
  ]);
  assert.deepEqual(schema.$defs.UnavailableTurnUsage.properties.reason.enum, [
    "provider_omitted", "transport_lost", "process_lost", "invalid_provider_usage",
  ]);
  assert.deepEqual(schema.$defs.ModelTurnRecord.oneOf.map(({ $ref }) => $ref), [
    "#/$defs/RootReconcilerModelTurnRecord",
    "#/$defs/StageModelTurnRecord",
  ]);

  for (const name of ["PlanResult", "WorkResult", "VerifyResult", "RootDirective", "RootReconcilerFailure"]) {
    assert.ok(schema.$defs[name].required.includes("model_turn"), name);
    assert.equal(Object.hasOwn(schema.$defs[name].properties, "usage"), false, name);
  }

  assert.deepEqual(schema.$defs.UserCommentInput.oneOf.map(({ $ref }) => $ref), [
    "#/$defs/UserCommentBodyInput",
    "#/$defs/UserCommentThreadStateInput",
  ]);
  assert.deepEqual(schema.$defs.UserCommentReply.required, [
    "reply_id", "source_input_id", "source",
    "acknowledgement", "interpreted_request", "decided_action", "next_step", "disposition",
    "reaction", "thread_action",
  ]);
  assert.deepEqual(schema.$defs.UserCommentReply.properties.disposition.enum, [
    "accepted", "not_applied", "follow_up_required",
  ]);
  assert.deepEqual(schema.$defs.UserCommentReply.properties.reaction.enum, ["check", "cross", "none"]);
  assert.deepEqual(schema.$defs.UserCommentReply.properties.thread_action.enum, [
    "resolve", "keep_open", "reopen",
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

test("TypeScript validator uses canonical fixtures when directories are omitted", () => {
  const typescript = run("npm", ["run", "contracts:validate:typescript"]);
  assert.equal(typescript.status, 0, typescript.stderr);
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
