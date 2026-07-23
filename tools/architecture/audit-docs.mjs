import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const inlineLink = /\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/gu;
const referenceDefinition = /^\s*\[([^\]]+)\]:\s*(<[^>]+>|\S+)/gmu;
const referenceUse = /\[([^\]]+)\]\[([^\]]*)\]/gu;

function normalizeReference(value) {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function unwrapTarget(value) {
  return value.startsWith("<") && value.endsWith(">")
    ? value.slice(1, -1)
    : value;
}

function externalTarget(target) {
  return /^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("//");
}

function headingAnchors(source) {
  const anchors = new Set();
  const occurrences = new Map();
  for (const match of source.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)) {
    const base = match[1]
      .trim()
      .toLowerCase()
      .replace(/[`*_~]/gu, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/gu, "-")
      .replace(/-+/gu, "-");
    const count = occurrences.get(base) ?? 0;
    occurrences.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

function linksIn(source) {
  const definitions = new Map();
  for (const match of source.matchAll(referenceDefinition)) {
    definitions.set(normalizeReference(match[1]), unwrapTarget(match[2]));
  }

  const links = [...source.matchAll(inlineLink)].map((match) => ({
    target: unwrapTarget(match[1]),
  }));
  for (const match of source.matchAll(referenceUse)) {
    const reference = normalizeReference(match[2] || match[1]);
    links.push(definitions.has(reference)
      ? { target: definitions.get(reference) }
      : { missingReference: reference });
  }
  return links;
}

export function inspectArchitectureSources(sources, auditedFiles = new Set(sources.keys())) {
  const violations = [];

  for (const file of auditedFiles) {
    const source = sources.get(file) ?? "";
    for (const link of linksIn(source)) {
      if (link.missingReference) {
        violations.push({
          code: "undefined_architecture_reference",
          file,
          target: link.missingReference,
        });
        continue;
      }
      if (!link.target || externalTarget(link.target)) continue;

      const [targetPath, anchor] = link.target.split("#", 2);
      const resolved = targetPath
        ? path.posix.normalize(path.posix.join(path.posix.dirname(file), targetPath))
        : file;
      if (!sources.has(resolved)) {
        violations.push({ code: "broken_architecture_link", file, target: link.target });
        continue;
      }
      if (anchor && !headingAnchors(sources.get(resolved)).has(decodeURIComponent(anchor))) {
        violations.push({ code: "broken_architecture_anchor", file, target: link.target });
      }
    }
  }

  return violations.sort((left, right) =>
    left.file.localeCompare(right.file) || left.code.localeCompare(right.code));
}

export function inspectArchitectureAuthority(sources, trackedFiles) {
  const violations = [];
  for (const file of trackedFiles) {
    if (file === "tasks" || file.startsWith("tasks/")) {
      violations.push({ code: "tracked_execution_task", file });
    }
  }
  for (const [file, source] of sources) {
    if (/(?:^|[\s`'"(])tasks\//mu.test(source)) {
      violations.push({ code: "architecture_references_execution_task", file });
    }
  }
  return violations.sort((left, right) =>
    left.file.localeCompare(right.file) || left.code.localeCompare(right.code));
}

export async function auditArchitectureDocs(root) {
  const directory = path.join(root, "docs", "architecture");
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".md"))
    .sort();
  const sources = new Map(await Promise.all(files.map(async (file) => [
    file,
    await readFile(path.join(directory, file), "utf8"),
  ])));

  for (const file of files) {
    for (const link of linksIn(sources.get(file))) {
      if (!link.target || externalTarget(link.target)) continue;
      const targetPath = link.target.split("#", 1)[0];
      if (!targetPath) continue;
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), targetPath));
      if (sources.has(relative)) continue;
      try {
        sources.set(relative, await readFile(path.resolve(directory, relative), "utf8"));
      } catch {
        // inspectArchitectureSources reports the missing target.
      }
    }
  }

  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "buffer",
  });
  const trackedFiles = stdout.toString("utf8").split("\0").filter(Boolean);
  return [
    ...inspectArchitectureSources(sources, new Set(files)),
    ...inspectArchitectureAuthority(sources, trackedFiles),
  ].sort((left, right) =>
    left.file.localeCompare(right.file) || left.code.localeCompare(right.code));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const violations = await auditArchitectureDocs(process.cwd());
  if (violations.length > 0) {
    for (const violation of violations) process.stderr.write(`${JSON.stringify(violation)}\n`);
    process.exitCode = 1;
  }
}
