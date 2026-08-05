import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { serializeDiagnosticError, writeFailureEvidence } from "./DiagnosticEvidence.js";

test("preserves unknown error context and cause without an error-code registry", () => {
  const provider = { status: 422, body: { errors: [{ message: "new provider failure" }] } };
  const error = new Error("linear response could not be interpreted", { cause: provider });
  const serialized = serializeDiagnosticError(error) as Record<string, unknown>;

  assert.equal(serialized.message, "linear response could not be interpreted");
  assert.deepEqual(serialized.cause, provider);
  assert.match(String(serialized.stack), /linear response could not be interpreted/u);
});

test("writes a private correlated failure artifact outside public output", async (context) => {
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), "symphony-diagnostic-"));
  context.after(() => rm(runDirectory, { recursive: true, force: true }));

  const ref = await writeFailureEvidence({
    runDirectory,
    runId: "run-123",
    phase: "runtime",
    error: new Error("unclassified runtime failure", { cause: { raw: "original context" } }),
  });
  const artifact = JSON.parse(await readFile(ref, "utf8")) as Record<string, unknown>;

  assert.equal(ref, path.join(runDirectory, "diagnostics", "run-123", "error.json"));
  assert.equal((artifact.error as Record<string, unknown>).message, "unclassified runtime failure");
  assert.equal((await stat(path.dirname(ref))).mode & 0o777, 0o700);
  assert.equal((await stat(ref)).mode & 0o777, 0o600);
});

test("rejects run-id traversal and symlinked diagnostic directories", async (context) => {
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), "symphony-diagnostic-paths-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "symphony-diagnostic-outside-"));
  context.after(async () => {
    await rm(runDirectory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  await assert.rejects(
    writeFailureEvidence({
      runDirectory,
      runId: "../escape",
      phase: "runtime",
      error: new Error("must not write"),
    }),
    /diagnostic_path_invalid/u,
  );

  const linkedRunDirectory = path.join(runDirectory, "linked-run-directory");
  await symlink(outside, linkedRunDirectory, "dir");
  await assert.rejects(
    writeFailureEvidence({
      runDirectory: linkedRunDirectory,
      runId: "run-123",
      phase: "runtime",
      error: new Error("must not follow run directory"),
    }),
    /diagnostic_path_invalid/u,
  );

  const linkedDiagnostics = path.join(runDirectory, "diagnostics");
  await symlink(outside, linkedDiagnostics, "dir");
  await assert.rejects(
    writeFailureEvidence({
      runDirectory,
      runId: "run-123",
      phase: "runtime",
      error: new Error("must not follow"),
    }),
    /diagnostic_path_invalid/u,
  );
  assert.deepEqual(await readdir(outside), []);
});

test("uses exclusive private error files and does not follow a file symlink", async (context) => {
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), "symphony-diagnostic-file-"));
  context.after(() => rm(runDirectory, { recursive: true, force: true }));

  const first = await writeFailureEvidence({
    runDirectory,
    runId: "run-123",
    phase: "runtime",
    error: new Error("first"),
  });
  const original = await readFile(first, "utf8");
  await assert.rejects(
    writeFailureEvidence({
      runDirectory,
      runId: "run-123",
      phase: "runtime",
      error: new Error("second"),
    }),
    /EEXIST/u,
  );
  assert.equal(await readFile(first, "utf8"), original);

  const linkedRun = path.join(runDirectory, "diagnostics", "linked-run");
  const outside = path.join(runDirectory, "outside-error.json");
  await symlink(path.join(runDirectory, "diagnostics", "run-123"), linkedRun, "dir");
  await writeFile(outside, "keep", { encoding: "utf8", mode: 0o600 });
  await assert.rejects(
    writeFailureEvidence({
      runDirectory,
      runId: "linked-run",
      phase: "runtime",
      error: new Error("must not follow"),
    }),
    /diagnostic_path_invalid/u,
  );
  assert.equal(await readFile(outside, "utf8"), "keep");
});
