import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  auditRetiredInventory,
  inspectRetiredInventory,
} from "../../tools/architecture/audit-retired.mjs";

const htmlMarker = "<!" + "-- symphony";
const snakeMarker = "managed_" + "marker";
const camelMarker = "managed" + "Marker";
const timelineProjection = "Timeline" + "Projection";
const timelineProjections = "timeline-" + "projections";
const stageUsage = "Stage" + "Usage";
const stageUsageSnapshot = stageUsage + "Snapshot";
const managedHtmlRecordsScope = "managed-html-" + "records";
const timelineProjectionsScope = "timeline-" + "projections";
const legacyTurnUsageScope = "legacy-turn-" + "usage";
const syntheticE2ECompletionScope = "synthetic-e2e-" + "completion";
const syntheticFinal = "synthetic " + "final";
const syntheticFinalRecord = "target_e2e_" + "synthetic_final";

test("hard-cut inventory names every retired comment, timeline, usage, and E2E surface", async () => {
  const inventory = JSON.parse(await readFile("tools/architecture/retired-inventory.json", "utf8"));

  assert.deepEqual(Object.keys(inventory.scopes).slice(-4), [
    managedHtmlRecordsScope,
    timelineProjectionsScope,
    legacyTurnUsageScope,
    syntheticE2ECompletionScope,
  ]);
  for (const scope of Object.values(inventory.scopes).slice(-4)) {
    assert.match(scope.source, /^docs\/architecture\/[^#]+\.md#/u);
  }
  assert.deepEqual(Object.keys(inventory.scopes[managedHtmlRecordsScope].symbols), [
    htmlMarker,
    snakeMarker,
    camelMarker,
  ]);
  assert.deepEqual(Object.keys(inventory.scopes[timelineProjectionsScope].symbols), [
    timelineProjection,
    timelineProjections,
  ]);
  assert.deepEqual(Object.keys(inventory.scopes[legacyTurnUsageScope].symbols), [
    stageUsage,
    stageUsageSnapshot,
  ]);
  assert.deepEqual(Object.keys(inventory.scopes[syntheticE2ECompletionScope].symbols), [
    syntheticFinal,
    syntheticFinalRecord,
  ]);
});

test("final findings identify the architecture rule that owns each reachable legacy surface", async () => {
  const findings = await auditRetiredInventory(process.cwd(), { mode: "final" });

  assert.ok(findings.some((finding) =>
    finding.scope === managedHtmlRecordsScope &&
    finding.symbol === snakeMarker &&
    finding.source === "docs/architecture/contracts.md#契约与接口边界"));
  assert.ok(findings.some((finding) =>
    finding.scope === timelineProjectionsScope &&
    finding.code === "retired_path_remaining" &&
    finding.source === "docs/architecture/workflow-timeline.md#解耦机制"));
});

test("tracked code cannot expand beyond the retired baseline", async () => {
  assert.deepEqual(await auditRetiredInventory(process.cwd(), { mode: "no-expansion" }), []);
});

test("retired inventory rejects new legacy paths and symbol occurrences", () => {
  const inventory = {
    version: 1,
    scopes: {
      sample: {
        source: "docs/architecture/contracts.md#managed-records",
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
    {
      code: "retired_path_untracked_by_baseline",
      file: "legacy/new.ts",
      scope: "sample",
      source: "docs/architecture/contracts.md#managed-records",
    },
    {
      code: "retired_symbol_untracked_by_baseline",
      file: "src/new.ts",
      scope: "sample",
      source: "docs/architecture/contracts.md#managed-records",
      symbol: "OldRuntime",
    },
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
