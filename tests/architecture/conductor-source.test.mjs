import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const sourceDirectory = path.resolve("apps/conductor/src");

const retiredPaths = [
  "codex-app-server",
  "cycle/internal",
  "delivery",
  "observation",
  "root-reconcill",
  "runtime",
  "task-management",
];

const retiredVocabulary = [
  /\bAcceptedRevision\b/u,
  /\bCycleMachine\b/u,
  /\bDeliveryInterface\b/u,
  /\bDynamicToolBridge\b/u,
  /\bPlanPerformer\b/u,
  /\bRootRuntimeRegistry\b/u,
  /\bStagePerformer\b/u,
  /\bTaskManageCapability\b/u,
  /\bTaskRevision\b/u,
  /\bVerifyPerformer\b/u,
  /\bWorkPerformer\b/u,
  /\b(?:specDigest|spec_digest)\b/u,
  /\bcodex-app-server\b/u,
];

async function productionTypescriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypescriptFiles(entryPath);
    const isTypeScript = /\.(?:[cm]?ts|tsx)$/u.test(entry.name);
    const isTest = /\.(?:test|spec)\.(?:[cm]?ts|tsx)$/u.test(entry.name);
    return isTypeScript && !isTest ? [entryPath] : [];
  }));
  return files.flat();
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function retiredSymbolFindings(sources) {
  const findings = [];
  for (const [file, source] of sources) {
    for (const pattern of retiredVocabulary) {
      if (pattern.test(source)) findings.push(`${file}: ${pattern.source}`);
    }
  }
  return findings;
}

test("permanently retired architecture paths are absent", async () => {
  const existing = [];
  for (const relativePath of retiredPaths) {
    if (await pathExists(path.join(sourceDirectory, relativePath))) existing.push(relativePath);
  }
  assert.deepEqual(existing, []);
});

test("production code contains no retired architecture vocabulary", async () => {
  const files = await productionTypescriptFiles(sourceDirectory);
  assert.notEqual(files.length, 0);
  const sources = new Map(await Promise.all(files.map(async (file) => [
    path.relative(process.cwd(), file),
    await readFile(file, "utf8"),
  ])));

  assert.deepEqual(retiredSymbolFindings(sources), []);
});

test("subtraction guard detects representative forbidden systems", () => {
  const sources = new Map([
    ["revision.ts", "const revision: TaskRevision = input;"],
    ["performer.ts", "import { DynamicToolBridge } from './bridge.js';"],
    ["delivery.ts", "class AcceptedRevision implements DeliveryInterface {}"],
  ]);

  assert.equal(retiredSymbolFindings(sources).length, 4);
});
