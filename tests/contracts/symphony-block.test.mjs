import assert from "node:assert/strict";
import test from "node:test";

import { parseSymphonyRecordBlock } from "@symphony/contracts/managed-record";

const record = Object.freeze({
  kind: "workflow_issue",
  version: 1,
  issue_key: "cycle-1",
});

test("strict symphony record envelope preserves Markdown and its JSON object", () => {
  assert.deepEqual(
    parseSymphonyRecordBlock(`## Cycle\n\n\`\`\`symphony\n${JSON.stringify(record)}\n\`\`\``),
    {
      ok: true,
      markdown: "## Cycle",
      record,
    },
  );
});

test("strict symphony record envelope rejects missing, duplicate, nonterminal, and invalid blocks", () => {
  assert.deepEqual(parseSymphonyRecordBlock("ordinary comment"), {
    ok: false,
    error: "managed_record_block_missing",
  });
  assert.deepEqual(
    parseSymphonyRecordBlock(`\`\`\`symphony\n${JSON.stringify(record)}\n\`\`\`\n\`\`\`symphony\n${JSON.stringify(record)}\n\`\`\``),
    { ok: false, error: "managed_record_block_ambiguous" },
  );
  assert.deepEqual(
    parseSymphonyRecordBlock(`\`\`\`symphony\n${JSON.stringify(record)}\n\`\`\`\nvisible tail`),
    { ok: false, error: "managed_record_block_not_terminal" },
  );
  assert.deepEqual(parseSymphonyRecordBlock("```symphony\n[]\n```"), {
    ok: false,
    error: "managed_record_block_invalid",
  });
  assert.deepEqual(parseSymphonyRecordBlock("```symphony\n{\"kind\":\"workflow_issue\",\"version\":2}\n```"), {
    ok: false,
    error: "managed_record_version_invalid",
  });
});
