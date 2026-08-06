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
  "--artist-agent", "codex",
  "--artist-model", "execute-model",
  "--artist-reasoning-effort", "high",
  "--critic-agent", "codex",
  "--critic-model", "audit-model",
  "--critic-reasoning-effort", "xhigh",
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
    artist_agent: "codex",
    artist_model: "execute-model",
    artist_reasoning_effort: "high",
    critic_agent: "codex",
    critic_model: "audit-model",
    critic_reasoning_effort: "xhigh",
    max_cycles: 4,
  });
});

test("defaults each role agent to Codex and leaves overrides optional", () => {
  assert.deepEqual(parseCliArguments([
    "run", "--linear-root", "ENG-123", "--workspace", "/tmp/root-workspace",
    "--dir", "/tmp/root-run", "--max-cycles", "4",
  ]), {
    linear_root: "ENG-123", workspace_path: "/tmp/root-workspace", run_directory: "/tmp/root-run",
    reconcile_agent: "codex", artist_agent: "codex", critic_agent: "codex", max_cycles: 4,
  });
});

test("omits a preferred workspace so Prepare owns worktree selection", () => {
  assert.deepEqual(parseCliArguments([
    "run", "--linear-root", "ENG-123", "--dir", "/tmp/root-run", "--max-cycles", "4",
  ]), {
    linear_root: "ENG-123", run_directory: "/tmp/root-run",
    reconcile_agent: "codex", artist_agent: "codex", critic_agent: "codex", max_cycles: 4,
  });
});

test("keeps each role override independently optional", () => {
  assert.deepEqual(parseCliArguments([
    "run", "--linear-root", "ENG-123", "--workspace", "/tmp/root-workspace",
    "--dir", "/tmp/root-run", "--reconcile-model", "reconcile-only",
    "--artist-agent", "codex", "--artist-model", "execute-only",
    "--critic-reasoning-effort", "xhigh", "--max-cycles", "4",
  ]), {
    linear_root: "ENG-123", workspace_path: "/tmp/root-workspace", run_directory: "/tmp/root-run",
    reconcile_agent: "codex", reconcile_model: "reconcile-only", artist_agent: "codex",
    artist_model: "execute-only", critic_agent: "codex", critic_reasoning_effort: "xhigh", max_cycles: 4,
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
