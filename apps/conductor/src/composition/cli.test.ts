import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArguments } from "./cli.js";

const valid = [
  "run",
  "--linear-root", "ENG-123",
  "--workspace", "/tmp/root-workspace",
  "--dir", "/tmp/root-run",
  "--reconcile-agent", "codex",
  "--reconcile-model", "reconcile-model",
  "--reconcile-reasoning-effort", "medium",
  "--execute-agent", "codex",
  "--execute-model", "execute-model",
  "--execute-reasoning-effort", "high",
  "--audit-agent", "codex",
  "--audit-model", "audit-model",
  "--audit-reasoning-effort", "xhigh",
  "--max-cycles", "4",
];

test("parses the one public Root-run command", () => {
  assert.deepEqual(parseCliArguments(valid), {
    linear_root: "ENG-123",
    workspace_path: "/tmp/root-workspace",
    run_directory: "/tmp/root-run",
    reconcile_agent: "codex",
    reconcile_model: "reconcile-model",
    reconcile_reasoning_effort: "medium",
    execute_agent: "codex",
    execute_model: "execute-model",
    execute_reasoning_effort: "high",
    audit_agent: "codex",
    audit_model: "audit-model",
    audit_reasoning_effort: "xhigh",
    max_cycles: 4,
  });
});

test("defaults each role agent to Codex and leaves overrides optional", () => {
  assert.deepEqual(parseCliArguments([
    "run", "--linear-root", "ENG-123", "--workspace", "/tmp/root-workspace",
    "--dir", "/tmp/root-run", "--max-cycles", "4",
  ]), {
    linear_root: "ENG-123", workspace_path: "/tmp/root-workspace", run_directory: "/tmp/root-run",
    reconcile_agent: "codex", execute_agent: "codex", audit_agent: "codex", max_cycles: 4,
  });
});

test("omits a preferred workspace so Prepare adopts the current checkout", () => {
  assert.deepEqual(parseCliArguments([
    "run", "--linear-root", "ENG-123", "--dir", "/tmp/root-run", "--max-cycles", "4",
  ]), {
    linear_root: "ENG-123", run_directory: "/tmp/root-run",
    reconcile_agent: "codex", execute_agent: "codex", audit_agent: "codex", max_cycles: 4,
  });
});

test("keeps each role override independently optional", () => {
  assert.deepEqual(parseCliArguments([
    "run", "--linear-root", "ENG-123", "--workspace", "/tmp/root-workspace",
    "--dir", "/tmp/root-run", "--reconcile-model", "reconcile-only",
    "--execute-agent", "codex", "--execute-model", "execute-only",
    "--audit-reasoning-effort", "xhigh", "--max-cycles", "4",
  ]), {
    linear_root: "ENG-123", workspace_path: "/tmp/root-workspace", run_directory: "/tmp/root-run",
    reconcile_agent: "codex", reconcile_model: "reconcile-only", execute_agent: "codex",
    execute_model: "execute-only", audit_agent: "codex", audit_reasoning_effort: "xhigh", max_cycles: 4,
  });
});

test("rejects role-level commands and retired config launch", () => {
  assert.throws(() => parseCliArguments(["cycle", ...valid.slice(1)]), /invalid_command/u);
  assert.throws(() => parseCliArguments(["run", "--config", "/tmp/config.json"]), /unknown_option/u);
  assert.throws(() => parseCliArguments(["run", ...valid.slice(1), "--agent", "codex"]), /unknown_option/u);
});

test("rejects missing, duplicate, unknown, and malformed options", () => {
  assert.throws(() => parseCliArguments(valid.slice(0, -2)), /missing_option/u);
  assert.throws(() => parseCliArguments([...valid, "--reconcile-model", "other"]), /duplicate_option/u);
  assert.throws(() => parseCliArguments([...valid, "--extra", "value"]), /unknown_option/u);
  assert.throws(() => parseCliArguments(valid.map((value) => value === "4" ? "0" : value)), /invalid_max_cycles/u);
});
