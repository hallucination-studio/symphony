import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the roadmap defines all 24 V1 acceptance facts", async () => {
  const roadmap = await readFile("docs/architecture/roadmap.md", "utf8");
  const acceptanceSection = roadmap.split("## 8. V1验收边界")[1]?.split("## 9.")[0] ?? "";
  const acceptanceFacts = acceptanceSection.match(/^\d+\.\s/gm) ?? [];
  assert.equal(acceptanceFacts.length, 24);
});
