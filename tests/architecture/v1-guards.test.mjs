import assert from "node:assert/strict";
import test from "node:test";
import {
  findArchitectureViolations,
  inspectAuthoredFile,
} from "./v1-guards.mjs";

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

test("authored source and schemas obey the static V1 guards", async () => {
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

test("negative controls reject Conductor persistence and future scheduling", () => {
  const cases = [
    ["apps/conductor/src/workflow-db.ts", "export const database = true;", "conductor_persistence"],
    ["apps/conductor/src/main.ts", 'import Database from "better-sqlite3";', "conductor_persistence"],
    ["apps/conductor/src/main.ts", "class LinearPriorityRootSchedulingPolicyImpl {}", "future_scope"],
    ["apps/conductor/src/main.ts", "class BlockerSchedulingPolicyImpl {}", "future_scope"],
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

test("negative controls reject every explicitly excluded V1 product concept", () => {
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
});

test("safe explanatory vocabulary does not trigger implementation guards", () => {
  assert.deepEqual(
    inspectAuthoredFile(
      "apps/conductor/src/main.ts",
      'const summary = "Conductor has no database, checkpoint, Priority, or blocker scheduler";',
    ),
    [],
  );
});
