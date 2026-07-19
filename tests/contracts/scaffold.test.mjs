import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

const contractDirectories = [
  "packages/contracts/schemas/podium-client",
  "packages/contracts/schemas/desktop-host",
  "packages/contracts/schemas/podium-conductor",
  "packages/contracts/schemas/conductor-performer",
  "packages/contracts/generated/typescript",
  "packages/contracts/generated/python",
  "packages/contracts/generated/rust"
];

test("contract source and generated-language directories exist", async () => {
  await Promise.all(contractDirectories.map((directory) => access(directory)));
  assert.equal(contractDirectories.length, 7);
});
