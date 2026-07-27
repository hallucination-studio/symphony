import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import {
  MANDATORY_FOREGROUND_CASE_IDS,
  RETIRED_WORKFLOW_E2E_INVENTORY,
  inspectForegroundE2EHardCut,
} from "./foreground-e2e-hard-cut.mjs";

const syntheticCompletion = "target_e2e_" + "synthetic_final";

test("foreground E2E guard fixes the eight mandatory Case IDs", () => {
  assert.deepEqual(MANDATORY_FOREGROUND_CASE_IDS, [
    "approved_happy_path",
    "plan_rejected_and_replanned",
    "information_requested_and_answered",
    "root_revision_and_comment",
    "parallel_multi_conductor",
    "same_conductor_preemption",
    "conductor_restart_recovery",
    "missing_worktree_recovery",
  ]);
});

test("retired E2E inventory remains a complete classified hard-cut baseline", () => {
  assert.equal(RETIRED_WORKFLOW_E2E_INVENTORY.length, 67);
  assert.equal(new Set(RETIRED_WORKFLOW_E2E_INVENTORY.map(({ path }) => path)).size, 67);
  assert.ok(RETIRED_WORKFLOW_E2E_INVENTORY.every(({ replacement }) => typeof replacement === "string"));
});

test("current workflow E2E tree contains none of the retired paths or control symbols", async () => {
  assert.deepEqual(await readWorkflowE2ESources(), new Map());
});

test("foreground E2E guard rejects retired control-plane paths and symbols", () => {
  const findings = inspectForegroundE2EHardCut(new Map([
    ["tools/e2e/required-write-outage.mjs", "export const retired = true;"],
    ["tools/e2e/candidate.mjs", [
      'import { LinearSdkImpl } from "../../packages/podium/src/internal/linear-gateway/internal/LinearSdkImpl.ts";',
      "const outage = createRequiredWriteOutageController();",
      'await readFile("podium.db");',
      `await ${["write", "Managed", "Record"].join("")}({});`,
      `const completion = ${syntheticCompletion};`,
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

async function readWorkflowE2ESources() {
  const paths = await filesUnder(["tools/e2e", "tests/e2e"]);
  const sources = await Promise.all(paths.map(async (path) => [path, await readFile(path, "utf8")]));
  const findings = inspectForegroundE2EHardCut(new Map(sources));
  return new Map(findings.map((finding, index) => [`${index}:${finding.path}`, finding]));
}

async function filesUnder(directories) {
  const paths = [];
  for (const directory of directories) await collect(directory, paths);
  return paths.sort();
}

async function collect(directory, paths) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await collect(path, paths);
    else if (entry.isFile() && path.endsWith(".mjs")) paths.push(path);
  }
}
