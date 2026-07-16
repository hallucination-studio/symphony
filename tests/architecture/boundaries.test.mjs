import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

test("only Podium owns the Linear SDK", async () => {
  const files = await walk(path.join(root, "apps"));
  const offenders = [];
  for (const file of files.filter((candidate) => /\.[cm]?[jt]sx?$/.test(candidate))) {
    const source = await readFile(file, "utf8");
    if (source.includes("@linear/sdk")) {
      offenders.push(path.relative(root, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("Conductor has no database or operation journal modules", async () => {
  const files = (await walk(path.join(root, "apps", "conductor"))).map((file) =>
    path.relative(root, file)
  );
  assert.equal(
    files.some((file) => /(database|workflow-db|checkpoint|operation-journal)/i.test(file)),
    false
  );
});
