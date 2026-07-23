import assert from "node:assert/strict";
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
      "[Inline](podium.md#module)",
      "[Angle](<podium.md#module> \"title\")",
      "[Reference][podium]",
      "[podium]: podium.md#module",
      "[Outside](../README.md)",
      "[External](https://example.com/guide.md)",
    ].join("\n")],
    ["podium.md", "# Module"],
    ["../README.md", "# Repository"],
  ]);

  assert.deepEqual(inspectArchitectureSources(sources), []);
});

test("documentation audit rejects missing files, anchors, and references", () => {
  const sources = new Map([
    ["README.md", [
      "[Missing](missing.md)",
      "[Anchor](podium.md#missing)",
      "[Undefined][unknown]",
    ].join("\n")],
    ["podium.md", "# Module"],
  ]);

  assert.deepEqual(inspectArchitectureSources(sources), [
    { code: "broken_architecture_anchor", file: "README.md", target: "podium.md#missing" },
    { code: "broken_architecture_link", file: "README.md", target: "missing.md" },
    { code: "undefined_architecture_reference", file: "README.md", target: "unknown" },
  ]);
});

test("architecture authority rejects tracked tasks and task references", () => {
  const sources = new Map([
    ["README.md", "# Architecture\n\nSee `tasks/scope-ledgers/root.md`."],
    ["podium.md", "# Podium"],
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
