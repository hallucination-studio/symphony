import assert from "node:assert/strict";
import test from "node:test";

import { createRoadmapV1Verdict } from "./v1-verdict.mjs";

test("API Key automation cannot claim the full Roadmap without ChatGPT evidence", () => {
  const automated = { status: "passed", rows: [] };
  const verdict = createRoadmapV1Verdict(automated);

  assert.equal(verdict.automated_api_key_v1_e2e, automated);
  assert.deepEqual(verdict.roadmap_v1, {
    status: "incomplete",
    reason: "chatgpt_live_login_not_run",
  });
});
