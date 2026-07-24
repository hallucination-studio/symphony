import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const inventoryPath = "tools/architecture/retired-inventory.json";
const auditModes = new Set(["baseline", "no-expansion", "final"]);
const textExtensions = new Set([
  ".cjs", ".js", ".json", ".mjs", ".mts", ".py", ".rs", ".toml", ".ts", ".tsx",
]);

function occurrenceFiles(tracked, symbol) {
  return [...tracked]
    .filter(([file, source]) => file !== inventoryPath && source.includes(symbol))
    .map(([file]) => file)
    .sort();
}

function matchingPaths(tracked, patterns) {
  const expressions = patterns.map((pattern) => new RegExp(pattern, "u"));
  return [...tracked.keys()].filter((file) =>
    expressions.some((expression) => expression.test(file))).sort();
}

function addDifference(violations, actual, expected, createViolation) {
  const allowed = new Set(expected);
  for (const value of actual) {
    if (!allowed.has(value)) violations.push(createViolation(value));
  }
}

export function inspectRetiredInventory(inventory, tracked, options) {
  if (options.mode !== undefined && !auditModes.has(options.mode)) {
    throw new Error("retired_inventory_mode_unknown");
  }
  if (options.mode === undefined && options.scope === undefined) {
    throw new Error("retired_inventory_mode_required");
  }
  const violations = [];
  const selected = options.scope
    ? [[options.scope, inventory.scopes[options.scope]]]
    : Object.entries(inventory.scopes);
  if (selected.some(([, scope]) => scope === undefined)) {
    throw new Error("retired_inventory_scope_unknown");
  }

  for (const [scopeName, scope] of selected) {
    const paths = matchingPaths(tracked, scope.path_patterns);
    if (options.mode === "baseline" || options.mode === "no-expansion") {
      addDifference(violations, paths, scope.paths, (file) => ({
        code: "retired_path_untracked_by_baseline", file, scope: scopeName,
      }));
      if (options.mode === "baseline") {
        addDifference(violations, scope.paths, paths, (file) => ({
          code: "retired_baseline_path_missing", file, scope: scopeName,
        }));
      }
      for (const [symbol, expectedFiles] of Object.entries(scope.symbols)) {
        const actualFiles = occurrenceFiles(tracked, symbol);
        addDifference(violations, actualFiles, expectedFiles, (file) => ({
          code: "retired_symbol_untracked_by_baseline", file, scope: scopeName, symbol,
        }));
        if (options.mode === "baseline") {
          addDifference(violations, expectedFiles, actualFiles, (file) => ({
            code: "retired_baseline_symbol_missing", file, scope: scopeName, symbol,
          }));
        }
      }
      continue;
    }

    for (const file of paths) {
      violations.push({ code: "retired_path_remaining", file, scope: scopeName });
    }
    for (const symbol of Object.keys(scope.symbols)) {
      for (const file of occurrenceFiles(tracked, symbol)) {
        violations.push({ code: "retired_symbol_remaining", file, scope: scopeName, symbol });
      }
    }
  }

  return violations.map((violation) => {
    const source = inventory.scopes[violation.scope]?.source;
    return source === undefined ? violation : { ...violation, source };
  }).sort((left, right) =>
    left.file.localeCompare(right.file) || left.code.localeCompare(right.code) ||
    (left.symbol ?? "").localeCompare(right.symbol ?? ""));
}

async function trackedSources(root) {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  const files = stdout.toString("utf8").split("\0").filter(Boolean).sort();
  const sources = await Promise.all(files.map(async (file) => {
    try {
      await stat(path.join(root, file));
    } catch {
      return undefined;
    }
    if (!textExtensions.has(path.extname(file)) || file === inventoryPath) return [file, ""];
    return [file, await readFile(path.join(root, file), "utf8")];
  }));
  return new Map(sources.filter((entry) => entry !== undefined));
}

export async function auditRetiredInventory(root, options) {
  const inventory = JSON.parse(await readFile(path.join(root, inventoryPath), "utf8"));
  return inspectRetiredInventory(inventory, await trackedSources(root), options);
}

export async function currentBaseline(root) {
  const inventory = JSON.parse(await readFile(path.join(root, inventoryPath), "utf8"));
  const tracked = await trackedSources(root);
  for (const scope of Object.values(inventory.scopes)) {
    scope.paths = matchingPaths(tracked, scope.path_patterns);
    for (const symbol of Object.keys(scope.symbols)) {
      scope.symbols[symbol] = occurrenceFiles(tracked, symbol);
    }
  }
  return inventory;
}

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes("--print-baseline") || process.argv.includes("--write-baseline")) {
    const content = `${JSON.stringify(await currentBaseline(process.cwd()), null, 2)}\n`;
    if (process.argv.includes("--write-baseline")) {
      await writeFile(path.join(process.cwd(), inventoryPath), content, "utf8");
    } else {
      process.stdout.write(content);
    }
  } else {
    const options = { mode: option("mode"), scope: option("scope") };
    const violations = await auditRetiredInventory(process.cwd(), options);
    if (violations.length > 0) {
      for (const violation of violations) process.stderr.write(`${JSON.stringify(violation)}\n`);
      process.exitCode = 1;
    }
  }
}
