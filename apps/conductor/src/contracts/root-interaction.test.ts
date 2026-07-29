import assert from "node:assert/strict";
import test from "node:test";

import { parseRootOutput } from "./root-interaction.js";

const envelope = { schema_version: 1, root_id: "LIN-1", runtime_generation: 1, correlation_id: "corr:1" };

test("Root output is one exact tool call or closed decision", () => {
  const tool = parseRootOutput({ ...envelope, kind: "tool", tool: "work", work_issue_id: "LIN-3" });
  assert.equal(tool.kind, "tool");
  if (tool.kind === "tool") assert.equal(tool.tool, "work");
  const decision = parseRootOutput({ ...envelope, kind: "decision", decision: "Wait", reason: "no ready work" });
  assert.equal(decision.kind, "decision");
  if (decision.kind === "decision") assert.equal(decision.decision, "Wait");
  assert.throws(() => parseRootOutput({ ...envelope, kind: "tool", tool: "execute", work_issue_id: "LIN-3" }), /invalid_contract_variant/u);
  assert.throws(() => parseRootOutput({ ...envelope, kind: "decision", decision: "Wait", reason: "wait", next_action: "work" }), /invalid_contract_keys/u);
});
