import assert from "node:assert/strict";
import test from "node:test";

import { parseCycleSpec } from "../../contracts/cycle.js";
import type { PerformerProcessResult } from "../../contracts/performer.js";
import { parseRootState } from "../../contracts/root.js";
import { renderAuditPrompt } from "./AuditPrompt.js";

test("Audit prompt owns independent read-only judgment and receives process facts without Execute prose", () => {
  const facts: PerformerProcessResult = {
    launch_status: "exited", exit_code: 1, duration_ms: 7, sanitized_reason: "Command failed",
  };
  const prompt = renderAuditPrompt(
    parseCycleSpec({
      cycle_number: 1, objective: "Reject ambiguity", acceptance: "Focused test passes",
      boundaries: "Parser only", consumed_comment_ids: [],
    }),
    parseRootState({
      workspace_path: "/workspace", run_directory: "/run", root_branch: "root/ENG-1",
      current_phase: "cycle", task_state_markdown: "Lexer trusted", pending_finding: "Ambiguity remains",
    }),
    facts,
  );

  assert.match(prompt, /You are Symphony's Audit role/u);
  assert.match(prompt, /read-only/u);
  assert.match(prompt, /sole semantic authority/u);
  assert.match(prompt, /<<< BEGIN CYCLE_CONTRACT >>>/u);
  assert.match(prompt, /<<< BEGIN PRIOR_TRUSTED_STATE >>>/u);
  assert.match(prompt, /<<< BEGIN EXECUTE_PROCESS_FACTS >>>/u);
  assert.match(prompt, /"exit_code":1/u);
  assert.match(prompt, /verdict: accepted[\s\S]*## Scope Audited[\s\S]*## Task State/u);
  assert.match(prompt, /Executor prose is unavailable/u);
  assert.equal(prompt.includes("## Summary\n[what you changed"), false);
});
