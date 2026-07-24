import assert from "node:assert/strict";
import test from "node:test";

import {
  auditRetiredInventory,
  inspectRetiredInventory,
} from "../../tools/architecture/audit-retired.mjs";

test("tracked code cannot expand beyond the retired baseline", async () => {
  assert.deepEqual(await auditRetiredInventory(process.cwd(), { mode: "no-expansion" }), []);
});

test("retired inventory rejects new legacy paths and symbol occurrences", () => {
  const inventory = {
    version: 1,
    scopes: {
      sample: {
        path_patterns: ["^legacy/"],
        paths: ["legacy/known.ts"],
        symbols: { OldRuntime: ["src/known.ts"] },
      },
    },
  };
  const tracked = new Map([
    ["legacy/known.ts", ""],
    ["legacy/new.ts", ""],
    ["src/known.ts", "OldRuntime"],
    ["src/new.ts", "OldRuntime"],
  ]);

  assert.deepEqual(inspectRetiredInventory(inventory, tracked, { mode: "no-expansion" }), [
    { code: "retired_path_untracked_by_baseline", file: "legacy/new.ts", scope: "sample" },
    { code: "retired_symbol_untracked_by_baseline", file: "src/new.ts", scope: "sample", symbol: "OldRuntime" },
  ]);
});

test("scope and final modes require retired entries to be absent", () => {
  const inventory = {
    version: 1,
    scopes: {
      sample: {
        path_patterns: ["^legacy/"],
        paths: ["legacy/known.ts"],
        symbols: { OldRuntime: ["src/known.ts"] },
      },
    },
  };
  const tracked = new Map([
    ["legacy/known.ts", ""],
    ["src/known.ts", "OldRuntime"],
  ]);

  const expected = [
    { code: "retired_path_remaining", file: "legacy/known.ts", scope: "sample" },
    { code: "retired_symbol_remaining", file: "src/known.ts", scope: "sample", symbol: "OldRuntime" },
  ];
  assert.deepEqual(inspectRetiredInventory(inventory, tracked, { scope: "sample" }), expected);
  assert.deepEqual(inspectRetiredInventory(inventory, tracked, { mode: "final" }), expected);
});

test("audit intent must be explicit", () => {
  const inventory = { version: 1, scopes: {} };
  const tracked = new Map();

  assert.throws(
    () => inspectRetiredInventory(inventory, tracked, {}),
    /retired_inventory_mode_required/u,
  );
  assert.throws(
    () => inspectRetiredInventory(inventory, tracked, { mode: "migration" }),
    /retired_inventory_mode_unknown/u,
  );
});
