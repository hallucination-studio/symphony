import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  auditArchitectureDocs,
  inspectArchitectureAuthority,
  inspectArchitectureSources,
} from "../../tools/architecture/audit-docs.mjs";

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

test("Phase 1 architecture keeps polling observation, generic tools, and Root-owned Cycle decisions closed", async () => {
  const [taskManagement, contracts, rootIssue, rootReconciliation, conductor, performer, delivery, roadmap] = await Promise.all([
    readFile("docs/architecture/task-management.md", "utf8"),
    readFile("docs/architecture/contracts.md", "utf8"),
    readFile("docs/architecture/root-issue.md", "utf8"),
    readFile("docs/architecture/root-reconciliation.md", "utf8"),
    readFile("docs/architecture/conductor.md", "utf8"),
    readFile("docs/architecture/performer.md", "utf8"),
    readFile("docs/architecture/git-worktree-delivery.md", "utf8"),
    readFile("docs/architecture/roadmap.md", "utf8"),
  ]);

  assert.match(taskManagement, /`TaskManageObserver`[^\n]+`TaskObservationEvent`/u);
  assert.match(taskManagement, /没有公网 ingress[^\n]+不依赖 Linear webhook/u);
  assert.match(taskManagement, /polling observation baseline[^\n]+runtime accepted baseline/u);
  assert.match(taskManagement, /不按 delegate\/status 预过滤[^\n]+移除[^\n]+仍可观察/u);
  assert.match(taskManagement, /`from_task_digest` 不要求等于 runtime 已接受的 digest/u);
  assert.match(taskManagement, /不提供 webhook fallback/u);
  assert.match(contracts, /TaskObservationEvent \{[\s\S]+from_task_digest: digest \| null, to_task_digest,[\s\S]+task: TaskSnapshot, task_changes: ConcreteTaskChange\[\]/u);
  assert.match(contracts, /首次观察使用 `from_task_digest: null`、完整 snapshot 和空 changes/u);
  assert.doesNotMatch(
    [taskManagement, contracts, conductor, roadmap].join("\n"),
    /TaskManageWebhook|WakeRoot|provider_event_id/u,
  );
  assert.match(taskManagement, /get_issue[\s\S]+create_issue[\s\S]+update_issue[\s\S]+create_relation/u);
  assert.match(taskManagement, /field_changed: status \| title \| description \| parent \| labels \| delegate \| priority/u);
  assert.doesNotMatch(taskManagement, /StartCycle|ContinueCycle|CloseCycleAndReplan|DeliverVerifiedRevision/u);
  assert.doesNotMatch(contracts, /RootDecision|PlanHandoff|WorkHandoff/u);
  assert.match(contracts, /`precondition_failed` 是 tool result，不是 process-level error/u);
  assert.match(rootIssue, /一个 Root 任意时刻最多有一个 active Cycle/u);
  assert.match(rootIssue, /terminal Cycle 保留为历史事实，不 reopen/u);
  assert.match(rootReconciliation, /继续当前 Cycle/u);
  assert.match(rootReconciliation, /关闭并重跑/u);
  assert.match(rootReconciliation, /Conductor 不实现上述选择/u);
  assert.match(conductor, /不会退出进程、重建 runtime、关闭 Cycle 或替 Root 重试/u);
  assert.match(conductor, /旧 thread 不恢复、不继续、不 replay/u);
  assert.match(performer, /Performer 不获得 Task Manager MCP/u);
  assert.match(delivery, /delivery identity 是 closed tuple/u);
  assert.match(delivery, /Verify 检查的 revision、push 的 revision、remote ref 和 PR head 必须相同/u);
  assert.match(roadmap, /不得 import Conductor private\/unexported modules/u);
  assert.match(roadmap, /所有产品效果都来自 Conductor 本身/u);
});
