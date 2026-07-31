import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const forbiddenSemanticDecisionVocabulary = [
  /\bStartCycle\b/u,
  /\bContinueCycle\b/u,
  /\bCloseCycleAndReplan\b/u,
  /\bDeliverVerifiedRevision\b/u,
  /\bRootDecision\b/u,
  /\bshould_continue\b/u,
  /\bshould_replan\b/u,
  /\b(?:shouldContinue|shouldReplan|shouldChangeDesign)\b/u,
  /\b(?:choose|revise|redesign)(?:Cycle|Architecture|Requirement)\b/u,
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

function inspectMechanicalSources(sources) {
  const findings = [];
  for (const [file, source] of sources) {
    for (const pattern of forbiddenSemanticDecisionVocabulary) {
      if (pattern.test(source)) findings.push({ file, pattern: pattern.source });
    }
  }
  return findings;
}

function mechanicalConductorFiles(files, rootReconcillDirectory) {
  return files.filter((file) => !file.startsWith(rootReconcillDirectory));
}

test("workflow vocabulary guard detects legacy commands and semantic Cycle decisions", () => {
  const sources = new Map([
    ["lifecycle-command.ts", "const command = StartCycle;"],
    ["derived-camel.ts", "const shouldContinue = decide();"],
    ["architecture.ts", "const choice = reviseArchitecture();"],
  ]);

  assert.deepEqual(inspectMechanicalSources(sources).map(({ file }) => file), [...sources.keys()]);
});

test("workflow vocabulary guard permits mechanical Cycle state machines and excludes RootReconcill", () => {
  const sourceDirectory = path.resolve("apps/conductor/src");
  const rootReconcillDirectory = path.join(sourceDirectory, "root-reconcill") + path.sep;
  const runtimeFile = path.join(sourceDirectory, "runtime", "Scheduler.ts");
  const rootReconcillFile = path.join(rootReconcillDirectory, "RootReconcill.ts");
  const allSources = new Map([
    [runtimeFile, "const cycleStateMachine = cycleTransitions[currentState]; const workReady = true;"],
    [rootReconcillFile, "const command = StartCycle;"],
  ]);
  const protectedFiles = mechanicalConductorFiles([...allSources.keys()], rootReconcillDirectory);
  const protectedSources = new Map(protectedFiles.map((file) => [file, allSources.get(file)]));

  assert.deepEqual(protectedFiles, [runtimeFile]);
  assert.deepEqual(inspectMechanicalSources(protectedSources), []);
});

test("non-Root-Reconcill production code contains no semantic workflow-decision vocabulary", async () => {
  const sourceDirectory = path.resolve("apps/conductor/src");
  const rootReconcillDirectory = path.join(sourceDirectory, "root-reconcill") + path.sep;
  const allFiles = await productionTypescriptFiles(sourceDirectory);
  assert.equal(allFiles.some((file) => file.startsWith(rootReconcillDirectory)), true);
  const files = mechanicalConductorFiles(allFiles, rootReconcillDirectory);
  assert.notEqual(files.length, 0);
  const sources = new Map(await Promise.all(files.map(async (file) => [
    path.relative(process.cwd(), file),
    await readFile(file, "utf8"),
  ])));

  assert.deepEqual(inspectMechanicalSources(sources), []);
});
