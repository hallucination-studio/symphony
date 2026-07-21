import assert from "node:assert/strict";
import test from "node:test";

import { createE2ELogger } from "../../tools/e2e/logging.mjs";

test("target workflow logs are correlated structured lines with recursive secret redaction", () => {
  const lines = [];
  const log = createE2ELogger({
    runId: "run-1",
    secrets: ["linear-canary", "codex-canary"],
    now: () => "2026-07-18T00:00:00.000Z",
    write: (line) => lines.push(line),
  });

  log({
    event: "e2e_boundary_failed",
    component: "linear",
    messages: ["rejected linear-canary", { detail: "codex-canary" }],
  });

  assert.equal(lines.length, 1);
  assert.equal(lines[0].endsWith("\n"), true);
  assert.deepEqual(JSON.parse(lines[0]), {
    timestamp: "2026-07-18T00:00:00.000Z",
    run_id: "run-1",
    event: "e2e_boundary_failed",
    component: "linear",
    messages: ["rejected [REDACTED]", { detail: "[REDACTED]" }],
  });
});
