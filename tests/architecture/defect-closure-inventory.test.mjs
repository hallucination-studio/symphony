import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInitialClosureRows,
  inventoryDefectSources,
  validateClosureMatrix,
  validateDefectSourceLinks,
} from "../../tools/architecture/defect-closure-inventory.mjs";

const root = process.cwd();

test("defect inventory covers audit findings, old R4-R6 outcomes, and current failures", async () => {
  const sources = await inventoryDefectSources(root);

  assert.equal(sources.length, 138);
  assert.deepEqual(
    Array.from({ length: 26 }, (_, index) => {
      const task = index + 1;
      return sources.filter(({ id }) => id.startsWith(`AUDIT-T${task}-`)).length;
    }),
    [4, 4, 5, 5, 4, 5, 2, 3, 2, 3, 4, 4, 4, 4, 4, 5, 6, 6, 7, 7, 7, 8, 8, 6, 8, 5],
  );
  assert.ok(sources.some(({ id }) => id === "AUDIT-T12-F2"));
  assert.ok(sources.some(({ id }) => id === "AUDIT-T23-F1"));
  assert.ok(sources.some(({ id }) => id === "OLD-R4-6"));
  assert.ok(sources.some(({ id }) => id === "CHECK-STAGE-OUTCOME"));
  assert.equal(new Set(sources.map(({ id }) => id)).size, sources.length);
  assert.ok(sources.every(({ source }) => /^tasks\/(?:architecture-audit\/|todo\.md#)/u.test(source)));
  assert.deepEqual(await validateDefectSourceLinks(root, sources), []);

  const rows = buildInitialClosureRows(sources);
  assert.equal(rows.length, sources.length);
  assert.deepEqual(validateClosureMatrix(sources, rows), []);
  assert.equal(rows.filter(({ status }) => status === "open").length, 137);
  assert.equal(rows.find(({ sourceId }) => sourceId === "CHECK-STAGE-OUTCOME")?.status, "fixed_verified");
  assert.ok(rows.some(({ owner }) => owner === "N4.1"));
  assert.ok(rows.some(({ owner }) => owner === "N6.1"));
  assert.equal(rows.find(({ sourceId }) => sourceId === "AUDIT-T12-F1")?.owner, "N2.2");
  assert.equal(rows.find(({ sourceId }) => sourceId === "AUDIT-T12-F2")?.owner, "N1.2");
  assert.equal(rows.find(({ sourceId }) => sourceId === "AUDIT-T12-F3")?.owner, "N4.3");
  assert.ok(rows.some(({ realBoundary }) => realBoundary === "required"));
});

test("closure validation rejects duplicates, unmapped sources, and unknown source links", () => {
  const sources = [
    { id: "AUDIT-T1-F1", source: "tasks/architecture-audit/modules/01-product-topology.md#t1-f1" },
    { id: "OLD-R4-6", source: "tasks/architecture-audit/implementation/index.md#old-r4-6" },
  ];
  const validRow = {
    closureId: "C-AUDIT-T1-F1",
    sourceId: "AUDIT-T1-F1",
    source: sources[0].source,
    owner: "N5.4",
    regression: "required",
    realBoundary: "not_required",
    status: "open",
  };

  assert.deepEqual(validateClosureMatrix(sources, [validRow]), [
    { code: "unmapped_source", sourceId: "OLD-R4-6" },
  ]);
  assert.ok(validateClosureMatrix(sources, [validRow, validRow]).some(({ code }) => code === "duplicate_closure_id"));
  assert.ok(validateClosureMatrix(sources, [{ ...validRow, sourceId: "UNKNOWN" }]).some(({ code }) => code === "unknown_source"));
  assert.ok(validateClosureMatrix(sources, [{ ...validRow, source: "wrong.md#anchor" }]).some(({ code }) => code === "source_link_mismatch"));
  assert.ok(validateClosureMatrix(sources, [{ ...validRow, status: "fixed_verified" }]).some(({ code }) => code === "terminal_row_without_verification"));
});
