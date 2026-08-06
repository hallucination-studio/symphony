import assert from "node:assert/strict";
import test from "node:test";

import { runCliSmoke, safeReason } from "./black-box-runner.mjs";

const valid = [
  "run",
  "--linear-root", "ENG-1",
  "--workspace", "/tmp/root-workspace",
  "--dir", "/tmp/root-run",
  "--reconcile-agent", "codex",
  "--reconcile-model", "reconcile-model",
  "--reconcile-reasoning-effort", "medium",
  "--artist-agent", "codex",
  "--artist-model", "execute-model",
  "--artist-reasoning-effort", "high",
  "--critic-agent", "codex",
  "--critic-model", "audit-model",
  "--critic-reasoning-effort", "xhigh",
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
      reconcile_agent: "codex",
      reconcile_model: "reconcile-model",
      reconcile_reasoning_effort: "medium",
      artist_agent: "codex",
      artist_model: "execute-model",
      artist_reasoning_effort: "high",
      critic_agent: "codex",
      critic_model: "audit-model",
      critic_reasoning_effort: "xhigh",
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
    reconcile_agent: "codex", artist_agent: "codex", critic_agent: "codex", max_cycles: 2,
  });
});

test("contract CLI smoke rejects role-level and unknown commands", () => {
  assert.throws(() => runCliSmoke(["cycle", ...valid.slice(1)]), /invalid_public_command/u);
  assert.throws(() => runCliSmoke(["run", "--config", "/tmp/config"]), /unknown_public_option/u);
  assert.throws(() => runCliSmoke(["run", ...valid.slice(1), "--agent", "codex"]), /unknown_public_option/u);
  assert.throws(() => runCliSmoke(valid.map((value) => value === "2" ? "0" : value)), /max_cycles_invalid/u);
});

test("contract runner does not accept a second public control plane", () => {
  for (const command of ["execute", "audit", "task", "dashboard"]) {
    assert.throws(() => runCliSmoke([command, ...valid.slice(1)]), /invalid_public_command/u);
  }
});

test("E2E failures preserve the complete current error message", () => {
  const error = new Error("Current boundary message " + "x".repeat(50), {
    cause: new Error("nested cause must stay hidden"),
  });
  assert.equal(safeReason(error), error.message);
  assert.equal(safeReason(new Error("")), "e2e_runner_failed");
});
