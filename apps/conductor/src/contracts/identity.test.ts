import assert from "node:assert/strict";
import test from "node:test";

import { boundaryError } from "./common-outcomes.js";
import {
  parseCorrelationId,
  parseRevision,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseSchemaVersion,
} from "./identity.js";

test("identity parsers brand only bounded external values", () => {
  assert.equal(parseRootIssueId("LIN-123"), "LIN-123");
  assert.equal(parseCorrelationId("corr:123"), "corr:123");
  assert.equal(parseRevision("a".repeat(40)), "a".repeat(40));
  assert.equal(parseRuntimeGeneration(1), 1);
  assert.equal(parseSchemaVersion(1), 1);

  for (const invalid of ["", " space", "x".repeat(129), {}, null]) {
    assert.throws(() => parseRootIssueId(invalid), /invalid_root_issue_id/u);
  }
  assert.throws(() => parseRevision("main"), /invalid_revision/u);
  assert.throws(() => parseRuntimeGeneration(0), /invalid_runtime_generation/u);
  assert.throws(() => parseSchemaVersion(2), /unsupported_schema_version/u);
});

test("boundary errors remain closed and sanitized", () => {
  const error = boundaryError({
    schema_version: 1,
    code: "boundary_unavailable",
    root_id: parseRootIssueId("LIN-123"),
    runtime_generation: parseRuntimeGeneration(1),
    correlation_id: parseCorrelationId("corr:123"),
    reason: "linear request unavailable",
  });
  assert.deepEqual(Object.keys(error).sort(), [
    "code", "correlation_id", "reason", "root_id", "runtime_generation", "schema_version",
  ]);
  assert.throws(() => boundaryError({ ...error, reason: "token\nsecret" }), /invalid_boundary_reason/u);
});
