import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";

const ruleId = /\b[A-Z]{2}(?:-[A-Z][A-Z0-9]*)*-\d{3}\b/gu;
const ownerFiles = new Map([
  ["CO", "conductor.md"],
  ["CT", "contracts.md"],
  ["PF", "performer.md"],
  ["RI", "root-issue.md"],
  ["RM", "roadmap.md"],
  ["RR", "root-reconciliation.md"],
  ["TM", "task-management.md"],
  ["WF", "workflow-model.md"],
  ["WS", "workspace.md"],
]);

function markdownTree(source) {
  return fromMarkdown(source, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
}

function nodeText(node) {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(nodeText).join("");
}

function visit(node, callback) {
  callback(node);
  for (const child of node.children ?? []) visit(child, callback);
}

export function architectureRuleTables(source, file = "") {
  const tables = [];
  let heading = "";
  for (const node of markdownTree(source).children) {
    if (node.type === "heading") heading = nodeText(node).trim();
    if (node.type !== "table" || node.children.length === 0) continue;
    const headers = node.children[0].children.map((cell) => nodeText(cell).trim());
    const rows = node.children.slice(1).map((row) => Object.fromEntries(
      headers.map((header, index) => [header, nodeText(row.children[index] ?? {}).trim()]),
    ));
    tables.push({ file, heading, headers, rows });
  }
  return tables;
}

export function inspectArchitectureRuleModel(sources, auditedFiles = new Set(sources.keys())) {
  const violations = [];
  const definitions = new Map();
  const references = [];

  for (const file of auditedFiles) {
    const source = sources.get(file) ?? "";
    for (const table of architectureRuleTables(source, file)) {
      if (!table.headers.includes("Rule")) continue;
      for (const row of table.rows) {
        const ids = row.Rule?.match(ruleId) ?? [];
        if (ids.length !== 1 || row.Rule.replace(ids[0], "").trim() !== "") {
          violations.push({ code: "invalid_architecture_rule_id", file, target: row.Rule });
          continue;
        }
        const id = ids[0];
        if (definitions.has(id)) {
          violations.push({ code: "duplicate_architecture_rule_id", file, target: id });
        } else {
          definitions.set(id, file);
        }
        if (Object.values(row).some((value) => value === "")) {
          violations.push({ code: "incomplete_architecture_rule", file, target: id });
        }
      }
    }
    for (const match of source.matchAll(ruleId)) references.push({ file, id: match[0] });
  }

  for (const { file, id } of references) {
    if (!definitions.has(id)) {
      violations.push({ code: "undefined_architecture_rule", file, target: id });
    }
  }
  for (const [id, file] of definitions) {
    const expected = ownerFiles.get(id.slice(0, 2));
    if (expected && file !== expected) {
      violations.push({ code: "misplaced_architecture_rule_definition", file, target: id });
    }
  }

  return sortViolations(violations);
}

export function inspectArchitecturePresentation(sources) {
  const violations = [];
  for (const [file, source] of sources) {
    visit(markdownTree(source), (node) => {
      if (node.type === "code" && node.lang === "text" && node.value.split("\n").length > 80) {
        violations.push({
          code: "oversized_architecture_contract_block",
          file,
          target: String(node.position.start.line),
        });
      }
    });
    for (const match of source.matchAll(/```mermaid\s*\n([\s\S]*?)\n```/gu)) {
      if (!/^\s*%%\s+source-rules:/mu.test(match[1])) {
        violations.push({ code: "mermaid_missing_source_rules", file, target: "" });
      }
    }
    for (const [index, line] of source.split("\n").entries()) {
      if (line.length > 240) {
        violations.push({ code: "oversized_architecture_line", file, target: String(index + 1) });
      }
    }
  }
  return sortViolations(violations);
}

export function architectureHeadingAnchors(source) {
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

function markdownLinks(source) {
  const links = [];
  visit(markdownTree(source), (node) => {
    if (node.type === "link") links.push(node.url);
  });
  return links;
}

function externalLink(target) {
  return /^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("//");
}

export function inspectArchitectureSources(sources, auditedFiles = new Set(sources.keys())) {
  const violations = [];
  for (const file of auditedFiles) {
    for (const target of markdownLinks(sources.get(file) ?? "")) {
      if (!target || externalLink(target)) continue;
      const [targetPath, anchor] = target.split("#", 2);
      const resolved = targetPath
        ? path.posix.normalize(path.posix.join(path.posix.dirname(file), targetPath))
        : file;
      if (!sources.has(resolved)) {
        violations.push({ code: "broken_architecture_link", file, target });
      } else if (anchor && !architectureHeadingAnchors(sources.get(resolved)).has(decodeURIComponent(anchor))) {
        violations.push({ code: "broken_architecture_anchor", file, target });
      }
    }
  }
  return sortViolations(violations);
}

export function inspectArchitectureAuthority(sources) {
  const violations = [];
  for (const [file, source] of sources) {
    if (/(?:^|[\s`'"(])tasks\//mu.test(source)) {
      violations.push({ code: "architecture_references_execution_task", file });
    }
  }
  return sortViolations(violations);
}

export function inspectTargetSemantics(sources) {
  const combined = [...sources.values()].join("\n");
  const required = [
    ["missing_root_cycle_execute_audit_topology", /Cycle \| Root[\s\S]*Execute \| Cycle[\s\S]*Audit \| Cycle/u],
    ["missing_failed_execute_audit", /Execute process fails or exits unexpectedly[^\n]*still dispatch Audit/u],
    ["missing_trusted_state_gate", /trusted task state[^\n]*Succeeded Cycles with an `accepted` Audit verdict/u],
    ["missing_done_noop", /Root \| `Done`[^\n]*no Root-owned mutation; exit successfully/u],
    ["missing_root_inbox_fence", /active Cycle exists and new Root comments arrive[^\n]*do not dispatch them into the Cycle/u],
    ["missing_single_root_entry", /Root mode is the only public execution entry[\s\S]*no one-shot\s+role CLI/u],
    ["missing_execute_output_boundary", /Execute model output is neither parsed nor projected/u],
    ["missing_audit_only_result_authority", /verdict alone determines the Cycle result/u],
    ["missing_cycle_summary_boundary", /Cycle Result repeats only the mapped result[\s\S]*never copies Audit evidence/u],
  ];
  const forbidden = [
    ["superseded_plan_issue", /Plan Issue/iu],
    ["superseded_exact_revision", /exact revision/iu],
    ["superseded_commit_proof", /commit proof/iu],
    ["superseded_convergence_proof", /convergence proof/iu],
    ["superseded_manifest_contract", /PlanGraphManifest/u],
    ["superseded_cycle_route", /route:\s*gui\s*\|\s*cli/u],
    ["superseded_dashboard_flag", /--dashboard/u],
    ["superseded_local_task_contract", /mode:\s*local/u],
  ];
  const violations = [];
  for (const [code, pattern] of required) {
    if (!pattern.test(combined)) violations.push({ code, file: "workflow-model.md" });
  }
  for (const [code, pattern] of forbidden) {
    if (pattern.test(combined)) violations.push({ code, file: "docs/architecture" });
  }
  return sortViolations(violations);
}

function sortViolations(violations) {
  return violations.sort((left, right) =>
    left.file.localeCompare(right.file) ||
    left.code.localeCompare(right.code) ||
    String(left.target ?? "").localeCompare(String(right.target ?? "")));
}

export async function auditArchitectureDocs(root) {
  const directory = path.join(root, "docs", "architecture");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".md")).sort();
  const sources = new Map(await Promise.all(files.map(async (file) => [
    file,
    await readFile(path.join(directory, file), "utf8"),
  ])));

  for (const file of files) {
    for (const target of markdownLinks(sources.get(file))) {
      if (!target || externalLink(target)) continue;
      const targetPath = target.split("#", 1)[0];
      if (!targetPath) continue;
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), targetPath));
      if (sources.has(relative)) continue;
      try {
        sources.set(relative, await readFile(path.resolve(directory, relative), "utf8"));
      } catch {
        // inspectArchitectureSources reports missing targets.
      }
    }
  }

  const auditedFiles = new Set(files);
  return sortViolations([
    ...inspectArchitectureSources(sources, auditedFiles),
    ...inspectArchitectureAuthority(sources),
    ...inspectArchitecturePresentation(new Map(files.map((file) => [file, sources.get(file)]))),
    ...inspectArchitectureRuleModel(sources, auditedFiles),
    ...inspectTargetSemantics(new Map(files.map((file) => [file, sources.get(file)]))),
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const violations = await auditArchitectureDocs(process.cwd());
  for (const violation of violations) process.stderr.write(`${JSON.stringify(violation)}\n`);
  if (violations.length > 0) process.exitCode = 1;
}
