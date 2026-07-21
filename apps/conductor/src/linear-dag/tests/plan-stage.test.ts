import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "@symphony/contracts";
import type { GitWorkspaceInterface } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface, LinearWorkflowMutationCommand } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { PerformerStageClientInterface } from "../../performer-stage-client/api/PerformerStageClientInterface.js";
import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { buildRootDagView } from "../internal/RootDagViewBuilder.js";
import { LinearDagExecutionImpl } from "../internal/LinearDagExecutionImpl.js";
import { DEFAULT_ROOT_CONVERGENCE_POLICY } from "../../root-workflow/internal/RootConvergencePolicy.js";

const rootIssueId = "root-1";
const now = "2026-07-21T09:00:00Z";

test("executes the Bootstrap Plan with idempotent, read-backed mutation steps", async () => {
  const fake = new FakeLinearGateway({ firstWriteUnconfirmed: true });
  let stageEnvelope: JsonValue | undefined;
  let stageSawExecutionRecord = false;
  const performer: PerformerStageClientInterface = {
    async runStage(input) {
      stageEnvelope = input.envelope;
      stageSawExecutionRecord = fake.tree.comments.some((comment) => comment.body.includes("stage_execution"));
      const envelope = input.envelope as Record<string, JsonValue>;
      const execution = envelope.stage_execution as Record<string, JsonValue>;
      const target = envelope.target as Record<string, JsonValue>;
      return {
        result: {
          protocol_version: "1",
          stage_execution_id: execution.stage_execution_id!,
          stage: "plan",
          root_issue_id: target.root_issue_id!,
          cycle_issue_id: target.cycle_issue_id!,
          node_issue_id: target.node_issue_id!,
          context_digest: envelope.context_digest!,
          completed_at: now,
          usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 2, total_tokens: 32 },
          outcome: {
            kind: "plan_completed",
            plan_contract: {
              objective_summary: "Implement the workflow loop.",
              included_scope: ["workflow loop"],
              excluded_scope: [],
              acceptance_criteria: [{ criterion_key: "loop", statement: "The loop is reproducible.", verification_method: "tests" }],
              work_nodes: [{
                work_key: "implement-loop", title: "Implement loop", description: "Implement the loop.",
                acceptance_criteria: [{ criterion_key: "code", statement: "Code exists.", verification_method: "tests" }], dependency_work_keys: [],
              }],
              verify_node: {
                title: "Verify loop", acceptance_criteria: [{ criterion_key: "verified", statement: "The loop passes.", verification_method: "tests" }], required_checks: ["npm test"],
              },
            },
          },
        } as unknown as JsonValue,
      };
    },
    async cancelAndReap() {},
  };
  const execution = new LinearDagExecutionImpl({ linear: fake, git: fake.git, performer });
  const input = bootstrapInput();
  const result = await execution.executeBootstrapPlan(input);

  assert.equal(result.kind, "awaiting_approval");
  assert.equal(fake.tree.issues.find((issue) => issue.issue_kind === "cycle")?.status_name, "Planning");
  assert.equal(fake.tree.issues.find((issue) => issue.issue_kind === "plan")?.status_name, "In Review");
  assert.equal(fake.tree.issues.find((issue) => issue.issue_kind === "root")?.status_name, "Needs Approval");
  assert.ok(stageEnvelope);
  assert.equal(stageSawExecutionRecord, true);
  assert.equal(fake.tree.comments.filter((comment) => comment.body.includes('"kind":"plan_contract"')).length, 1);
  assert.equal(buildRootDagView({ tree: fake.tree, git: await fake.git.inspect(input.workspace), workspace: input.workspace }).root.issue.status_name, "Needs Approval");

  const writesBeforeRetry = fake.writes.length;
  const retry = await execution.executeBootstrapPlan(input);
  assert.equal(retry.planContractDigest, result.planContractDigest);
  assert.equal(fake.writes.length, writesBeforeRetry);
});

test("persists a breaker decision before creating a Cycle and stops later dispatch", async () => {
  const fake = new FakeLinearGateway({ firstWriteUnconfirmed: false });
  const execution = new LinearDagExecutionImpl(
    { linear: fake, git: fake.git, performer: { async runStage() { throw new Error("must_not_run"); }, async cancelAndReap() {} } },
    undefined,
    undefined,
    { ...DEFAULT_ROOT_CONVERGENCE_POLICY, deadlineAt: "2026-07-21T08:59:59Z" },
  );
  const input = bootstrapInput();

  assert.deepEqual(await execution.reconcileRoot(input), { kind: "mutation_applied", step: "convergence_decision_persisted" });
  assert.equal(fake.tree.issues.some((issue) => issue.issue_kind === "cycle"), false);
  assert.equal(fake.tree.comments.filter((comment) => comment.body.includes('"kind":"convergence"')).length, 1);
  assert.equal(fake.writes.length, 1);

  assert.deepEqual(await execution.reconcileRoot(input), { kind: "blocked", reason: "convergence_deadline_exceeded" });
  assert.equal(fake.writes.length, 1);
});

for (const rootStatus of ["Done", "Canceled"] as const) {
  test(`rejects a late Plan Result after Root ${rootStatus}`, async () => {
    const fake = new FakeLinearGateway({ firstWriteUnconfirmed: false });
    const root = fake.tree.issues.find((issue) => issue.issue_id === rootIssueId)!;
    const status = fake.tree.status_catalog.find((candidate) => candidate.name === rootStatus)!;
    Object.assign(root, {
      status_id: status.status_id,
      status_name: status.name,
      status_category: status.category,
      status_position: status.position,
    });
    const execution = new LinearDagExecutionImpl({
      linear: fake,
      git: fake.git,
      performer: { async runStage() { throw new Error("must_not_run"); }, async cancelAndReap() {} },
    });

    assert.deepEqual(await execution.reconcileRoot(bootstrapInput(), { stage_execution_id: "old-plan-execution" } as unknown as JsonValue), {
      kind: "blocked",
      reason: "root_terminal_result_rejected",
    });
    assert.equal(fake.writes.length, 0);
  });
}

function bootstrapInput() {
  return {
    rootIssueId,
    projectId: "project-1",
    workspace: { branch: "symphony/root-1", worktreePath: "/tmp/root-1", rootIssueId },
    options: {
      conductorShortHash: "cond",
      repositoryIdentity: "symphony",
      baseBranch: "main",
      performerProfileId: "profile-1",
      modelSettings: { model: "gpt-5.4", reasoningEffort: "high" as const, isFastModeEnabled: false },
      limits: { maxContextBytes: 1_048_576, maxResultBytes: 262_144, maxWallTimeMs: 3_600_000, maxToolCalls: 10, maxCommandDurationMs: 300_000, reservedTotalTokens: 50_000, maxOutputTokens: 8_000 },
      instructionSetId: "plan-v1",
      stageInstructions: "Produce a bounded Plan Contract.",
      now: () => now,
      stageId: (_root: string, _cycle: string, attempt: number) => `root-1:plan:execution-${attempt}`,
    },
  };
}

class FakeLinearGateway implements LinearGatewayInterface {
  readonly writes: string[] = [];
  readonly git: GitWorkspaceInterface = {
    async inspect() { return { head: "head-1", branch: "symphony/root-1", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } }; },
    async diff() { return { text: "", bytes: 0, cap: 65_536, partial: false }; },
    async checks() { return { items: [], returned: 0, cap: 32, has_more: false, partial: false }; },
    async commit() { throw new Error("unused"); },
  };
  tree: ReturnType<typeof initialTree>;
  private readonly firstWriteUnconfirmed: boolean;

  constructor(options: { firstWriteUnconfirmed: boolean }) {
    this.tree = initialTree();
    this.firstWriteUnconfirmed = options.firstWriteUnconfirmed;
  }

  async readWorkflowIssueTree() { return structuredClone(this.tree); }
  async readFreshRootScope(): Promise<never> { throw new Error("unused"); }
  async read(): Promise<never> { throw new Error("unused"); }
  async mutate(): Promise<never> { throw new Error("unused"); }

  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.writes.push(command.writeId);
    if (command.kind === "create_workflow_issue") {
      const id = command.issueKind === "cycle" ? "cycle-1" : "plan-1";
      const parent = this.tree.issues.find((issue) => issue.issue_id === command.parentIssueId)!;
      const status = this.tree.status_catalog.find((candidate) => candidate.status_id === command.statusId)!;
      this.tree.issues.push({ issue_id: id, identifier: id, project_id: command.expectedProjectId, parent_issue_id: parent.issue_id, status_id: status.status_id, status_name: status.name, status_category: status.category, status_position: status.position, order: this.tree.issues.length, depth: parent.depth + 1, title: command.title, description: command.description, managed_marker: command.managedMarker, issue_kind: command.issueKind, remote_version: `${id}-version`, updated_at: now });
      return this.outcome(command.writeId, id, `${id}-version`);
    }
    if (command.kind === "update_workflow_issue") {
      const issue = this.tree.issues.find((candidate) => candidate.issue_id === command.target.targetIssueId)!;
      const status = this.tree.status_catalog.find((candidate) => candidate.status_id === command.statusId)!;
      issue.status_id = status.status_id; issue.status_name = status.name; issue.status_category = status.category; issue.status_position = status.position; issue.remote_version = `${issue.issue_id}-${this.writes.length}`;
      return this.outcome(command.writeId, issue.issue_id, issue.remote_version);
    }
    if (command.kind === "append_workflow_comment") {
      const target = this.tree.issues.find((issue) => issue.issue_id === command.target.targetIssueId)!;
      this.tree.comments.push({ comment_id: `comment-${this.tree.comments.length + 1}`, issue_id: target.issue_id, body: command.body, managed_marker: command.writeId, remote_version: `comment-${this.tree.comments.length + 1}-version`, updated_at: now });
      return this.outcome(command.writeId, target.issue_id, `${target.issue_id}-version`);
    }
    throw new Error("unused");
  }

  private outcome(writeId: string, targetIssueId: string, remoteVersion: string) {
    const result = { writeId, targetIssueId, remoteVersion };
    if (this.firstWriteUnconfirmed && this.writes.length === 1) return { kind: "write_unconfirmed" as const, readBackTarget: result };
    return { kind: "applied" as const, readBack: result };
  }
}

function initialTree(): LinearWorkflowTreeSnapshot {
  const statusCatalog = ([
    ["Draft", "backlog"], ["Todo", "unstarted"], ["Planning", "started"], ["Sealed", "started"], ["Executing", "started"], ["Verifying", "started"], ["In Progress", "started"], ["In Review", "started"], ["Needs Approval", "started"], ["Needs Info", "started"], ["Inconclusive", "started"], ["Escalated", "started"], ["Succeeded", "completed"], ["Changes Required", "completed"], ["Done", "completed"], ["Canceled", "canceled"], ["Failed", "canceled"],
  ] as const).map(([name, category], position) => ({ status_id: `status-${position}`, name, category, position }));
  const rootStatus = statusCatalog.find((status) => status.name === "In Progress")!;
  return {
    root_issue_id: rootIssueId,
    status_catalog: statusCatalog,
    issues: [{ issue_id: rootIssueId, identifier: "ROOT-1", project_id: "project-1", status_id: rootStatus.status_id, status_name: rootStatus.name, status_category: rootStatus.category, status_position: rootStatus.position, order: 0, depth: 0, title: "Workflow", description: "Implement the workflow loop.", issue_kind: "root" as const, remote_version: "root-version", updated_at: now }],
    comments: [],
    relations: [],
    observed_at: now,
  };
}
