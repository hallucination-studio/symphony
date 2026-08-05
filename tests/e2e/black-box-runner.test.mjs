import assert from "node:assert/strict";
import test from "node:test";

import { runCliSmoke, safeReason } from "./black-box-runner.mjs";

const valid = [
  "run",
  "--linear-root", "ENG-1",
  "--workspace", "/tmp/root-workspace",
  "--dir", "/tmp/root-run",
  "--agent", "codex",
  "--execute-model", "execute-model",
  "--execute-reasoning-effort", "high",
  "--audit-model", "audit-model",
  "--audit-reasoning-effort", "xhigh",
  "--max-cycles", "2",
];

test("contract CLI smoke accepts the only public Root command", () => {
  assert.deepEqual(runCliSmoke(valid), {
    status: "passed",
    layer: "contract_cli",
    command: "run",
    request: {
      linear_root: "ENG-1",
      workspace_path: "/tmp/root-workspace",
      run_directory: "/tmp/root-run",
      agent: "codex",
      execute_model: "execute-model",
      execute_reasoning_effort: "high",
      audit_model: "audit-model",
      audit_reasoning_effort: "xhigh",
      max_cycles: 2,
    },
  });
});

test("contract CLI smoke defaults to local Codex configuration", () => {
  assert.deepEqual(runCliSmoke([
    "run", "--linear-root", "ENG-1", "--workspace", "/tmp/root-workspace",
    "--dir", "/tmp/root-run", "--max-cycles", "2",
  ]).request, {
    linear_root: "ENG-1", workspace_path: "/tmp/root-workspace", run_directory: "/tmp/root-run",
    agent: "codex", max_cycles: 2,
  });
});

test("contract CLI smoke rejects role-level and unknown commands", () => {
  assert.throws(() => runCliSmoke(["cycle", ...valid.slice(1)]), /invalid_public_command/u);
  assert.throws(() => runCliSmoke(["run", "--config", "/tmp/config"]), /unknown_public_option/u);
  assert.throws(() => runCliSmoke(valid.map((value) => value === "2" ? "0" : value)), /max_cycles_invalid/u);
});

test("contract runner does not accept a second public control plane", () => {
  for (const command of ["execute", "audit", "task", "dashboard"]) {
    assert.throws(() => runCliSmoke([command, ...valid.slice(1)]), /invalid_public_command/u);
  }
});

test("E2E failures expose only the current message's first 50 characters", () => {
  const error = new Error("Current boundary message " + "x".repeat(50), {
    cause: new Error("nested cause must stay hidden"),
  });
  assert.equal(safeReason(error), error.message.slice(0, 50));
  assert.equal(safeReason(new Error("")), "e2e_runner_failed");
});
