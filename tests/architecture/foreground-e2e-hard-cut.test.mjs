import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import {
  MANDATORY_FOREGROUND_CASE_IDS,
  RETIRED_WORKFLOW_E2E_INVENTORY,
  inspectForegroundE2EHardCut,
} from "./foreground-e2e-hard-cut.mjs";

const execFile = promisify(execFileCallback);

test("foreground E2E guard fixes the seven mandatory Case IDs", () => {
  assert.deepEqual(MANDATORY_FOREGROUND_CASE_IDS, [
    "approved_happy_path",
    "plan_rejected_and_replanned",
    "information_requested_and_answered",
    "root_revision_and_comment",
    "parallel_multi_conductor",
    "same_conductor_preemption",
    "conductor_restart_recovery",
  ]);
});

test("retired E2E inventory names every current workflow E2E file", async () => {
  const { stdout } = await execFile("git", ["ls-files", "tools/e2e", "tests/e2e"], {
    encoding: "utf8",
  });
  const tracked = stdout.split("\n").filter(Boolean).sort();

  assert.deepEqual(RETIRED_WORKFLOW_E2E_INVENTORY.map(({ path }) => path).sort(), tracked);
  assert.ok(RETIRED_WORKFLOW_E2E_INVENTORY.every(({ replacement }) => typeof replacement === "string"));
});

test("foreground E2E guard rejects retired control-plane paths and symbols", () => {
  const findings = inspectForegroundE2EHardCut(new Map([
    ["tools/e2e/required-write-outage.mjs", "export const retired = true;"],
    ["tools/e2e/candidate.mjs", [
      'import { LinearSdkImpl } from "../../packages/podium/src/internal/linear-gateway/internal/LinearSdkImpl.ts";',
      "const outage = createRequiredWriteOutageController();",
      'await readFile("podium.db");',
      "await writeManagedRecord({});",
      "const completion = target_e2e_synthetic_final;",
      'const caseId = "required_linear_write_fail_closed";',
    ].join("\n")],
  ]));

  assert.deepEqual(findings.map(({ code, path, symbol }) => ({ code, path, symbol })), [
    {
      code: "retired_workflow_e2e_path",
      path: "tools/e2e/required-write-outage.mjs",
      symbol: undefined,
    },
    {
      code: "retired_workflow_e2e_symbol",
      path: "tools/e2e/candidate.mjs",
      symbol: "createRequiredWriteOutageController",
    },
    {
      code: "e2e_private_product_import",
      path: "tools/e2e/candidate.mjs",
      symbol: undefined,
    },
    {
      code: "e2e_direct_podium_database_access",
      path: "tools/e2e/candidate.mjs",
      symbol: undefined,
    },
    {
      code: "e2e_managed_record_mutation",
      path: "tools/e2e/candidate.mjs",
      symbol: undefined,
    },
    {
      code: "e2e_synthetic_completion",
      path: "tools/e2e/candidate.mjs",
      symbol: undefined,
    },
    {
      code: "retired_workflow_e2e_symbol",
      path: "tools/e2e/candidate.mjs",
      symbol: "required_linear_write_fail_closed",
    },
  ]);
});
