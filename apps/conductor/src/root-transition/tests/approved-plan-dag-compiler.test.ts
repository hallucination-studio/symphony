import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { LinearWorkflowMutationCommand, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { buildRootFactSet } from "../../root-reconciliation/internal/RootFactSet.js";
import { renderCanonicalPlanDescription } from "../../root-reconciliation/internal/CanonicalPlanDescription.js";
import { ApprovedPlanDagCompilerImpl } from "../internal/ApprovedPlanDagCompilerImpl.js";

test("Approved Plan converges Work, Verify, dependencies, Plan Done and Cycle Sealed one effect at a time", () => {
  const state = fixture();
  const compiler = new ApprovedPlanDagCompilerImpl();
  const kinds: string[] = [];

  for (let step = 0; step < 6; step += 1) {
    const input = state.input();
    const result = compiler.compile(input);
    assert.equal(result.kind, "effect");
    if (result.kind !== "effect") return;
    kinds.push(effectName(result.command));
    state.apply(result.command);
  }

  assert.deepEqual(kinds, [
    "create:work", "create:work", "create:verify", "relation:blocks", "plan:Done", "cycle:Sealed",
  ]);
  const sealed = compiler.compile(state.input());
  assert.equal(sealed.kind, "satisfied");
  assert.ok(sealed.kind === "satisfied" && sealed.sealDigest);
  assert.match(sealed.sealDigest, /^[a-f0-9]{64}$/u);
  const works = state.tree.issues.filter(({ issue_kind }) => issue_kind === "work").sort((a, b) => a.order - b.order);
  assert.equal(works.length, 2);
  assert.equal(state.tree.relations[0]?.source_issue_id, works[0]?.issue_id);
  assert.equal(state.tree.relations[0]?.target_issue_id, works[1]?.issue_id);
});

test("Approved Plan validates the complete candidate before creating its first node", () => {
  for (const mutate of [
    (document: ReturnType<typeof planDocument>) => { document.proposedWorkDag.workNodes[1]!.proposalKey = "contract"; },
    (document: ReturnType<typeof planDocument>) => { document.proposedWorkDag.workNodes[1]!.dependencyProposalKeys = ["missing"]; },
    (document: ReturnType<typeof planDocument>) => { document.proposedWorkDag.workNodes[0]!.dependencyProposalKeys = ["runtime"]; },
  ]) {
    const state = fixture(mutate);
    assert.deepEqual(new ApprovedPlanDagCompilerImpl().compile(state.input()), {
      kind: "invalid_facts", reason: "topology_invalid",
    });
    assert.equal(state.tree.issues.filter(({ issue_kind }) => issue_kind === "work").length, 0);
  }
});

test("Approved Plan resumes partial Work materialization after native order changes", () => {
  const state = fixture();
  const compiler = new ApprovedPlanDagCompilerImpl();
  const first = compiler.compile(state.input());
  assert.equal(first.kind, "effect");
  if (first.kind !== "effect") return;
  state.apply(first.command);

  const created = state.tree.issues.find(({ issue_kind }) => issue_kind === "work");
  assert.ok(created);
  created.order = 42;

  const resumed = compiler.compile(state.input());
  assert.equal(resumed.kind, "effect");
  assert.ok(resumed.kind === "effect" && resumed.command.kind === "create_workflow_issue");
  if (resumed.kind !== "effect" || resumed.command.kind !== "create_workflow_issue") return;
  assert.equal(resumed.command.title, "Runtime");
  assert.equal(resumed.command.order, 2);
});

test("Approved Plan rejects indistinguishable Work proposals before the first write", () => {
  const state = fixture((document) => {
    const first = document.proposedWorkDag.workNodes[0]!;
    const second = document.proposedWorkDag.workNodes[1]!;
    Object.assign(second, {
      title: first.title,
      description: first.description,
      expectedOutcome: first.expectedOutcome,
      requiredChecks: [...first.requiredChecks],
    });
  });

  assert.deepEqual(new ApprovedPlanDagCompilerImpl().compile(state.input()), {
    kind: "invalid_facts",
    reason: "topology_invalid",
  });
  assert.equal(state.tree.issues.filter(({ issue_kind }) => issue_kind === "work").length, 0);
});

function fixture(mutate?: (document: ReturnType<typeof planDocument>) => void) {
  const document = planDocument();
  mutate?.(document);
  const observedAt = "2026-07-29T00:00:00Z";
  const tree: LinearWorkflowTreeSnapshot = {
    root_issue_id: "root-1",
    status_catalog: [
      { status_id: "progress", name: "In Progress", category: "started", position: 1 },
      { status_id: "planning", name: "Planning", category: "started", position: 2 },
      { status_id: "approved", name: "Approved", category: "started", position: 3 },
      { status_id: "todo", name: "Todo", category: "unstarted", position: 4 },
      { status_id: "done", name: "Done", category: "completed", position: 5 },
      { status_id: "sealed", name: "Sealed", category: "started", position: 6 },
    ],
    issues: [
      issue("root-1", "SYM-1", "root", undefined, "progress", "In Progress", 0, "Root", "Requirement", "root-v1", observedAt),
      issue("cycle-1", "SYM-2", "cycle", "root-1", "planning", "Planning", 0, "Cycle", "Planning", "cycle-v1", observedAt),
      issue("plan-1", "SYM-3", "plan", "cycle-1", "approved", "Approved", 0, "Plan",
        renderCanonicalPlanDescription(document), "plan-v2", observedAt),
    ],
    comments: [], relations: [], attachments: [], activities: [], source_manifest: [],
    coverage: { is_complete: true, omissions: [] }, observed_at: observedAt,
  };
  let created = 0;
  const root = {
    issueId: "root-1", identifier: "SYM-1", state: "In Progress" as const, updatedAt: observedAt,
    projectId: "project-1", priority: "normal" as const, blockers: [], rootConductorLabels: [],
    isDelegatedToSymphony: true, isArchived: false,
  };
  const gate = {
    kind: "valid" as const, repositoryIdentity: "repo-1", branch: "symphony/runs/sym-1",
    headRevision: "head-1", isClean: true, changedPaths: [],
  };
  return {
    tree,
    input() {
      const facts = buildRootFactSet({
        root, tree, worktreeGate: gate, mechanicalViolations: [],
        convergence: {
          policy: { maxCyclesPerRoot: 3, maxSameOpenFindingCycles: 2, maxCycleRepairAttempts: 2, deadlineAt: "2026-07-30T00:00:00Z" },
          view: { cycleCount: 1, activeCycleIssueId: "cycle-1", openFindingPersistence: [], activeCycleRepairAttempts: 0, isDeadlineExceeded: false, rootIsCanceled: false },
        },
      }).bootstrap;
      const view: RootReconciliationView = {
        root, tree, worktreeGate: gate,
        workspace: { branch: gate.branch, worktreePath: "/tmp/root-1", rootIssueId: "root-1" },
        git: { head: gate.headRevision, branch: gate.branch, status: { items: [], returned: 0, cap: 16, has_more: false, partial: false } },
        observedAt: tree.observed_at, treeDigest: facts.rootDigest, complete: true,
      };
      const plan = tree.issues.find(({ issue_id }) => issue_id === "plan-1")!;
      return {
        target: {
          kind: "converge_approved_plan_dag" as const, cycleIssueId: "cycle-1", planIssueId: "plan-1",
          planContentDigest: digest(plan.description), expectedWorktreeGate: gate,
        },
        facts, view,
      };
    },
    apply(command: LinearWorkflowMutationCommand) {
      if (command.kind === "create_workflow_issue") {
        created += 1;
        const kind = command.labelNames.includes("symphony:kind/verify") ? "verify" : "work";
        tree.issues.push(issue(
          `${kind}-${created}`, `SYM-${created + 3}`, kind, command.parentIssueId, command.statusId, "Todo",
          command.order ?? created, command.title, command.description, `${kind}-${created}-v1`, `2026-07-29T00:0${created}:00Z`,
        ));
        return;
      }
      if (command.kind === "create_workflow_relation") {
        tree.relations.push({
          relation_id: `relation-${tree.relations.length + 1}`, relation_kind: command.relationKind,
          source_issue_id: command.sourceIssueId, target_issue_id: command.targetIssueId,
        });
        return;
      }
      if (command.kind === "update_workflow_issue") {
        const target = tree.issues.find(({ issue_id }) => issue_id === command.target.targetIssueId)!;
        const status = tree.status_catalog.find(({ status_id }) => status_id === command.statusId)!;
        Object.assign(target, { status_id: status.status_id, status_name: status.name, remote_version: `${target.remote_version}-next` });
      }
    },
  };
}

function planDocument() {
  const criterion = { criterionKey: "criterion-1", statement: "The DAG is complete.", verificationMethod: "Inspect native facts." };
  return {
    summary: "Approved DAG.",
    planContract: {
      objective: "Build it.", includedScope: ["runtime"], excludedScope: [], assumptions: [], constraints: [],
      acceptanceCriteria: [criterion], verificationRequirements: ["Run tests."],
    },
    proposedWorkDag: {
      workNodes: [
        { proposalKey: "contract", title: "Contract", description: "Define it.", expectedOutcome: "Defined.", requiredChecks: ["contract test"], dependencyProposalKeys: [] },
        { proposalKey: "runtime", title: "Runtime", description: "Use it.", expectedOutcome: "Composed.", requiredChecks: ["runtime test"], dependencyProposalKeys: ["contract"] },
      ],
      dependencyEdges: [],
      verifyNode: { title: "Verify", acceptanceCriteria: [criterion], requiredChecks: ["contract test", "runtime test"] },
    },
    risks: [], requiredPermissions: [],
  };
}

function issue(
  id: string, identifier: string, kind: "root" | "cycle" | "plan" | "work" | "verify", parent: string | undefined,
  statusId: string, statusName: "In Progress" | "Planning" | "Approved" | "Todo", order: number,
  title: string, description: string, remoteVersion: string, timestamp: string,
): LinearWorkflowTreeSnapshot["issues"][number] {
  return {
    issue_id: id, identifier, project_id: "project-1", ...(parent ? { parent_issue_id: parent } : {}),
    status_id: statusId, status_name: statusName, status_category: statusName === "Todo" ? "unstarted" : "started",
    status_position: 1, order, depth: kind === "root" ? 0 : kind === "cycle" ? 1 : 2,
    title, description, labels: [`symphony:kind/${kind}`], is_archived: false, issue_kind: kind,
    remote_version: remoteVersion, created_at: timestamp, updated_at: timestamp,
  };
}

function effectName(command: LinearWorkflowMutationCommand): string {
  if (command.kind === "create_workflow_issue") {
    return `create:${command.labelNames.includes("symphony:kind/verify") ? "verify" : "work"}`;
  }
  if (command.kind === "create_workflow_relation") return `relation:${command.relationKind}`;
  if (command.kind === "update_workflow_issue") {
    return command.target.targetIssueId === "plan-1" ? "plan:Done" : "cycle:Sealed";
  }
  return command.kind;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
