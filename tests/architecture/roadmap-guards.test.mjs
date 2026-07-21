import assert from "node:assert/strict";
import test from "node:test";
import {
  findArchitectureViolations,
  inspectAuthoredFile,
} from "./roadmap-guards.mjs";

const root = process.cwd();

function assertViolationCases(cases) {
  for (const [file, source, code] of cases) {
    assert.ok(
      inspectAuthoredFile(file, source).some(
        (violation) => violation.code === code,
      ),
      `${file} should produce ${code}`,
    );
  }
}

test("authored source and schemas obey the static Roadmap 2 guards", async () => {
  assert.deepEqual(await findArchitectureViolations(root), []);
});

test("negative controls reject SDK ownership and cross-role imports", () => {
  const cases = [
    [
      "apps/conductor/src/bad.ts",
      'import { LinearClient } from "@linear/sdk";',
      "linear_sdk_outside_podium",
    ],
    [
      "packages/podium/src/internal/bad.ts",
      'import { Codex } from "openai-codex";',
      "provider_sdk_outside_performer_backend",
    ],
    [
      "apps/conductor/src/bad.ts",
      'import { thing } from "@symphony/podium";',
      "cross_role_import",
    ],
    [
      "apps/conductor/src/bad.ts",
      'export { thing } from "@symphony/podium";',
      "cross_role_import",
    ],
    [
      "apps/conductor/src/bad.ts",
      'const module = import("@symphony/podium");',
      "cross_role_import",
    ],
    [
      "apps/podium-desktop/src/bad.ts",
      'import { thing } from "@symphony/podium/internal/linear-auth";',
      "cross_role_internal_import",
    ],
  ];

  assertViolationCases(cases);
});

test("negative controls reject Conductor persistence", () => {
  const cases = [
    ["apps/conductor/src/workflow-db.ts", "export const database = true;", "conductor_persistence"],
    ["apps/conductor/src/main.ts", 'import Database from "better-sqlite3";', "conductor_persistence"],
    ["apps/conductor/src/main.ts", "class RootCheckpoint {}", "conductor_persistence"],
    ["apps/conductor/src/main.ts", "class DispatchQueue {}", "conductor_persistence"],
    ["apps/conductor/src/main.ts", "class OperationJournal {}", "conductor_persistence"],
    [
      "apps/conductor/src/main.ts",
      'readFile(path.join(process.env.CODEX_HOME, "auth.json"));',
      "codex_owned_file_access",
    ],
    [
      "packages/podium/src/internal/root-policy.ts",
      "class RootActionPolicyImpl {}",
      "podium_workflow_policy",
    ],
  ];

  assertViolationCases(cases);
});

test("approved Roadmap 2 scheduling vocabulary is inside the active boundary", () => {
  const cases = [
    [
      "apps/conductor/src/root-scheduling/internal/LinearPriorityRootSchedulingPolicyImpl.ts",
      "export class LinearPriorityRootSchedulingPolicyImpl {}",
    ],
    [
      "apps/conductor/src/root-scheduling/internal/BlockerSchedulingPolicyImpl.ts",
      "export class BlockerSchedulingPolicyImpl {}",
    ],
    [
      "apps/conductor/src/root-discovery/MultiRootDiscoveryPolicy.ts",
      "export class MultiRootDiscoveryPolicy {}",
    ],
  ];

  for (const [file, source] of cases) {
    assert.deepEqual(inspectAuthoredFile(file, source), []);
  }
});

test("retired Conductor turn observation surfaces are rejected", () => {
  assertViolationCases([
    [
      "apps/conductor/src/composition/PerformerTurnObservation.ts",
      "export type PerformerTurnObservation = unknown;",
      "retired_conductor_surface",
    ],
    [
      "apps/conductor/src/runtime-reporting/internal/RuntimeConvergence.ts",
      "export function applyCorrelatedTurnResult() {}",
      "retired_conductor_surface",
    ],
  ]);
});

test("approved managed evidence vocabulary is inside the active boundary", () => {
  for (const [file, source] of [
    ["apps/conductor/src/root-workflow/api/ManagedRecords.ts", "interface CheckEvidence {} interface FindingEvidence {}"],
    ["apps/conductor/src/root-workflow/internal/RootConvergencePolicy.ts", "interface RootSelectionEvidence {}"],
  ]) {
    assert.deepEqual(inspectAuthoredFile(file, source), []);
  }
  assertViolationCases([
    ["apps/conductor/src/bad.ts", "class AcceptanceEvidence {}", "future_product_scope"],
  ]);
});

test("negative controls reject browser secrets and arbitrary provider config", () => {
  const cases = [
    [
      "packages/contracts/schemas/podium-client/bad.schema.json",
      '{"properties":{"accessToken":{"type":"string"}}}',
      "browser_secret_surface",
    ],
    [
      "packages/contracts/schemas/podium-client/bad.schema.json",
      '{"properties":{"codex_home":{"type":"string"}}}',
      "browser_secret_surface",
    ],
    [
      "packages/contracts/schemas/conductor-performer/bad.schema.json",
      '{"properties":{"provider_config":{"type":"object"}}}',
      "arbitrary_provider_config",
    ],
  ];

  assertViolationCases(cases);
});

test("negative controls reject every concept outside the Roadmap 2 boundary", () => {
  const names = [
    "ParallelPerformerLane",
    "PlanRevisionStore",
    "WorkflowCheckpoint",
    "DispatchQueue",
    "OperationJournal",
    "VerificationResult",
    "DeliveryManifest",
    "AcceptanceEvidence",
    "DeliveryReceipt",
    "ClaudeBackend",
    "SecondProviderRegistry",
    "WebApplication",
    "EncryptedProfileStore",
    "ProfileDatabase",
    "AutomaticMergePolicy",
    "AutomaticRootDoneAction",
    "CompatibilityShim",
  ];
  assertViolationCases(
    names.map((name) => [
      "apps/conductor/src/bad.ts",
      `class ${name} {}`,
      "future_product_scope",
    ]),
  );
  const violation = inspectAuthoredFile(
    "apps/conductor/src/bad.ts",
    "class ParallelPerformerLane {}",
  ).find(({ code }) => code === "future_product_scope");
  assert.match(violation?.summary ?? "", /Roadmap 2/u);
  assert.doesNotMatch(violation?.summary ?? "", /V1/u);
});

test("safe explanatory vocabulary does not trigger implementation guards", () => {
  assert.deepEqual(
    inspectAuthoredFile(
      "apps/conductor/src/main.ts",
      'const summary = "Conductor has no database, checkpoint, Priority, or blocker scheduler";',
    ),
    [],
  );
  assert.deepEqual(
    inspectAuthoredFile(
      "apps/conductor/src/root-workflow/internal/RootConvergencePolicy.ts",
      "interface RootWorkspaceEvidence { rootIssueId: string; }",
    ),
    [],
  );
});

test("negative controls reject retired Conductor paths and vocabulary", () => {
  for (const [file, source] of [
    ["apps/conductor/src/agent-symphony-harness/internal/retired.ts", "export const value = 1;"],
    ["apps/conductor/src/target.ts", "export type Retired = \"V3\";"],
    ["apps/conductor/src/target.ts", "export interface RootTurnInput {}"],
    ["apps/conductor/src/target.ts", "export interface AgentCommand {}"],
  ]) {
    assert.ok(inspectAuthoredFile(file, source).some(({ code }) => code === "retired_conductor_surface"));
  }
});

test("negative controls reject retired Performer paths and protocol vocabulary", () => {
  for (const [file, source] of [
    ["apps/performer/src/performer/root_turn/retired.py", "value = 1"],
    ["apps/performer/src/performer/target.py", "class RootTurnRuntime: pass"],
    ["apps/performer/src/performer/target.py", "class AgentCommandClient: pass"],
    ["packages/contracts/schemas/conductor-performer/retired.schema.json", "Protocol V3"],
    ["packages/contracts/schemas/conductor-performer/retired.schema.json", "RootTurnResult"],
  ]) {
    assert.ok(inspectAuthoredFile(file, source).some(({ code }) => code === "retired_performer_surface"));
  }
});
