import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  parseCorrelationId,
  parseRootIssueId,
  parseRuntimeGeneration,
} from "../../contracts/identity.js";
import { RootToolCallError, type RootToolExecution } from "../../runtime/RootToolBoundary.js";
import {
  bindRootCodeInspection,
  RootCodeInspection,
} from "./RootCodeInspection.js";

const target = Object.freeze({
  root_id: parseRootIssueId("ROOT-CODE-1"),
  runtime_generation: parseRuntimeGeneration(4),
});
const correlationId = parseCorrelationId("turn:code-inspection");
const execution: RootToolExecution = Object.freeze({ assertActive: () => undefined });

function envelope(capability: string): Record<string, unknown> {
  return {
    schema_version: 1,
    root_id: target.root_id,
    runtime_generation: target.runtime_generation,
    correlation_id: correlationId,
    capability,
  };
}

async function fixture(context: TestContext) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-root-code-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, "workspace");
  const outside = path.join(temporary, "outside.txt");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(outside, "outside boundary\n", "utf8");
  return { workspace: await realpath(workspace), outside };
}

function binding(
  inspection: RootCodeInspection,
  name: "list_code_directory" | "read_code_file" | "search_code",
) {
  const selected = bindRootCodeInspection(inspection, correlationId)
    .find(({ spec }) => spec.name === name);
  assert.ok(selected);
  return selected;
}

test("Root code inspection lists, reads, and searches fresh non-sensitive code with bounded results", async (context) => {
  const { workspace } = await fixture(context);
  await Promise.all([
    writeFile(path.join(workspace, "src", "answer.ts"), "export const answer = 42;\n", "utf8"),
    writeFile(path.join(workspace, "README.md"), "# Example\n\nThe answer is in source.\n", "utf8"),
    writeFile(path.join(workspace, ".env.production"), "TOKEN=repository-secret\n", "utf8"),
  ]);
  const inspection = await RootCodeInspection.create({ target, workspaceRoot: workspace });
  assert.deepEqual(inspection.specs.map(({ name }) => name), [
    "list_code_directory",
    "read_code_file",
    "search_code",
  ]);

  const listed = await binding(inspection, "list_code_directory").execute({
    ...envelope("code_inspection:list_directory"),
    path: ".",
    cursor: null,
    page_size: 128,
  }, execution) as { entries: readonly { path: string }[]; next_cursor: string | null };
  assert.deepEqual(listed.entries.map(({ path: entryPath }) => entryPath), ["README.md", "src"]);
  assert.equal(listed.next_cursor, null);

  const firstRead = await binding(inspection, "read_code_file").execute({
    ...envelope("code_inspection:read_file"),
    path: "src/answer.ts",
    start_line: 1,
    max_lines: 200,
  }, execution) as { content: string; truncated: boolean };
  assert.equal(firstRead.content, "export const answer = 42;\n");
  assert.equal(firstRead.truncated, false);

  await writeFile(path.join(workspace, "src", "answer.ts"), "export const answer = 6 * 7;\n", "utf8");
  const freshRead = await binding(inspection, "read_code_file").execute({
    ...envelope("code_inspection:read_file"),
    path: "src/answer.ts",
    start_line: 1,
    max_lines: 200,
  }, execution) as { content: string };
  assert.equal(freshRead.content, "export const answer = 6 * 7;\n");

  const searched = await binding(inspection, "search_code").execute({
    ...envelope("code_inspection:search"),
    path: ".",
    query: "answer",
    max_results: 100,
  }, execution) as { matches: readonly { path: string; line: number; text: string }[]; truncated: boolean };
  assert.deepEqual(searched.matches, [
    { path: "README.md", line: 3, text: "The answer is in source." },
    { path: "src/answer.ts", line: 1, text: "export const answer = 6 * 7;" },
  ]);
  assert.equal(searched.truncated, false);
});

test("Root code inspection reports a missing non-sensitive target as a typed read-only fact", async (context) => {
  const { workspace } = await fixture(context);
  const inspection = await RootCodeInspection.create({ target, workspaceRoot: workspace });
  const calls = [
    {
      name: "list_code_directory" as const,
      arguments: { path: "not-created", cursor: null, page_size: 128 },
      operation: "list_code_directory",
    },
    {
      name: "read_code_file" as const,
      arguments: { path: "not-created/file.ts", start_line: 1, max_lines: 200 },
      operation: "read_code_file",
    },
    {
      name: "search_code" as const,
      arguments: { path: "not-created", query: "needle", max_results: 100 },
      operation: "search_code",
    },
  ];

  for (const entry of calls) {
    const result = await binding(inspection, entry.name).execute({
      ...envelope(`code_inspection:${entry.name === "list_code_directory"
        ? "list_directory"
        : entry.name === "read_code_file" ? "read_file" : "search"}`),
      ...entry.arguments,
    }, execution);
    assert.deepEqual(result, {
      schema_version: 1,
      root_id: target.root_id,
      runtime_generation: target.runtime_generation,
      correlation_id: correlationId,
      operation: entry.operation,
      path: entry.arguments.path,
      outcome: "not_found",
    });
  }
});

test("Root code inspection caps an oversized positive read request at its output boundary", async (context) => {
  const { workspace } = await fixture(context);
  await writeFile(
    path.join(workspace, "many-lines.txt"),
    `${Array.from({ length: 250 }, (_, index) => `line-${index + 1}`).join("\n")}\n`,
    "utf8",
  );
  const inspection = await RootCodeInspection.create({ target, workspaceRoot: workspace });

  const result = await binding(inspection, "read_code_file").execute({
    ...envelope("code_inspection:read_file"),
    path: "many-lines.txt",
    start_line: 1,
    max_lines: 500,
  }, execution) as { content: string; start_line: number; end_line: number; truncated: boolean };

  assert.equal(result.content.split("\n").filter(Boolean).length, 200);
  assert.equal(result.start_line, 1);
  assert.equal(result.end_line, 200);
  assert.equal(result.truncated, true);
});

test("Root code directory pagination uses one deterministic cursor ordering", async (context) => {
  const { workspace } = await fixture(context);
  const directory = path.join(workspace, "paged");
  await mkdir(directory);
  const names = [
    ...Array.from({ length: 127 }, (_, index) => String(index).padStart(3, "0")),
    "_x",
    "z",
  ];
  await Promise.all(names.map((name) => writeFile(path.join(directory, name), "", "utf8")));
  const inspection = await RootCodeInspection.create({ target, workspaceRoot: workspace });
  const list = binding(inspection, "list_code_directory");

  const first = await list.execute({
    ...envelope("code_inspection:list_directory"),
    path: "paged",
    cursor: null,
    page_size: 128,
  }, execution) as { entries: readonly { name: string }[]; next_cursor: string | null };
  assert.notEqual(first.next_cursor, null);
  const second = await list.execute({
    ...envelope("code_inspection:list_directory"),
    path: "paged",
    cursor: first.next_cursor,
    page_size: 128,
  }, execution) as { entries: readonly { name: string }[]; next_cursor: string | null };

  assert.deepEqual(
    [...first.entries, ...second.entries].map(({ name }) => name),
    [...names].sort(),
  );
  assert.equal(second.next_cursor, null);
});

test("Root code inspection denies secret paths, symlinks, binary data, and arbitrary-name private keys", async (context) => {
  const { workspace, outside } = await fixture(context);
  await mkdir(path.join(workspace, ".docker"));
  await Promise.all([
    writeFile(path.join(workspace, ".env.local"), "TOKEN=repository-secret\n", "utf8"),
    writeFile(path.join(workspace, ".key"), "unmarked-private-key-material\n", "utf8"),
    writeFile(path.join(workspace, ".gitmodules"), "url = https://credential.invalid/repository\n", "utf8"),
    writeFile(path.join(workspace, ".docker", "config.json"), "auth configuration\n", "utf8"),
    writeFile(
      path.join(workspace, "notes.txt"),
      "-----BEGIN PRIVATE KEY-----\nYXJiaXRyYXJ5LXNlY3JldA==\n-----END PRIVATE KEY-----\n",
      "utf8",
    ),
    writeFile(
      path.join(workspace, "release-notes.txt"),
      "-----BEGIN PGP PRIVATE KEY BLOCK-----\nYXJiaXRyYXJ5LXNlY3JldA==\n-----END PGP PRIVATE KEY BLOCK-----\n",
      "utf8",
    ),
    writeFile(path.join(workspace, "identity.txt"), "AGE-SECRET-KEY-1TESTONLYNOTAKEY\n", "utf8"),
    writeFile(path.join(workspace, "opaque.data"), Buffer.from([0, 1, 2, 3])),
    symlink(outside, path.join(workspace, "outside-link")),
  ]);
  const inspection = await RootCodeInspection.create({ target, workspaceRoot: workspace });
  const read = binding(inspection, "read_code_file");

  for (const deniedPath of [
    ".env.local",
    ".key",
    ".gitmodules",
    ".docker/config.json",
    "notes.txt",
    "release-notes.txt",
    "identity.txt",
    "opaque.data",
    "outside-link",
    "../outside.txt",
  ]) {
    await assert.rejects(read.execute({
      ...envelope("code_inspection:read_file"),
      path: deniedPath,
      start_line: 1,
      max_lines: 200,
    }, execution), (error: unknown) => (
      error instanceof RootToolCallError && error.code === "capability_denied"
    ), deniedPath);
  }
});

test("Root code search bounds match text and directory traversal", async (context) => {
  const { workspace } = await fixture(context);
  await Promise.all(Array.from({ length: 513 }, (_, index) =>
    mkdir(path.join(workspace, `directory-${String(index).padStart(3, "0")}`))));
  await writeFile(
    path.join(workspace, "long-line.txt"),
    `${"x".repeat(20_000)}bounded-query\n`,
    "utf8",
  );
  const inspection = await RootCodeInspection.create({ target, workspaceRoot: workspace });

  const search = await binding(inspection, "search_code").execute({
    ...envelope("code_inspection:search"),
    path: ".",
    query: "bounded-query",
    max_results: 100,
  }, execution) as {
    matches: readonly { text: string }[];
    truncated: boolean;
  };
  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0]?.text.includes("bounded-query"), true);
  assert.equal((search.matches[0]?.text.length ?? Number.POSITIVE_INFINITY) <= 4_100, true);
  assert.equal(search.truncated, true);
});

test("Root code inspection redacts credential-bearing source lines from reads and searches", async (context) => {
  const { workspace } = await fixture(context);
  const secret = "not-for-root-123456789";
  await writeFile(
    path.join(workspace, "src", "config.ts"),
    [
      "export const publicName = 'example';",
      `export const client_secret = "${secret}";`,
      "export const enabled = true;",
      "",
    ].join("\n"),
    "utf8",
  );
  const inspection = await RootCodeInspection.create({ target, workspaceRoot: workspace });

  const read = await binding(inspection, "read_code_file").execute({
    ...envelope("code_inspection:read_file"),
    path: "src/config.ts",
    start_line: 1,
    max_lines: 200,
  }, execution);
  assert.equal(JSON.stringify(read).includes(secret), false);
  assert.equal(JSON.stringify(read).includes("[sensitive line omitted]"), true);

  const search = await binding(inspection, "search_code").execute({
    ...envelope("code_inspection:search"),
    path: ".",
    query: "client_secret",
    max_results: 100,
  }, execution);
  assert.equal(JSON.stringify(search).includes(secret), false);
  assert.equal(JSON.stringify(search).includes("[sensitive line omitted]"), true);
});

test("Root code inspection binds exact runtime identity, correlation, schema, and limits", async (context) => {
  const { workspace } = await fixture(context);
  await writeFile(path.join(workspace, "README.md"), "bounded\n", "utf8");
  const inspection = await RootCodeInspection.create({ target, workspaceRoot: workspace });
  const read = binding(inspection, "read_code_file");

  for (const invalid of [
    { ...envelope("code_inspection:read_file"), root_id: "OTHER", path: "README.md", start_line: 1, max_lines: 200 },
    { ...envelope("code_inspection:read_file"), runtime_generation: 5, path: "README.md", start_line: 1, max_lines: 200 },
    { ...envelope("code_inspection:read_file"), correlation_id: "turn:other", path: "README.md", start_line: 1, max_lines: 200 },
    { ...envelope("code_inspection:read_file"), path: "/etc/passwd", start_line: 1, max_lines: 200 },
    { ...envelope("code_inspection:read_file"), path: "README.md", start_line: 0, max_lines: 200 },
    { ...envelope("code_inspection:read_file"), path: "README.md", start_line: 1, max_lines: 0 },
    { ...envelope("code_inspection:read_file"), path: "README.md", start_line: 1, max_lines: 200, extra: true },
  ]) {
    await assert.rejects(read.execute(invalid, execution), RootToolCallError);
  }
});
