import assert from "node:assert/strict";
import test from "node:test";

import {
  auditArchitectureReports,
  inspectAlignment,
  inspectArchitectureEvidence,
  inspectArchitectureTraceRules,
  inspectArchitectureTargets,
  inspectSchemaCoverage,
  inspectSingleAuthority,
} from "../../tools/architecture/audit-alignment.mjs";

const retiredTimelineScope = ["timeline", "projections"].join("-");

test("architecture audit emits exactly the alignment and single-authority reports", async () => {
  const reports = await auditArchitectureReports(process.cwd(), { mode: "static" });

  assert.deepEqual(Object.keys(reports), ["architectureAlignmentReport", "singleAuthorityReport"]);
  assert.equal(reports.architectureAlignmentReport.kind, "ArchitectureAlignmentReport");
  assert.equal(reports.singleAuthorityReport.kind, "SingleAuthorityReport");
  assert.deepEqual(reports.architectureAlignmentReport.findings, []);
  assert.deepEqual(reports.singleAuthorityReport.findings, []);
  assert.ok(reports.architectureAlignmentReport.traces.some(({ id }) => id === "stage_result"));
  assert.ok(reports.singleAuthorityReport.traces.some(({ id }) => id === "workflow_lifecycle"));
});

test("single-authority audit rejects a retired timeline projection path", () => {
  const findings = inspectSingleAuthority(new Map([
    ["apps/conductor/src/unsafe.ts", `class ${retiredTimelineScope} {}`],
  ]));

  assert.deepEqual(findings, [{
    code: "parallel_authority_surface",
    path: "apps/conductor/src/unsafe.ts",
    rule: "retired_timeline_projection",
  }]);
});

test("single-authority audit rejects a parallel lifecycle record", () => {
  const lifecycleRecord = ["Status", "Record"].join("");
  const findings = inspectSingleAuthority(new Map([
    ["apps/conductor/src/unsafe.ts", `type ${lifecycleRecord} = {};`],
  ]));

  assert.deepEqual(findings, [{
    code: "parallel_authority_surface",
    path: "apps/conductor/src/unsafe.ts",
    rule: "parallel_lifecycle_record",
  }]);
});

test("architecture traces require an existing owning document anchor", () => {
  const trace = {
    id: "missing_anchor",
    architectureSource: "docs/architecture/example.md#missing",
    contractPaths: [],
    implementationPaths: [],
    testPaths: [],
  };
  const findings = inspectArchitectureTraceRules(
    [trace],
    new Map(),
    new Map([["docs/architecture/example.md", "# Present"]]),
    "ArchitectureAlignmentReport",
  );

  assert.deepEqual(findings, [{
    code: "trace_architecture_anchor_missing",
    report: "ArchitectureAlignmentReport",
    source: "docs/architecture/example.md#missing",
    traceId: "missing_anchor",
  }]);
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
