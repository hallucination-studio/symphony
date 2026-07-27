import assert from "node:assert/strict";
import test from "node:test";

import { parseManagedRecordBlock } from "@symphony/contracts/managed-record";

const record = Object.freeze({
  kind: "workflow_issue",
  version: 1,
  issue_key: "cycle-1",
});

test("strict JSON managed-record envelope preserves Markdown and its JSON object", () => {
  assert.deepEqual(
    parseManagedRecordBlock(`## Cycle\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``),
    {
      ok: true,
      markdown: "## Cycle",
      record,
    },
  );
});

test("strict JSON managed-record envelope rejects missing, duplicate, nonterminal, and invalid blocks", () => {
  assert.deepEqual(parseManagedRecordBlock("ordinary comment"), {
    ok: false,
    error: "managed_record_block_missing",
  });
  assert.deepEqual(
    parseManagedRecordBlock(`\`\`\`json\n${JSON.stringify(record)}\n\`\`\`\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``),
    { ok: false, error: "managed_record_block_ambiguous" },
  );
  assert.deepEqual(
    parseManagedRecordBlock(`\`\`\`json\n${JSON.stringify(record)}\n\`\`\`\nvisible tail`),
    { ok: false, error: "managed_record_block_not_terminal" },
  );
  assert.deepEqual(parseManagedRecordBlock("```json\n[]\n```"), {
    ok: false,
    error: "managed_record_block_invalid",
  });
  assert.deepEqual(parseManagedRecordBlock("```json\n{\"kind\":\"workflow_issue\",\"version\":2}\n```"), {
    ok: false,
    error: "managed_record_version_invalid",
  });
});
