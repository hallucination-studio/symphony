import assert from "node:assert/strict";
import test from "node:test";

import { InvalidExecutionGenerationCompilerImpl } from "../internal/InvalidExecutionGenerationCompilerImpl.js";
import { recoveryView } from "./recovery-test-fixture.js";

test("mechanical invalid-generation convergence archives one deepest descendant", () => {
  const view = recoveryView({ authorized: true, includePlan: true });
  assert.equal(view.worktreeGate.kind, "execution_generation_invalid");
  if (view.worktreeGate.kind !== "execution_generation_invalid") return;
  const result = new InvalidExecutionGenerationCompilerImpl().compile({
    target: { kind: "converge_invalid_execution_generation", cycleIssueId: "cycle-1", expectedWorktreeGate: view.worktreeGate },
    view,
  });
  assert.equal(result.kind, "effect");
  if (result.kind !== "effect") return;
  assert.equal(result.command.kind, "set_workflow_issue_archive_state");
  if (result.command.kind !== "set_workflow_issue_archive_state") return;
  assert.equal(result.command.target.targetIssueId, "plan-1");
});

test("mechanical invalid-generation convergence archives the Cycle last", () => {
  const view = recoveryView({ authorized: true });
  assert.equal(view.worktreeGate.kind, "execution_generation_invalid");
  if (view.worktreeGate.kind !== "execution_generation_invalid") return;
  const result = new InvalidExecutionGenerationCompilerImpl().compile({
    target: { kind: "converge_invalid_execution_generation", cycleIssueId: "cycle-1", expectedWorktreeGate: view.worktreeGate },
    view,
  });
  assert.equal(result.kind, "effect");
  if (result.kind !== "effect" || result.command.kind !== "set_workflow_issue_archive_state") return;
  assert.equal(result.command.target.targetIssueId, "cycle-1");
});
