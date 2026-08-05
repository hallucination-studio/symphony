import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArguments } from "./cli.js";

const valid = [
  "run",
  "--linear-root", "ENG-123",
  "--workspace", "/tmp/root-workspace",
  "--dir", "/tmp/root-run",
  "--execute-model", "execute-model",
  "--execute-reasoning-effort", "high",
  "--audit-model", "audit-model",
  "--audit-reasoning-effort", "xhigh",
  "--max-cycles", "4",
];

test("parses the one public Root-run command", () => {
  assert.deepEqual(parseCliArguments(valid), {
    linear_root: "ENG-123",
    workspace_path: "/tmp/root-workspace",
    run_directory: "/tmp/root-run",
    agent: "codex",
    execute_model: "execute-model",
    execute_reasoning_effort: "high",
    audit_model: "audit-model",
    audit_reasoning_effort: "xhigh",
    max_cycles: 4,
  });
});

test("defaults the agent to Codex and leaves role configuration to local Codex defaults", () => {
  assert.deepEqual(parseCliArguments([
    "run", "--linear-root", "ENG-123", "--workspace", "/tmp/root-workspace",
    "--dir", "/tmp/root-run", "--max-cycles", "4",
  ]), {
    linear_root: "ENG-123", workspace_path: "/tmp/root-workspace", run_directory: "/tmp/root-run",
    agent: "codex", max_cycles: 4,
  });
});

test("keeps each role override independently optional", () => {
  assert.deepEqual(parseCliArguments([
    "run", "--linear-root", "ENG-123", "--workspace", "/tmp/root-workspace",
    "--dir", "/tmp/root-run", "--execute-model", "execute-only",
    "--audit-reasoning-effort", "xhigh", "--max-cycles", "4",
  ]), {
    linear_root: "ENG-123", workspace_path: "/tmp/root-workspace", run_directory: "/tmp/root-run",
    agent: "codex", execute_model: "execute-only", audit_reasoning_effort: "xhigh", max_cycles: 4,
  });
});

test("rejects role-level commands and retired config launch", () => {
  assert.throws(() => parseCliArguments(["cycle", ...valid.slice(1)]), /invalid_command/u);
  assert.throws(() => parseCliArguments(["run", "--config", "/tmp/config.json"]), /unknown_option/u);
});

test("rejects missing, duplicate, unknown, and malformed options", () => {
  assert.throws(() => parseCliArguments(valid.slice(0, -2)), /missing_option/u);
  assert.throws(() => parseCliArguments([...valid, "--execute-model", "other"]), /duplicate_option/u);
  assert.throws(() => parseCliArguments([...valid, "--extra", "value"]), /unknown_option/u);
  assert.throws(() => parseCliArguments(valid.map((value) => value === "4" ? "0" : value)), /invalid_max_cycles/u);
});
