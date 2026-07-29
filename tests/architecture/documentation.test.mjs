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

test("Phase 1 architecture keeps the approved hard-cut decisions closed", async () => {
  const [contracts, rootIssue, conductor, delivery] = await Promise.all([
    readFile("docs/architecture/contracts.md", "utf8"),
    readFile("docs/architecture/root-issue.md", "utf8"),
    readFile("docs/architecture/conductor.md", "utf8"),
    readFile("docs/architecture/git-worktree-delivery.md", "utf8"),
  ]);

  assert.match(contracts, /PlanHandoff\.outcome[^\n]+completed \| failed \| canceled/u);
  assert.match(contracts, /WorkHandoff\.outcome[^\n]+completed \| failed \| canceled/u);
  assert.match(contracts, /Phase 1 唯一接受值为 `1`/u);
  assert.match(rootIssue, /required Work[^\n]+全部且仅有/u);
  assert.match(conductor, /只允许一个 primary restart transition/u);
  assert.match(conductor, /旧 thread 不恢复、不继续，也不作为第二执行路径/u);
  assert.match(delivery, /delivery identity 是 closed tuple/u);
  assert.match(delivery, /不提供\n(?:.*\n)*?fallback provider、alternate branch、force push/u);
});
