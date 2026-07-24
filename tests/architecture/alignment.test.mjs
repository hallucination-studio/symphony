import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectAlignment,
  inspectArchitectureEvidence,
  inspectArchitectureTargets,
  inspectSchemaCoverage,
} from "../../tools/architecture/audit-alignment.mjs";

const timelineProjections = "timeline-" + "projections";

test("static alignment records the pending timeline module hard cut", async () => {
  const { auditArchitectureAlignment } = await import("../../tools/architecture/audit-alignment.mjs");
  assert.deepEqual(await auditArchitectureAlignment(process.cwd(), { mode: "static" }), [{
    code: "architecture_rule_unowned",
    expected: timelineProjections,
    source: "docs/architecture/conductor.md#模块",
  }]);
});

test("full alignment audit remains RED until H09 removes retired records", async () => {
  const { auditArchitectureAlignment } = await import("../../tools/architecture/audit-alignment.mjs");
  const findings = await auditArchitectureAlignment(process.cwd(), { mode: "full" });
  assert.ok(findings.some((finding) =>
    finding.code === "architecture_rule_unowned" && finding.expected === timelineProjections));
  assert.ok(findings.some((finding) =>
    finding.code === "retired_symbol_remaining" &&
    finding.scope === "managed-html-records" &&
    finding.source === "docs/architecture/contracts.md#契约与接口边界"));
});

test("alignment reports missing target paths with their owning architecture source", () => {
  assert.deepEqual(
    inspectArchitectureTargets([
      {
        path: "apps/conductor/src/root-reconciliation/api/RootModels.ts",
        owner: "conductor",
        source: "docs/architecture/root-reconciliation.md#4-bootstrap与delta-contract",
      },
    ], new Map()),
    [{
      code: "missing_target",
      owner: "conductor",
      path: "apps/conductor/src/root-reconciliation/api/RootModels.ts",
      source: "docs/architecture/root-reconciliation.md#4-bootstrap与delta-contract",
    }],
  );
});

test("alignment reports missing interface consumers", () => {
  assert.deepEqual(
    inspectAlignment({
      interfaces: [{
        name: "ExampleInterface",
        path: "src/api/ExampleInterface.ts",
        implementation: "ExampleImpl",
        implementationPath: "src/internal/ExampleImpl.ts",
        owner: "example",
        source: "docs/architecture/contracts.md#main-interfaces",
      }],
      sources: new Map([
        ["src/api/ExampleInterface.ts", "export interface ExampleInterface {}"],
        ["src/internal/ExampleImpl.ts", "export class ExampleImpl implements ExampleInterface {}"],
      ]),
      consumers: [],
      evidence: [],
    }),
    [{
      code: "missing_consumer",
      interface: "ExampleInterface",
      owner: "example",
      path: "src/api/ExampleInterface.ts",
      source: "docs/architecture/contracts.md#main-interfaces",
    }],
  );
});

test("alignment reports owner violations and missing evidence mappings", () => {
  assert.deepEqual(
    inspectAlignment({
      interfaces: [],
      sources: new Map([
        ["apps/conductor/src/unsafe.ts", "import { LinearClient } from '@linear/sdk';"],
      ]),
      consumers: [],
      evidence: [{
        concern: "Root directive materialization",
        source: "docs/architecture/root-reconciliation.md#rootdirective-contract",
        testPaths: ["tests/missing/root-directive.test.mjs"],
      }],
    }),
    [{
      code: "missing_evidence",
      concern: "Root directive materialization",
      source: "docs/architecture/root-reconciliation.md#rootdirective-contract",
      testPath: "tests/missing/root-directive.test.mjs",
    }, {
      code: "owner_violation",
      owner: "podium",
      path: "apps/conductor/src/unsafe.ts",
      rule: "linear_sdk",
    }],
  );
});

test("schema alignment rejects missing generated languages and consumers", () => {
  assert.deepEqual(
    inspectSchemaCoverage(new Map([
      ["packages/contracts/schemas/example/example.schema.json", JSON.stringify({ $defs: { Value: {} } })],
      ["packages/contracts/generated/typescript/contracts.ts", "export type ExampleValue = unknown;"],
    ])),
    [{
      code: "missing_generated_variant",
      definition: "Value",
      family: "example",
      language: "python",
      path: "packages/contracts/generated/python/contracts.py",
    }, {
      code: "missing_generated_variant",
      definition: "Value",
      family: "example",
      language: "rust",
      path: "packages/contracts/generated/rust/src/lib.rs",
    }, {
      code: "missing_schema_consumer",
      family: "example",
      owner: "unassigned",
      source: "docs/architecture/repository-directory.md#contracts",
    }, {
      code: "missing_schema_evidence",
      family: "example",
      path: "tests/contracts/v1-contracts.test.mjs",
      source: "docs/architecture/contracts.md#契约与接口边界",
    }],
  );
});
