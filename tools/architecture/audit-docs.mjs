import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";

const execFileAsync = promisify(execFile);

const inlineLink = /\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/gu;
const referenceDefinition = /^\s*\[([^\]]+)\]:\s*(<[^>]+>|\S+)/gmu;
const referenceUse = /\[([^\]]+)\]\[([^\]]*)\]/gu;
const architectureRuleId = /\b[A-Z]{2}(?:-[A-Z][A-Z0-9]*)*-\d{3}\b/gu;
const architectureRuleOwnerFiles = new Map([
  ["CO", "conductor.md"],
  ["CT", "contracts.md"],
  ["GD", "git-worktree-delivery.md"],
  ["PF", "performer.md"],
  ["RI", "root-issue.md"],
  ["RM", "roadmap.md"],
  ["RR", "root-reconciliation.md"],
  ["TM", "task-management.md"],
  ["WF", "workflow-model.md"],
]);

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

function architectureMarkdownTree(source) {
  return fromMarkdown(source, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
}

function nodeText(node) {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(nodeText).join("");
}

function nodeInnerSource(source, node) {
  const children = node.children ?? [];
  if (children.length === 0) return "";
  const start = children[0].position?.start.offset;
  const end = children.at(-1)?.position?.end.offset;
  return Number.isInteger(start) && Number.isInteger(end)
    ? source.slice(start, end).trim()
    : nodeText(node).trim();
}

function visitMarkdown(node, visitor, ancestors = []) {
  visitor(node, ancestors);
  if (node.type === "code") return;
  for (const child of node.children ?? []) {
    visitMarkdown(child, visitor, [...ancestors, node]);
  }
}

function normativeContractSource(source) {
  const blocks = [];
  visitMarkdown(architectureMarkdownTree(source), (node) => {
    if (node.type === "code" && node.lang === "text") blocks.push(node.value);
  });
  return blocks.join("\n\n");
}

function contractDeclarationCounts(source) {
  const counts = new Map();
  const contracts = normativeContractSource(source);
  for (const match of contracts.matchAll(/^([A-Z][A-Za-z0-9]*)(?:<[^>\n]+>)?\s*(?:=|\{)/gmu)) {
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  return counts;
}

export function architectureRuleTables(source, file = "") {
  const tables = [];
  let heading = "";
  for (const node of architectureMarkdownTree(source).children) {
    if (node.type === "heading") {
      heading = nodeText(node).trim();
      continue;
    }
    if (node.type !== "table" || node.children.length === 0) continue;

    const headers = node.children[0].children.map((cell) => nodeInnerSource(source, cell));
    const rows = node.children.slice(1).map((row) => Object.fromEntries(
      headers.map((header, index) => [
        header,
        row.children[index] ? nodeInnerSource(source, row.children[index]) : "",
      ]),
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
        const ids = row.Rule.match(architectureRuleId) ?? [];
        if (ids.length !== 1 || row.Rule.replace(ids[0], "").replaceAll("`", "").trim() !== "") {
          violations.push({ code: "invalid_architecture_rule_id", file, target: row.Rule });
          continue;
        }
        const id = ids[0];
        if (definitions.has(id)) {
          violations.push({ code: "duplicate_architecture_rule_id", file, target: id });
        } else {
          definitions.set(id, { file, heading: table.heading });
        }
        if (Object.values(row).some((value) => value.trim() === "")) {
          violations.push({ code: "incomplete_architecture_rule", file, target: id });
        }
      }
    }

    for (const match of source.matchAll(architectureRuleId)) {
      references.push({ file, id: match[0] });
    }

    for (const match of source.matchAll(/```mermaid\s*\n([\s\S]*?)\n```/gu)) {
      if (!/^\s*%%\s+source-rules:\s+[A-Z]{2}(?:-[A-Z][A-Z0-9]*)*-\d{3}/mu.test(match[1])) {
        violations.push({ code: "mermaid_missing_source_rules", file, target: "" });
      }
    }
  }

  for (const reference of references) {
    if (!definitions.has(reference.id)) {
      violations.push({ code: "undefined_architecture_rule", file: reference.file, target: reference.id });
    }
  }

  for (const [id, definition] of definitions) {
    const expectedFile = architectureRuleOwnerFiles.get(id.split("-", 1)[0]);
    if (expectedFile && definition.file !== expectedFile) {
      violations.push({ code: "misplaced_architecture_rule_definition", file: definition.file, target: id });
    }
  }

  return violations.sort((left, right) =>
    left.file.localeCompare(right.file) || left.code.localeCompare(right.code) ||
    String(left.target).localeCompare(String(right.target)));
}

export function inspectArchitecturePresentation(sources) {
  const violations = [];

  for (const [file, source] of sources) {
    visitMarkdown(architectureMarkdownTree(source), (node, ancestors) => {
      if (node.type === "code" && node.lang === "text") {
        if (node.value.split("\n").length > 80) {
          violations.push({
            code: "oversized_architecture_contract_block",
            file,
            target: String(node.position.start.line),
          });
        }
        return;
      }

      if (node.type === "code" && node.lang === "mermaid") {
        if (node.value.split("\n").some(
          (line) => /^\s*%%\s+source-rules:/u.test(line) && line.length > 120,
        )) {
          violations.push({
            code: "oversized_architecture_mermaid_source_rules",
            file,
            target: String(node.position.start.line),
          });
        }
        return;
      }

      if (node.type === "table") {
        node.children.forEach((row) => row.children.forEach((cell, cellIndex) => {
          const value = nodeInnerSource(source, cell);
          const oversizedSegment = value.split(/<br\s*\/?\s*>/iu)
            .some((segment) => segment.trim().length > 100);
          const visibleLength = nodeText(cell).replace(/<br\s*\/?\s*>/giu, " ").trim().length;
          if (oversizedSegment || visibleLength > 160) {
            violations.push({
              code: "oversized_architecture_table_cell",
              file,
              target: `${cell.position.start.line}:${cellIndex + 1}`,
            });
          }
        }));
        return;
      }

      if (node.type === "listItem") {
        if (nodeText(node).trim().length > 160) {
          violations.push({
            code: "oversized_architecture_list_item",
            file,
            target: String(node.position.start.line),
          });
        }
        return;
      }

      if (node.type === "paragraph" &&
          !ancestors.some((ancestor) => ancestor.type === "table" || ancestor.type === "listItem") &&
          nodeText(node).trim().length > 160) {
        violations.push({
          code: "oversized_architecture_prose",
          file,
          target: String(node.position.start.line),
        });
      }
    });
  }

  return violations.sort((left, right) =>
    left.file.localeCompare(right.file) || Number(left.target) - Number(right.target));
}

const workflowTableSchemas = new Map([
  ["Authority table", ["Rule", "Authority", "Required evidence", "Forbidden substitute"]],
  ["Topology table", ["Rule", "Resource", "Direct parent", "Cardinality", "Identity source", "Creation gate"]],
  ["Transition table", ["Rule", "Machine", "From", "Event", "Record owner", "Projection owner", "Required durable fact before projection", "To", "Direct Root wake"]],
  ["Routing table", ["Rule", "Priority", "Fresh facts", "Consumer", "Allowed action", "Root model turn"]],
  ["Failure table", ["Rule", "Observed facts", "Owner", "Required write", "Projection", "Resolution"]],
  ["Restart table", ["Rule", "Persisted facts", "Live fact", "Restart action", "Forbidden recovery"]],
  ["Persistence table", ["Rule", "Stage or boundary", "Linear attachment", "Required content", "Explicitly excluded"]],
]);

const requiredWorkflowRules = new Map([
  ["Authority table", ["WF-AUTH-001", "WF-AUTH-002", "WF-AUTH-003", "WF-AUTH-004", "WF-AUTH-005", "WF-AUTH-006", "WF-AUTH-007", "WF-AUTH-008"]],
  ["Topology table", ["WF-TOPO-001", "WF-TOPO-002", "WF-TOPO-003", "WF-TOPO-004", "WF-TOPO-005", "WF-TOPO-006", "WF-TOPO-007"]],
  ["Transition table", ["WF-TR-001", "WF-TR-002", "WF-TR-003", "WF-TR-004", "WF-TR-005", "WF-TR-006", "WF-TR-007", "WF-TR-008", "WF-TR-009", "WF-TR-010", "WF-TR-011", "WF-TR-012", "WF-TR-013", "WF-TR-014", "WF-TR-015"]],
  ["Routing table", ["WF-ROUTE-001", "WF-ROUTE-002", "WF-ROUTE-003", "WF-ROUTE-004", "WF-ROUTE-005", "WF-ROUTE-006", "WF-ROUTE-007", "WF-ROUTE-008", "WF-ROUTE-009", "WF-ROUTE-010", "WF-ROUTE-011", "WF-ROUTE-012", "WF-ROUTE-013", "WF-ROUTE-014", "WF-ROUTE-015", "WF-ROUTE-016", "WF-ROUTE-017", "WF-ROUTE-018"]],
  ["Failure table", ["WF-FAIL-001", "WF-FAIL-002", "WF-FAIL-003", "WF-FAIL-004", "WF-FAIL-005", "WF-FAIL-006", "WF-FAIL-007", "WF-FAIL-008", "WF-FAIL-009", "WF-FAIL-010", "WF-FAIL-011", "WF-FAIL-012", "WF-FAIL-013", "WF-FAIL-014", "WF-FAIL-015", "WF-FAIL-016", "WF-FAIL-017", "WF-FAIL-018"]],
  ["Restart table", ["WF-RESTART-001", "WF-RESTART-002", "WF-RESTART-003", "WF-RESTART-004", "WF-RESTART-005", "WF-RESTART-006", "WF-RESTART-007", "WF-RESTART-008", "WF-RESTART-009", "WF-RESTART-010", "WF-RESTART-011", "WF-RESTART-012", "WF-RESTART-013", "WF-RESTART-014"]],
  ["Persistence table", ["WF-PERSIST-001", "WF-PERSIST-002", "WF-PERSIST-003", "WF-PERSIST-004", "WF-PERSIST-005", "WF-PERSIST-006", "WF-PERSIST-007"]],
]);

function architectureRuleValue(value) {
  return value.replaceAll("`", "").trim();
}

function architectureRuleRowId(row) {
  return row.Rule?.match(architectureRuleId)?.[0] ?? null;
}

function duplicateTableKeys(rows, columns) {
  const seen = new Set();
  const duplicates = new Set();
  for (const row of rows) {
    const key = columns.map((column) => architectureRuleValue(row[column] ?? "")).join("\u0000");
    if (seen.has(key)) duplicates.add(key.replaceAll("\u0000", " | "));
    seen.add(key);
  }
  return [...duplicates].sort();
}

export function inspectWorkflowRuleSemantics(sources) {
  const file = "workflow-model.md";
  const source = sources.get(file);
  if (source === undefined) {
    return [{ code: "missing_workflow_model", file, target: "" }];
  }

  const violations = [];
  const tables = architectureRuleTables(source, file);
  const byHeading = new Map(tables.map((table) => [table.heading, table]));
  const rowsById = new Map();

  for (const [heading, expectedHeaders] of workflowTableSchemas) {
    const table = byHeading.get(heading);
    if (!table) {
      violations.push({ code: "missing_workflow_table", file, target: heading });
      continue;
    }
    if (JSON.stringify(table.headers) !== JSON.stringify(expectedHeaders)) {
      violations.push({ code: "invalid_workflow_table_schema", file, target: heading });
    }

    const actualIds = new Set(table.rows.map(architectureRuleRowId).filter(Boolean));
    const expectedIds = new Set(requiredWorkflowRules.get(heading) ?? []);
    for (const rule of expectedIds) {
      if (!actualIds.has(rule)) {
        violations.push({ code: "missing_workflow_rule", file, target: rule });
      }
    }
    for (const rule of actualIds) {
      if (!expectedIds.has(rule)) {
        violations.push({ code: "unexpected_workflow_rule", file, target: rule });
      }
    }
    for (const row of table.rows) {
      const id = architectureRuleRowId(row);
      if (id) rowsById.set(id, row);
    }
  }

  const uniqueKeys = [
    ["Transition table", ["Machine", "From", "Event"]],
    ["Routing table", ["Fresh facts"]],
    ["Failure table", ["Observed facts"]],
    ["Restart table", ["Persisted facts", "Live fact"]],
    ["Persistence table", ["Stage or boundary"]],
  ];
  for (const [heading, columns] of uniqueKeys) {
    const table = byHeading.get(heading);
    if (!table) continue;
    for (const key of duplicateTableKeys(table.rows, columns)) {
      violations.push({ code: "duplicate_workflow_semantic_key", file, target: `${heading}: ${key}` });
    }
  }

  const expectedCells = [
    ["WF-AUTH-006", "Required evidence", "launch Root ID and one fenced runtime generation"],
    ["WF-AUTH-006", "Forbidden substitute", "second Root adoption、multi-Root orchestration、并发、公平调度"],
    ["WF-AUTH-008", "Forbidden substitute", "first-match order、changed-event order、memory cursor"],
    ["WF-TOPO-001", "Direct parent", "Root"],
    ["WF-TOPO-002", "Direct parent", "Cycle"],
    ["WF-TOPO-003", "Direct parent", "Cycle"],
    ["WF-TOPO-004", "Direct parent", "Cycle"],
    ["WF-TOPO-004", "Cardinality", "exactly one"],
    ["WF-TOPO-007", "Creation gate", "before Work/Verify/relation materialization"],
    ["WF-TR-005", "Record owner", "RootBoundary"],
    ["WF-TR-005", "Projection owner", "CycleMachine"],
    ["WF-TR-001", "Event", "root_admitted"],
    ["WF-TR-001", "Required durable fact before projection", "fresh delegated Todo admission basis"],
    ["WF-TR-002", "Event", "delivery_effects_projectable"],
    ["WF-TR-002", "Required durable fact before projection", "accepted CycleCompletionRecord plus exact remote/PR effect read-back"],
    ["WF-TR-007", "Record owner", "CycleMachine"],
    ["WF-TR-007", "Projection owner", "CycleMachine"],
    ["WF-TR-009", "Record owner", "RootBoundary"],
    ["WF-TR-009", "Projection owner", "CycleMachine"],
    ["WF-TR-011", "Record owner", "CycleMachine"],
    ["WF-TR-011", "Projection owner", "CycleMachine"],
    ["WF-TR-012", "From", "Todo,In Progress"],
    ["WF-TR-012", "To", "Failed"],
    ["WF-TR-013", "From", "In Progress"],
    ["WF-TR-014", "From", "Draft,In Progress,Awaiting Acceptance"],
    ["WF-TR-014", "Projection owner", "CycleMachine"],
    ["WF-TR-014", "To", "Failed"],
    ["WF-TR-015", "Projection owner", "CycleMachine"],
    ["WF-TR-015", "To", "Canceled"],
    ["WF-ROUTE-003", "Consumer", "CycleMachine"],
    ["WF-ROUTE-003", "Root model turn", "no"],
    ["WF-ROUTE-004", "Fresh facts", "cycle_in_progress_mechanical_actionable"],
    ["WF-ROUTE-004", "Root model turn", "no"],
    ["WF-ROUTE-006", "Root model turn", "no"],
    ["WF-ROUTE-009", "Consumer", "FamilyGuard"],
    ["WF-ROUTE-009", "Root model turn", "no"],
    ["WF-ROUTE-010", "Consumer", "DeliveryFinalizer"],
    ["WF-ROUTE-010", "Root model turn", "no"],
    ["WF-ROUTE-011", "Consumer", "CycleMachine"],
    ["WF-ROUTE-011", "Fresh facts", "root_done_with_intact_active_cycle"],
    ["WF-ROUTE-012", "Consumer", "DeliveryFinalizer"],
    ["WF-ROUTE-013", "Consumer", "Cleanup"],
    ["WF-ROUTE-015", "Consumer", "CycleMachine"],
    ["WF-ROUTE-015", "Fresh facts", "active_root_admission_lost_non_done_and_no_cycle_record_projection_pending"],
    ["WF-ROUTE-015", "Root model turn", "no"],
    ["WF-ROUTE-016", "Consumer", "Park"],
    ["WF-ROUTE-016", "Allowed action", "selected-invalidation conflict from WF-FAIL-004/005/006<br>or surface WF-FAIL-009/010/013/017<br>no effect"],
    ["WF-ROUTE-016", "Root model turn", "no"],
    ["WF-ROUTE-017", "Consumer", "CycleMachine"],
    ["WF-ROUTE-017", "Root model turn", "no"],
    ["WF-ROUTE-018", "Consumer", "CycleMachine"],
    ["WF-ROUTE-018", "Fresh facts", "external_cycle_terminal_without_matching_record"],
    ["WF-ROUTE-018", "Root model turn", "no"],
    ["WF-FAIL-001", "Resolution", "expected absence"],
    ["WF-FAIL-002", "Owner", "CycleMachine"],
    ["WF-FAIL-003", "Resolution", "permanent quarantine"],
    ["WF-FAIL-004", "Resolution", "selected invalidation conflict -> WF-ROUTE-016"],
    ["WF-FAIL-005", "Resolution", "new intact record may allow successor<br>selected invalidation conflict -> WF-ROUTE-016<br>otherwise permanent quarantine"],
    ["WF-FAIL-006", "Required write", "selected completion -> Stage-first invalid_status_transition invalidations<br>selected invalidation -> never replace it"],
    ["WF-FAIL-006", "Resolution", "selected invalidation conflict -> WF-ROUTE-016"],
    ["WF-FAIL-010", "Owner", "FamilyGuard"],
    ["WF-FAIL-014", "Owner", "RootBoundary"],
    ["WF-FAIL-015", "Projection", "nonterminal affected Stage becomes Failed<br>terminal Stage is preserved<br>Cycle becomes Failed"],
    ["WF-FAIL-016", "Owner", "CycleMachine"],
    ["WF-FAIL-017", "Owner", "Router"],
    ["WF-FAIL-018", "Owner", "CycleMachine"],
    ["WF-RESTART-002", "Persisted facts", "selected terminal record present, non-terminal status"],
    ["WF-RESTART-002", "Restart action", "exact source -> project target<br>wrong source -> WF-FAIL-006<br>selected invalidation conflict -> WF-ROUTE-016"],
    ["WF-RESTART-004", "Persisted facts", "next Work Todo, prior Work complete"],
    ["WF-RESTART-004", "Live fact", "typed live Work-thread loss"],
    ["WF-RESTART-004", "Restart action", "apply WF-FAIL-018, then WF-TR-008"],
    ["WF-RESTART-004", "Forbidden recovery", "dispatch next Work<br>reconstruct from any durable source"],
    ["WF-RESTART-011", "Persisted facts", "Root Done with intact_active_cycle or delivery gap"],
    ["WF-RESTART-011", "Forbidden recovery", "cleanup before WF-RESTART-002<br>generic closure masking a specific failure fact"],
    ["WF-RESTART-012", "Persisted facts", "Symphony-projected Root In Progress, Root definition absent"],
    ["WF-RESTART-013", "Persisted facts", "Root In Review, delivery completion/invalidation absent"],
    ["WF-RESTART-014", "Persisted facts", "valid delivery invalidation, Root In Progress or In Review"],
    ["WF-PERSIST-001", "Linear attachment", "Cycle Issue"],
    ["WF-PERSIST-002", "Linear attachment", "Plan Issue"],
    ["WF-PERSIST-003", "Linear attachment", "corresponding Work Issue"],
    ["WF-PERSIST-004", "Linear attachment", "Verify Issue"],
    ["WF-PERSIST-005", "Linear attachment", "Cycle Issue"],
    ["WF-PERSIST-006", "Linear attachment", "Root Issue"],
    ["WF-PERSIST-007", "Linear attachment", "nowhere durable"],
  ];
  for (const [rule, column, expected] of expectedCells) {
    const row = rowsById.get(rule);
    if (row && architectureRuleValue(row[column] ?? "") !== expected) {
      violations.push({ code: "invalid_workflow_rule_semantics", file, target: `${rule}.${column}` });
    }
  }

  const routingPredicate = byHeading.get("Routing predicates")?.rows.find(
    (row) => architectureRuleValue(row.Predicate ?? "") === "intact_active_cycle",
  );
  const predicateRequires = architectureRuleValue(routingPredicate?.["Requires every clause"] ?? "");
  const predicateExcludes = architectureRuleValue(routingPredicate?.["Excludes any unresolved fact"] ?? "");
  if (!predicateRequires.includes("one exact non-terminal Cycle") ||
      !predicateRequires.includes("no Cycle record projection gap") ||
      ["external terminal", "record/status mismatch", "sealed mutation", "lost context", "invalid record",
        "partial materialization", "other specific failure"]
        .some((fact) => !predicateExcludes.includes(fact))) {
    violations.push({
      code: "incomplete_routing_predicate",
      file,
      target: "intact_active_cycle",
    });
  }

  const terminalSelectionTable = byHeading.get("Terminal record selection");
  const terminalSelectionRows = new Map((terminalSelectionTable?.rows ?? []).map((row) => [
    `${architectureRuleValue(row["Completion slot"] ?? "")}\u0000${architectureRuleValue(row["Invalidation slot"] ?? "")}`,
    architectureRuleValue(row.Selection ?? ""),
  ]));
  const terminalSelectionExpected = new Map([
    ["absent、valid or invalid\u0000valid", "invalidation; retain completion slot as superseded evidence"],
    ["valid\u0000absent", "completion"],
    ["invalid observation\u0000absent", "no selection; record kind and phase choose WF-FAIL-008 or WF-FAIL-015"],
    ["absent\u0000absent", "no terminal record"],
    ["any\u0000invalid observation", "WF-FAIL-009 or phase-specific quarantine; no fallback"],
  ]);
  if (!terminalSelectionTable ||
      JSON.stringify(terminalSelectionTable.headers) !== JSON.stringify([
        "Completion slot", "Invalidation slot", "Selection",
      ]) ||
      terminalSelectionRows.size !== terminalSelectionExpected.size ||
      [...terminalSelectionExpected].some(([key, value]) => terminalSelectionRows.get(key) !== value)) {
    violations.push({
      code: "invalid_terminal_record_precedence",
      file,
      target: "Terminal record selection",
    });
  }

  const recordFirstTransitions = [
    "WF-TR-002", "WF-TR-003", "WF-TR-005", "WF-TR-006", "WF-TR-007",
    "WF-TR-008", "WF-TR-009", "WF-TR-010", "WF-TR-012", "WF-TR-013",
    "WF-TR-014", "WF-TR-015",
  ];
  for (const rule of recordFirstTransitions) {
    const fact = architectureRuleValue(rowsById.get(rule)?.["Required durable fact before projection"] ?? "");
    if (!/record/iu.test(fact)) {
      violations.push({ code: "transition_without_durable_record", file, target: rule });
    }
  }

  for (const rule of requiredWorkflowRules.get("Transition table") ?? []) {
    const wake = architectureRuleValue(rowsById.get(rule)?.["Direct Root wake"] ?? "");
    if (rowsById.has(rule) && wake !== "no") {
      violations.push({ code: "direct_root_wake_from_transition", file, target: rule });
    }
  }

  const rootTurnExpected = new Map([
    ["WF-ROUTE-001", "yes"], ["WF-ROUTE-002", "yes"], ["WF-ROUTE-003", "no"],
    ["WF-ROUTE-004", "no"], ["WF-ROUTE-005", "yes"], ["WF-ROUTE-006", "no"],
    ["WF-ROUTE-007", "yes"], ["WF-ROUTE-008", "yes"], ["WF-ROUTE-009", "no"],
    ["WF-ROUTE-010", "no"], ["WF-ROUTE-011", "no"], ["WF-ROUTE-012", "no"],
    ["WF-ROUTE-013", "no"], ["WF-ROUTE-014", "no"], ["WF-ROUTE-015", "no"],
    ["WF-ROUTE-016", "no"], ["WF-ROUTE-017", "no"], ["WF-ROUTE-018", "no"],
  ]);
  for (const [rule, expected] of rootTurnExpected) {
    const actual = architectureRuleValue(rowsById.get(rule)?.["Root model turn"] ?? "");
    if (rowsById.has(rule) && actual !== expected) {
      violations.push({ code: "invalid_root_wake_semantics", file, target: rule });
    }
  }

  const expectedRoutingPriorities = new Map([
    ["WF-ROUTE-001", 110], ["WF-ROUTE-002", 100], ["WF-ROUTE-003", 60],
    ["WF-ROUTE-004", 80], ["WF-ROUTE-005", 130], ["WF-ROUTE-006", 45],
    ["WF-ROUTE-007", 90], ["WF-ROUTE-008", 120], ["WF-ROUTE-009", 10],
    ["WF-ROUTE-010", 70], ["WF-ROUTE-011", 20], ["WF-ROUTE-012", 30],
    ["WF-ROUTE-013", 40], ["WF-ROUTE-014", 140], ["WF-ROUTE-015", 55],
    ["WF-ROUTE-016", 1], ["WF-ROUTE-017", 50], ["WF-ROUTE-018", 15],
  ]);
  const seenPriorities = new Set();
  for (const [rule, expected] of expectedRoutingPriorities) {
    const value = architectureRuleValue(rowsById.get(rule)?.Priority ?? "");
    const actual = /^\d+$/u.test(value) ? Number(value) : Number.NaN;
    if (rowsById.has(rule) && (actual !== expected || seenPriorities.has(actual))) {
      violations.push({ code: "invalid_routing_priority_semantics", file, target: `${rule}.Priority` });
    }
    seenPriorities.add(actual);
  }

  return violations.sort((left, right) =>
    left.file.localeCompare(right.file) || left.code.localeCompare(right.code) ||
    String(left.target).localeCompare(String(right.target)));
}

function architectureRowsById(sources) {
  const rows = new Map();
  for (const [file, source] of sources) {
    for (const table of architectureRuleTables(source, file)) {
      if (!table.headers.includes("Rule")) continue;
      for (const row of table.rows) {
        const id = architectureRuleRowId(row);
        if (id) rows.set(id, { file, heading: table.heading, row });
      }
    }
  }
  return rows;
}

export function inspectArchitectureCrossSemantics(sources) {
  const violations = [];
  const rows = architectureRowsById(sources);
  const expectedCells = [
    ["RR-DEFINE-001", "Durable effect", "Root In Progress projection"],
    ["RR-DEFINE-001", "Rule dependency", "WF-TR-001; restart gap is WF-RESTART-012"],
    ["GD-DELIVERY-003", "Durable result", "Root In Review fresh read-back under WF-TR-002"],
    ["GD-DELIVERY-003", "Restart behavior", "continue same fenced finalizer; restart uses WF-RESTART-013"],
    ["GD-DELIVERY-004", "Durable result", "Root-attached DeliveryCompletionRecord containing DeliveryConvergenceProof"],
    ["CO-LOOP-001", "Runtime fact", "exact launch Root ID"],
    ["CO-CLEAN-001", "Allowed deletion", "matching Root runtime/process/thread/Home, then terminate this Conductor"],
    ["RI-MANIFEST-003", "Exact check", "Cycle/spec/approval IDs equal<br>Plan Issue/completion/invalidation IDs equal"],
    ["RI-MANIFEST-004", "Exact check", "Plan record provider time is earlier than every materialized Work、Verify and relation provider time"],
    ["RI-MANIFEST-008", "Exact check", "one exact blocks relation per Work dependency<br>one Verify barrier per Work<br>no extra relation"],
    ["TM-OBS-005", "Failure behavior", "select by absence/corruption、record kind and phase"],
    ["PF-CTX-003", "Excluded input", "Plan/Work context、Work continuation、write capability"],
    ["CT-TM-010", "Structural constraint", "valid invalidation dominates completion<br>completion remains superseded evidence<br>invalid invalidation quarantines"],
  ];
  for (const [rule, column, expected] of expectedCells) {
    const definition = rows.get(rule);
    const actual = architectureRuleValue(definition?.row[column] ?? "");
    if (definition && actual !== expected) {
      violations.push({
        code: "invalid_cross_document_rule_semantics",
        file: definition.file,
        target: `${rule}.${column}`,
      });
    }
  }

  const rootIssueTables = architectureRuleTables(sources.get("root-issue.md") ?? "", "root-issue.md");
  const manifestAnchorTable = rootIssueTables.find(
    (table) => table.heading === "Manifest anchor equality",
  );
  const manifestAnchorRows = new Map((manifestAnchorTable?.rows ?? []).map((row) => [
    architectureRuleValue(row.Binding ?? ""),
    architectureRuleValue(row["Values that must be equal"] ?? ""),
  ]));
  const requiredManifestAnchors = new Map([
    ["approval owner", "approval record ID、Cycle Issue ID、record Cycle ID"],
    ["lineage", "derivation version、predecessor Cycle ID、predecessor terminal record ID"],
    ["Plan slots", "Plan Issue ID、Plan completion ID、Plan invalidation ID"],
    ["terminal slots", "Cycle completion/invalidation IDs、delivery completion/invalidation IDs"],
    ["sealed basis", "specification seal、workspace base revision"],
    ["manifest basis", "Cycle ID、approval record ID、specification seal"],
    ["Plan node", "Plan Issue ID、Cycle parent、completion ID、invalidation ID"],
    ["relation endpoints", "Work-group node IDs、unique Verify Issue ID"],
  ]);
  if (!manifestAnchorTable || manifestAnchorRows.size !== requiredManifestAnchors.size ||
      [...requiredManifestAnchors].some(([key, value]) => manifestAnchorRows.get(key) !== value)) {
    violations.push({
      code: "incomplete_manifest_anchor_table",
      file: "root-issue.md",
      target: "Manifest anchor equality",
    });
  }

  const contractsDocument = sources.get("contracts.md") ?? "";
  for (const [name, count] of contractDeclarationCounts(contractsDocument)) {
    if (count > 1) {
      violations.push({
        code: "duplicate_contract_declaration",
        file: "contracts.md",
        target: name,
      });
    }
  }
  const contracts = normativeContractSource(contractsDocument);
  const requiredToolContracts = [
    "TaskMcpCall",
    "TaskMcpResult",
    "GitToolCall",
    "GitToolResult",
    "DeliveryToolCall",
    "DeliveryToolResult",
  ];
  const declarationCounts = contractDeclarationCounts(contractsDocument);
  if (requiredToolContracts.some((name) => declarationCounts.get(name) !== 1)) {
    violations.push({
      code: "missing_public_tool_contract",
      file: "contracts.md",
      target: requiredToolContracts.join("|"),
    });
  }
  const publicToolResultEnvelopes = [
    /TaskMcpResultCommon\s*\{\s*schema_version:\s*1,\s*root_id,\s*correlation_id\s*\}/u,
    /TaskMcpResult\s*=\s*TaskMcpResultCommon\s*&/u,
    /GitToolResultCommon\s*\{\s*schema_version:\s*1,\s*root_id,\s*cycle_id,\s*correlation_id\s*\}/u,
    /GitToolResult\s*=\s*GitToolResultCommon\s*&/u,
    /DeliveryToolResultCommon\s*\{\s*schema_version:\s*1,\s*root_id,\s*cycle_id,\s*correlation_id\s*\}/u,
    /DeliveryToolResult\s*=\s*DeliveryToolResultCommon\s*&/u,
  ];
  if (publicToolResultEnvelopes.some((pattern) => !pattern.test(contracts))) {
    violations.push({
      code: "invalid_public_tool_result_envelope",
      file: "contracts.md",
      target: "TaskMcpResult|GitToolResult|DeliveryToolResult",
    });
  }

  const nonEmptyWorkGraphContracts = [
    /execution_directives:\s*\[ExecutionDirective,\s*\.\.\.ExecutionDirective\[\]\]/u,
    /approved_work_groups:\s*\[ApprovedWorkGroup,\s*\.\.\.ApprovedWorkGroup\[\]\]/u,
    /directive_ids:\s*\[DirectiveId,\s*\.\.\.DirectiveId\[\]\]/u,
    /OrderedManifestWorkNodes<CycleId>\s*=\s*branded\s*\[ManifestWorkNode<CycleId>,\s*\.\.\.ManifestWorkNode<CycleId>\[\]\]/u,
    /ordered_work_nodes:\s*OrderedManifestWorkNodes<typeof cycle_id>/u,
    /ordered_work_issue_ids:\s*IssueIdsOf<ordered_work_nodes>/u,
    /verify_node:\s*ManifestVerifyNode<typeof cycle_id>/u,
    /verify_issue_id:\s*typeof verify_node\.issue_id/u,
    /ordered_work_group_ids:\s*\[WorkGroupId,\s*\.\.\.WorkGroupId\[\]\]/u,
  ];
  if (nonEmptyWorkGraphContracts.some((pattern) => !pattern.test(contracts))) {
    violations.push({
      code: "empty_work_graph_contract",
      file: "contracts.md",
      target: "CycleSpecification|PlanGraphManifest|PlanResult",
    });
  }

  const completedPlanCompletion = /CompletedPlanCompletion<Basis:\s*SealedCycleBasis>\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "";
  const failedPlanCompletion = /FailedPlanCompletion\s*\{([^}]*)\}/u.exec(contracts)?.[1] ?? "";
  const canceledPlanCompletion = /CanceledPlanCompletion\s*\{([^}]*)\}/u.exec(contracts)?.[1] ?? "";
  if (!/manifest:\s*PlanGraphManifest<Basis>/u.test(completedPlanCompletion) ||
      !/graph_seal_digest/u.test(completedPlanCompletion) ||
      !/traceability_by_issue_id_markdown/u.test(completedPlanCompletion) ||
      [failedPlanCompletion, canceledPlanCompletion].some((body) =>
        !/reason_markdown/u.test(body) || /manifest|graph_seal|traceability/u.test(body))) {
    violations.push({
      code: "invalid_plan_terminal_payload_split",
      file: "contracts.md",
      target: "PlanCompletion",
    });
  }

  const taskPollResult = /TaskPollResult\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "";
  const linearExecutionSnapshot = /LinearExecutionSnapshot\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "";
  const cycleExecutionSnapshot = /CycleExecutionSnapshot\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "";
  const gitSnapshot = /GitSnapshot\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "";
  const remoteRefSnapshot = /RemoteRefSnapshot\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "";
  const acceptanceObservationRound = /AcceptanceObservationRound\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "";
  const deliveryObservationRound = /DeliveryObservationRound\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "";
  if (!/\blinear_snapshot_digest\b/u.test(linearExecutionSnapshot) ||
      !/\bissue_record_observations:\s*TaskIssueRecordObservation\[\]/u.test(linearExecutionSnapshot) ||
      /\bGitSnapshot\b|delivery_provider/iu.test(linearExecutionSnapshot) ||
      !/^\s*execution_snapshot_digest,\s*linear:\s*LinearExecutionSnapshot,\s*git:\s*GitSnapshot\s*$/u.test(cycleExecutionSnapshot) ||
      /remote_ref|pull_request|RemoteRefSnapshot|PullRequestSnapshot/iu.test(gitSnapshot) ||
      !/repository_id,\s*ref_name,\s*revision\s*\|\s*null,\s*provider_observed_at/u.test(remoteRefSnapshot) ||
      !/\blinear_snapshot_digest\b/u.test(acceptanceObservationRound) ||
      !/\blinear_snapshot_digest\b/u.test(deliveryObservationRound) ||
      /\blinear_execution_snapshot_digest\b/u.test(contracts)) {
    violations.push({
      code: "invalid_provider_separated_execution_contract",
      file: "contracts.md",
      target: "LinearExecutionSnapshot|CycleExecutionSnapshot",
    });
  }

  const routingDispositionVariants = [
    /disposition:\s*root_boundary,\s*selected_route:\s*WF-ROUTE-001,\s*active_cycle_id:\s*null/u,
    /disposition:\s*root_boundary,\s*selected_route:\s*WF-ROUTE-002\s*\|\s*WF-ROUTE-005\s*\|\s*WF-ROUTE-007,\s*active_cycle_id:\s*CycleIssueId/u,
    /disposition:\s*root_boundary,\s*selected_route:\s*WF-ROUTE-008,\s*active_cycle_id:\s*null,\s*predecessor_cycle_id:\s*CycleIssueId/u,
    /disposition:\s*cycle_machine,\s*selected_route:\s*WF-ROUTE-003\s*\|\s*WF-ROUTE-004\s*\|\s*WF-ROUTE-006\s*\|\s*WF-ROUTE-011\s*\|\s*WF-ROUTE-015\s*\|\s*WF-ROUTE-017\s*\|\s*WF-ROUTE-018,/u,
    /disposition:\s*family_guard,\s*selected_route:\s*WF-ROUTE-009,/u,
    /disposition:\s*delivery_finalizer,\s*selected_route:\s*WF-ROUTE-010\s*\|\s*WF-ROUTE-012,/u,
    /disposition:\s*cleanup,\s*selected_route:\s*WF-ROUTE-013,/u,
    /disposition:\s*park,\s*selected_route:\s*WF-ROUTE-014,/u,
    /disposition:\s*park,\s*selected_route:\s*WF-ROUTE-016,\s*selected_failure:\s*WF-FAIL-004\s*\|\s*WF-FAIL-005\s*\|\s*WF-FAIL-006,\s*active_cycle_id:\s*CycleIssueId,\s*reason_code:\s*selected_invalidation_conflict/u,
    /disposition:\s*park,\s*selected_route:\s*WF-ROUTE-016,\s*selected_failure:\s*WF-FAIL-009,\s*active_cycle_id:\s*null,\s*reason_code:\s*invalid_invalidation_record/u,
    /disposition:\s*park,\s*selected_route:\s*WF-ROUTE-016,\s*selected_failure:\s*WF-FAIL-010,\s*active_cycle_id:\s*null,\s*reason_code:\s*multiple_non_terminal_cycles/u,
    /disposition:\s*park,\s*selected_route:\s*WF-ROUTE-016,\s*selected_failure:\s*WF-FAIL-013,\s*active_cycle_id:\s*null,\s*reason_code:\s*unsupported_external_destruction/u,
    /disposition:\s*park,\s*selected_route:\s*WF-ROUTE-016,\s*selected_failure:\s*WF-FAIL-017,\s*active_cycle_id:\s*null,\s*reason_code:\s*incomplete_known_identity_evidence/u,
  ];
  if (routingDispositionVariants.some((pattern) => !pattern.test(contracts)) ||
      /disposition:\s*(?:root_semantic|cycle_mechanical|projection_only|family_quarantine_required)\b/u.test(contracts)) {
    violations.push({
      code: "invalid_root_routing_disposition_contract",
      file: "contracts.md",
      target: "RootRoutingDisposition",
    });
  }

  const stateMapContract = /TaskWorkflowStateMap\s*\{\s*team_id,\s*revision,\s*todo_state_id,\s*draft_state_id,\s*in_progress_state_id,\s*awaiting_acceptance_state_id,\s*in_review_state_id,\s*done_state_id,\s*succeeded_state_id,\s*rejected_state_id,\s*failed_state_id,\s*canceled_state_id\s*\}/u;
  const taskSnapshot = /TaskSnapshot\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "";
  const stateMapRule = rows.get("TM-PROVIDER-007");
  if (!stateMapContract.test(contracts) ||
      !/\bworkflow_state_map:\s*TaskWorkflowStateMap\b/u.test(taskSnapshot) ||
      !stateMapRule ||
      architectureRuleValue(stateMapRule.row["If unproven or violated"] ?? "") !==
        "observation/admission/mutation boundary stays unavailable<br>visible sanitized capability error") {
    violations.push({
      code: "invalid_workflow_state_mapping_contract",
      file: "contracts.md",
      target: "TaskWorkflowStateMap",
    });
  }

  const issueHistory = /TaskIssueHistoryEntry\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "";
  if (!/changed_fields:\s*\(status\s*\|\s*title\s*\|\s*description\s*\|\s*parent\s*\|\s*labels\s*\|\s*delegate\s*\|\s*priority\s*\|\s*archived\s*\|\s*trashed\s*\|\s*relation\)\[\]/u
        .test(issueHistory) ||
      !/archived\s*\|\s*null,\s*trashed\s*\|\s*null/u.test(issueHistory)) {
    violations.push({
      code: "incomplete_grouped_history_contract",
      file: "contracts.md",
      target: "TaskIssueHistoryEntry.changed_fields",
    });
  }

  const mutationBasisContracts = [
    /TaskResourceBasis<ResourceId>\s*\{\s*resource_id:\s*ResourceId,\s*revision\s*\}/u,
    /TaskMutationBasis<IssueId>\s*=\s*TaskResourceBasis<IssueId>\s*&\s*\{\s*status,\s*document_digest,\s*history_digest\s*\}/u,
    /TaskAbsentResourceBasis<Kind,\s*ResourceId>\s*\{\s*resource_kind:\s*Kind,\s*resource_id:\s*ResourceId,\s*observed_absent_at,\s*absence_observation_digest\s*\}/u,
    /TaskIssueCreateBasis<IssueId,\s*ParentId>\s*\{\s*target:\s*TaskAbsentResourceBasis<issue,\s*IssueId>,\s*parent:\s*TaskMutationBasis<ParentId>,\s*workflow_state_map_revision\s*\}/u,
    /TaskCommentCreateBasis<CommentId,\s*IssueId>\s*\{\s*target:\s*TaskAbsentResourceBasis<comment,\s*CommentId>,\s*owner:\s*TaskMutationBasis<IssueId>\s*\}/u,
    /TaskRelationCreateBasis<RelationId,\s*SourceId,\s*TargetId>\s*\{\s*target:\s*TaskAbsentResourceBasis<relation,\s*RelationId>,\s*source:\s*TaskMutationBasis<SourceId>,\s*destination:\s*TaskMutationBasis<TargetId>\s*\}/u,
    /operation:\s*delete_relation,\s*relation_id,\s*basis:\s*TaskResourceBasis<typeof relation_id>/u,
  ];
  if (mutationBasisContracts.some((pattern) => !pattern.test(contracts))) {
    violations.push({
      code: "unbound_task_mutation_basis",
      file: "contracts.md",
      target: "TaskResourceBasis|TaskMutationBasis|TaskAbsentResourceBasis",
    });
  }

  const invalidTaskSnapshotContract = /InvalidTaskSnapshot\s*=\s*\{\s*root_id,\s*observed_at,\s*failure_kind:\s*provider_proven_known_issue_permanently_missing,\s*known_issue_id,\s*expected_owner_issue_id\s*\|\s*null,\s*surviving_family_digest,\s*sanitized_reason_code:\s*unsupported_external_destruction\s*\}\s*\|\s*\{\s*root_id,\s*observed_at,\s*failure_kind:\s*incomplete_known_identity_evidence,\s*known_issue_id,\s*expected_owner_issue_id\s*\|\s*null,\s*surviving_family_digest,\s*sanitized_reason_code:\s*incomplete_known_identity_evidence\s*\}/u;
  const invalidTaskSnapshotBody = /InvalidTaskSnapshot\s*=([\s\S]*?)TaskSnapshotObservation/u.exec(contracts)?.[1] ?? "";
  if (!invalidTaskSnapshotContract.test(contracts) ||
      /\bdisposition\s*:/u.test(invalidTaskSnapshotBody)) {
    violations.push({
      code: "invalid_task_snapshot_failure_contract",
      file: "contracts.md",
      target: "InvalidTaskSnapshot",
    });
  }

  const cycleContextObservation = /CycleContextObservation\s*=([\s\S]*?)CycleAdvanceRequest/u
    .exec(contracts)?.[1] ?? "";
  const cycleContextVariants = [
    /state:\s*not_required,[\s\S]*?cycle_id,\s*runtime_generation/u,
    /state:\s*live,\s*context_kind:\s*active_stage,[\s\S]*?stage_issue_id,\s*stage_kind:\s*plan\s*\|\s*work\s*\|\s*verify/u,
    /state:\s*live,\s*context_kind:\s*work_continuation,[\s\S]*?prior_work_issue_id,\s*next_todo_work_issue_id/u,
    /state:\s*lost_during_active_stage,[\s\S]*?stage_issue_id,\s*stage_kind:\s*plan\s*\|\s*work\s*\|\s*verify/u,
    /state:\s*lost_after_completed_work,[\s\S]*?prior_work_issue_id,\s*next_todo_work_issue_id/u,
  ];
  const cycleAdvanceRequest = /CycleAdvanceRequest\s*\{\s*schema_version:\s*1,\s*root_id,\s*cycle_id,\s*correlation_id,\s*runtime_generation,\s*selected_route:\s*WF-ROUTE-003\s*\|\s*WF-ROUTE-004\s*\|\s*WF-ROUTE-006\s*\|\s*WF-ROUTE-011\s*\|\s*WF-ROUTE-015\s*\|\s*WF-ROUTE-017\s*\|\s*WF-ROUTE-018,\s*execution_snapshot:\s*CycleExecutionSnapshot,\s*context_observation:\s*CycleContextObservation\s*\}/u;
  const cycleAdvanceCommon = /CycleAdvanceResultCommon\s*\{\s*schema_version:\s*1,\s*root_id,\s*cycle_id,\s*correlation_id,\s*runtime_generation,\s*input_execution_snapshot_digest,\s*input_context_observation_digest\s*\}/u;
  const cycleAdvanceOutcomes = [
    /selected_route:\s*WF-ROUTE-003,\s*outcome:\s*advanced,\s*projected_status:\s*In Progress/u,
    /selected_route:\s*WF-ROUTE-003,\s*outcome:\s*terminalized,\s*terminal_status:\s*Succeeded\s*\|\s*Rejected\s*\|\s*Failed\s*\|\s*Canceled/u,
    /selected_route:\s*WF-ROUTE-004,\s*outcome:\s*advanced\s*\|\s*awaiting_acceptance/u,
    /selected_route:\s*WF-ROUTE-004,\s*outcome:\s*terminalized,\s*terminal_status:\s*Failed/u,
    /selected_route:\s*WF-ROUTE-011,\s*outcome:\s*terminalized,\s*terminal_status:\s*Canceled/u,
    /selected_route:\s*WF-ROUTE-006\s*\|\s*WF-ROUTE-017,\s*outcome:\s*terminalized,\s*terminal_status:\s*Failed/u,
    /selected_route:\s*WF-ROUTE-015,\s*outcome:\s*terminalized,\s*terminal_status:\s*Canceled/u,
    /selected_route:\s*WF-ROUTE-018,\s*outcome:\s*terminal_recorded,\s*preserved_terminal_status:\s*Succeeded\s*\|\s*Rejected\s*\|\s*Failed\s*\|\s*Canceled/u,
    /outcome:\s*stale_before_effect\s*\|\s*no_action,\s*effect_may_have_occurred:\s*false,\s*sanitized_reason/u,
    /outcome:\s*conflict_observed,\s*effect_may_have_occurred:\s*true,\s*sanitized_reason/u,
  ];
  const cycleAdvanceResult = /CycleAdvanceResult\s*=\s*CycleAdvanceResultCommon\s*&\s*\(([\s\S]*?)\n\)/u.exec(contracts)?.[1] ?? "";
  if (!cycleContextObservation ||
      cycleContextVariants.some((pattern) => !pattern.test(cycleContextObservation)) ||
      !cycleAdvanceRequest.test(contracts) || !cycleAdvanceCommon.test(contracts) ||
      !/CycleAdvanceResult\s*=\s*CycleAdvanceResultCommon\s*&/u.test(contracts) ||
      cycleAdvanceOutcomes.some((pattern) => !pattern.test(cycleAdvanceResult))) {
    violations.push({
      code: "invalid_cycle_advance_contract",
      file: "contracts.md",
      target: "CycleAdvanceRequest|CycleAdvanceResult",
    });
  }

  const acceptedCycleContract = /AcceptedCycleCompletionRecord\s*=\s*TaskIssueRecordCommon\s*&\s*\{\s*record_kind:\s*cycle_completion,\s*successor_policy:\s*not_applicable,\s*completion:\s*AcceptedCycleCompletion\s*\}/u;
  const retryableCycleContract = /RetryableCycleCompletionRecord\s*=\s*TaskIssueRecordCommon\s*&\s*\{\s*record_kind:\s*cycle_completion,\s*successor_policy:\s*allowed,\s*completion:\s*RejectedCycleCompletion\s*\|\s*FailedCycleCompletion\s*\|\s*CanceledCycleCompletion\s*\}/u;
  const cycleCompletionUnion = /CycleCompletionRecord\s*=\s*AcceptedCycleCompletionRecord\s*\|\s*RetryableCycleCompletionRecord/u;
  if (!acceptedCycleContract.test(contracts) || !retryableCycleContract.test(contracts) ||
      !cycleCompletionUnion.test(contracts)) {
    violations.push({
      code: "invalid_cycle_completion_outcome_policy_contract",
      file: "contracts.md",
      target: "CycleCompletionRecord",
    });
  }

  const workCompletionEvidence = /WorkCompletionEvidence\s*\{\s*instruction_digest,\s*workspace_parent_revision,\s*workspace_diff_digest,\s*checks_markdown,\s*normalized_handoff_markdown\s*\}/u;
  const verifyCompletionEvidence = /VerifyCompletionEvidence\s*\{\s*instruction_digest,\s*exact_revision,\s*checks_markdown,\s*evidence_markdown\s*\}/u;
  const completionEvidenceVariants = [
    /CompletedWorkCompletion\s*=\s*WorkCompletionEvidence\s*&\s*\{\s*outcome:\s*completed\s*\}/u,
    /FailedWorkCompletion\s*=\s*WorkCompletionEvidence\s*&/u,
    /CanceledWorkCompletion\s*=\s*WorkCompletionEvidence\s*&/u,
    /PassedVerifyCompletion\s*=\s*VerifyCompletionEvidence\s*&/u,
    /FailedVerifyCompletion\s*=\s*VerifyCompletionEvidence\s*&/u,
    /CanceledVerifyCompletion\s*=\s*VerifyCompletionEvidence\s*&/u,
  ];
  if (!workCompletionEvidence.test(contracts) || !verifyCompletionEvidence.test(contracts) ||
      completionEvidenceVariants.some((pattern) => !pattern.test(contracts))) {
    violations.push({
      code: "incomplete_stage_terminal_evidence_contract",
      file: "contracts.md",
      target: "WorkCompletion|VerifyCompletion",
    });
  }

  const manifestDependencyRelations = [
    /WorkNodeFor<GroupId,\s*Works>\s*=\s*unique member of Works\s*whose approved_work_group_id equals GroupId/u,
    /ManifestDependencyRelation<Works,\s*VerifyId>\s*=\s*\{\s*relation_id,\s*relation_role:\s*work_dependency,\s*type:\s*blocks,\s*prerequisite_work_group_id,\s*dependent_work_group_id,\s*source_issue_id:\s*typeof WorkNodeFor<prerequisite_work_group_id,\s*Works>\.issue_id,\s*target_issue_id:\s*typeof WorkNodeFor<dependent_work_group_id,\s*Works>\.issue_id\s*\}/u,
    /relation_role:\s*verify_barrier,\s*type:\s*blocks,\s*prerequisite_work_group_id,\s*source_issue_id:\s*typeof WorkNodeFor<prerequisite_work_group_id,\s*Works>\.issue_id,\s*target_issue_id:\s*VerifyId/u,
    /ExactManifestRelations<Works,\s*VerifyId>\s*=\s*branded\s*ManifestDependencyRelation<Works,\s*VerifyId>\[\]\s*with one relation per sealed dependency, one Verify barrier per Work, no others/u,
    /relations:\s*ExactManifestRelations<ordered_work_nodes,\s*typeof verify_issue_id>/u,
  ];
  if (manifestDependencyRelations.some((pattern) => !pattern.test(contracts))) {
    violations.push({
      code: "incomplete_manifest_dependency_relation_contract",
      file: "contracts.md",
      target: "ManifestDependencyRelation",
    });
  }

  const manifestNodeContracts = [
    /ManifestPlanNode<CycleId,\s*PlanId,\s*CompletionRecordId,\s*InvalidationRecordId>\s*\{\s*kind:\s*plan,\s*issue_id:\s*PlanId,\s*parent_issue_id:\s*CycleId,\s*completion_record_id:\s*CompletionRecordId,\s*invalidation_record_id:\s*InvalidationRecordId,[\s\S]*?instruction_digest\s*\}/u,
    /ManifestWorkNode<CycleId>\s*\{\s*kind:\s*work,\s*issue_id:\s*WorkIssueId,\s*parent_issue_id:\s*CycleId,[\s\S]*?approved_work_group_id:\s*WorkGroupId,[\s\S]*?directive_ids:\s*\[DirectiveId,\s*\.\.\.DirectiveId\[\]\]\s*\}/u,
    /ManifestVerifyNode<CycleId>\s*\{\s*kind:\s*verify,\s*issue_id:\s*VerifyIssueId,\s*parent_issue_id:\s*CycleId,[\s\S]*?directive_ids:\s*\[VerificationDirectiveId,\s*\.\.\.VerificationDirectiveId\[\]\]\s*\}/u,
    /OrderedManifestWorkNodes<CycleId>\s*=\s*branded\s*\[ManifestWorkNode<CycleId>,\s*\.\.\.ManifestWorkNode<CycleId>\[\]\]\s*with distinct issue_id and approved_work_group_id/u,
    /IssueIdsOf<Works>\s*=\s*exact ordered projection of every Works\[\]\.issue_id/u,
    /PlanGraphManifest<Basis:\s*SealedCycleBasis>\s*\{\s*cycle_id:\s*typeof Basis\.specification\.cycle_id,\s*approval_record_id:\s*typeof Basis\.approval_record\.record_id,\s*specification_seal_digest:\s*typeof Basis\.specification\.specification_seal_digest,\s*plan_issue_id:\s*typeof Basis\.specification\.plan_issue_id,\s*plan:\s*ManifestPlanNode<\s*typeof cycle_id,\s*typeof plan_issue_id,\s*typeof Basis\.specification\.plan_completion_record_id,\s*typeof Basis\.specification\.plan_invalidation_record_id\s*>,\s*ordered_work_nodes:\s*OrderedManifestWorkNodes<typeof cycle_id>,\s*ordered_work_issue_ids:\s*IssueIdsOf<ordered_work_nodes>,\s*verify_node:\s*ManifestVerifyNode<typeof cycle_id>,\s*verify_issue_id:\s*typeof verify_node\.issue_id,\s*relations:\s*ExactManifestRelations<ordered_work_nodes,\s*typeof verify_issue_id>\s*\}/u,
    /PlanStageDocument<Basis:\s*SealedCycleBasis>[\s\S]*?issue_id:\s*typeof Basis\.specification\.plan_issue_id,[\s\S]*?parent_issue_id:\s*typeof Basis\.specification\.cycle_id,[\s\S]*?completion_record_id:\s*typeof Basis\.specification\.plan_completion_record_id,[\s\S]*?invalidation_record_id:\s*typeof Basis\.specification\.plan_invalidation_record_id[\s\S]*?StageProjection<\s*typeof parent_issue_id,\s*typeof issue_id,\s*typeof completion_record_id,\s*typeof invalidation_record_id,\s*CompletedPlanCompletion<Basis>/u,
    /StageTypedCompletionRecord<CycleId,\s*StageId,\s*RecordId,\s*C>[\s\S]*?record_id:\s*RecordId,\s*issue_id:\s*StageId,\s*cycle_id:\s*CycleId,\s*stage_id:\s*StageId,\s*basis_status:\s*In Progress,\s*completion:\s*C/u,
    /StageTypedInvalidationRecord<CycleId,\s*StageId,\s*RecordId,\s*SourceStatus,\s*I>[\s\S]*?record_id:\s*RecordId,\s*issue_id:\s*StageId,\s*cycle_id:\s*CycleId,\s*stage_id:\s*StageId,\s*basis_status:\s*SourceStatus/u,
  ];
  const sealedCycleBasis = /SealedCycleBasis\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "";
  const sealedCycleAnchorFields = [
    "record_id: typeof specification.approval_record_id",
    "issue_id: typeof specification.cycle_id",
    "cycle_id: typeof specification.cycle_id",
    "identity_derivation_version: typeof specification.identity_derivation_version",
    "predecessor_cycle_issue_id: typeof specification.predecessor_cycle_issue_id",
    "predecessor_terminal_record_id: typeof specification.predecessor_terminal_record_id",
    "plan_issue_id: typeof specification.plan_issue_id",
    "plan_completion_record_id: typeof specification.plan_completion_record_id",
    "plan_invalidation_record_id: typeof specification.plan_invalidation_record_id",
    "cycle_completion_record_id: typeof specification.cycle_completion_record_id",
    "cycle_invalidation_record_id: typeof specification.cycle_invalidation_record_id",
    "delivery_completion_record_id: typeof specification.delivery_completion_record_id",
    "delivery_invalidation_record_id: typeof specification.delivery_invalidation_record_id",
    "specification_seal_digest: typeof specification.specification_seal_digest",
    "workspace_base_revision: typeof specification.workspace_base_revision",
  ];
  const cycleApprovalRecord = /CycleApprovalRecord\s*=\s*TaskIssueRecordCommon\s*&\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "";
  const cycleSpecification = /CycleSpecification\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "";
  const sharedCycleAnchorFields = [
    "predecessor_cycle_issue_id", "predecessor_terminal_record_id",
    "plan_issue_id", "plan_completion_record_id", "plan_invalidation_record_id",
    "cycle_completion_record_id", "cycle_invalidation_record_id",
    "delivery_completion_record_id", "delivery_invalidation_record_id",
    "identity_derivation_version", "workspace_base_revision",
  ];
  const cycleSpecificationAnchorFields = ["approval_record_id", ...sharedCycleAnchorFields];
  if (sharedCycleAnchorFields.some((field) => !cycleApprovalRecord.includes(field)) ||
      cycleSpecificationAnchorFields.some((field) => !cycleSpecification.includes(field))) {
    violations.push({
      code: "incomplete_cycle_anchor_contract",
      file: "contracts.md",
      target: "CycleApprovalRecord|CycleSpecification",
    });
  }
  const planGraphManifestBody = /PlanGraphManifest<Basis:\s*SealedCycleBasis>\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "";
  if (manifestNodeContracts.some((pattern) => !pattern.test(contracts)) ||
      sealedCycleAnchorFields.some((field) => !sealedCycleBasis.includes(field)) ||
      /\bnodes\s*:/u.test(planGraphManifestBody)) {
    violations.push({
      code: "invalid_exact_manifest_node_contract",
      file: "contracts.md",
      target: "PlanGraphManifest",
    });
  }

  const cycleInvalidationContract = /CycleInvalidationRecord\s*=\s*CycleInvalidationRecordCommon\s*&\s*\(([\s\S]*?)\n\)/u.exec(contracts)?.[1] ?? "";
  const invalidTerminalPolicies = [
    /invalidation_kind:\s*invalid_terminal,\s*terminal_status:\s*Succeeded\s*\|\s*Rejected\s*\|\s*Failed\s*\|\s*Canceled,\s*successor_policy:\s*allowed,\s*successor_evidence:\s*InvalidTerminalSuccessorEvidence/u,
    /invalidation_kind:\s*invalid_terminal,\s*terminal_status:\s*Succeeded\s*\|\s*Rejected\s*\|\s*Failed\s*\|\s*Canceled,\s*successor_policy:\s*permanently_quarantined,\s*successor_evidence:\s*null/u,
  ];
  const quarantinedInvalidationKinds = [
    "invalid_status_transition",
    "invalid_record_basis",
    "unresolvable_record_slot",
    "partial_graph_materialization",
    "authoritative_record_lost",
    "sealed_fact_mutated",
  ];
  const quarantinedCycleInvalidation = /invalidation_kind:\s*invalid_status_transition([\s\S]*?)terminal_status:\s*Failed,\s*successor_policy:\s*permanently_quarantined,\s*successor_evidence:\s*null/u.exec(cycleInvalidationContract)?.[0] ?? "";
  const cycleInvalidationEvidence = /CycleInvalidationRecordCommon\s*=\s*TaskIssueRecordCommon\s*&\s*\{[\s\S]*?observed_execution_graph_digest,\s*offending_resources:\s*\[CycleInvalidationResourceEvidence,\s*\.\.\.CycleInvalidationResourceEvidence\[\]\],[\s\S]*?\}/u;
  const cycleInvalidationEvidenceKinds = [
    "present_digest_mismatch",
    "present_relation_mismatch",
    "unexpected_resource",
    "missing_manifest_resource",
    "authoritative_body_lost",
  ];
  if (invalidTerminalPolicies.some((pattern) => !pattern.test(cycleInvalidationContract)) ||
      quarantinedInvalidationKinds.some((kind) => !quarantinedCycleInvalidation.includes(kind)) ||
      !cycleInvalidationEvidence.test(contracts) ||
      cycleInvalidationEvidenceKinds.some((kind) =>
        !new RegExp(`evidence_kind:\\s*${kind}\\b`, "u").test(contracts))) {
    violations.push({
      code: "invalid_cycle_invalidation_policy_contract",
      file: "contracts.md",
      target: "CycleInvalidationRecord",
    });
  }

  const discriminatedCycleCompletions = [
    /DraftFailedCycleCompletion\s*=\s*DraftTerminalCycleEvidence\s*&\s*\{\s*outcome:\s*failed\s*\}/u,
    /DraftCanceledCycleCompletion\s*=\s*DraftTerminalCycleEvidence\s*&\s*\{\s*outcome:\s*canceled\s*\}/u,
    /InProgressFailedCycleCompletion\s*=\s*InProgressTerminalCycleEvidence\s*&\s*\{\s*outcome:\s*failed\s*\}/u,
    /InProgressCanceledCycleCompletion\s*=\s*InProgressTerminalCycleEvidence\s*&\s*\{\s*outcome:\s*canceled\s*\}/u,
  ];
  if (discriminatedCycleCompletions.some((pattern) => !pattern.test(contracts)) ||
      /DraftFailedCycleCompletion\s*\|\s*DraftCanceledCycleCompletion\s*\{/u.test(contracts)) {
    violations.push({
      code: "non_discriminated_cycle_completion_contract",
      file: "contracts.md",
      target: "FailedCycleCompletion|CanceledCycleCompletion",
    });
  }

  const rootTurnOutcome = /RootTurnOutcome\s*=\s*RootTurnOutcomeCommon\s*&\s*\(([\s\S]*?)\n\)/u.exec(contracts)?.[1] ?? "";
  const rootTurnVariants = [
    /outcome:\s*quiescent,[\s\S]*?selected_route:\s*WF-ROUTE-001\s*\|\s*WF-ROUTE-002\s*\|\s*WF-ROUTE-007\s*\|\s*WF-ROUTE-008/u,
    /outcome:\s*quiescent,\s*selected_route:\s*WF-ROUTE-005,\s*observed_effect:\s*none/u,
    /outcome:\s*draft_closed,\s*selected_route:\s*WF-ROUTE-002,[\s\S]*?closure_status:\s*Failed\s*\|\s*Canceled/u,
    /outcome:\s*acceptance_closed,\s*selected_route:\s*WF-ROUTE-007,[\s\S]*?closure_status:\s*Rejected\s*\|\s*Canceled/u,
    /outcome:\s*no_effect,[\s\S]*?effect_may_have_occurred:\s*false/u,
    /outcome:\s*effect_unknown,[\s\S]*?selected_route:\s*WF-ROUTE-001\s*\|\s*WF-ROUTE-002\s*\|\s*WF-ROUTE-007\s*\|\s*WF-ROUTE-008,[\s\S]*?effect_may_have_occurred:\s*true/u,
  ];
  if (!/RootTurnOutcomeCommon\s*\{[\s\S]*?input_task_digest[\s\S]*?\}/u.test(contracts) ||
      rootTurnVariants.some((pattern) => !pattern.test(rootTurnOutcome))) {
    violations.push({
      code: "missing_root_turn_outcome_contract",
      file: "contracts.md",
      target: "RootTurnOutcome",
    });
  }

  const conductorActionRequest = /ConductorActionRequest\s*=\s*ConductorActionRequestCommon\s*&\s*\(([\s\S]*?)\n\)/u.exec(contracts)?.[1] ?? "";
  const conductorActionResult = /ConductorActionResult\s*=\s*ConductorActionResultCommon\s*&\s*\(([\s\S]*?)\n\)/u.exec(contracts)?.[1] ?? "";
  const conductorActionRequestContracts = [
    /action:\s*family_guard,\s*selected_route:\s*WF-ROUTE-009/u,
    /action:\s*delivery_finalizer,\s*selected_route:\s*WF-ROUTE-010,[\s\S]*?routing:[\s\S]*?disposition:\s*delivery_finalizer,\s*selected_route:\s*WF-ROUTE-010/u,
    /action:\s*delivery_finalizer,\s*selected_route:\s*WF-ROUTE-012,[\s\S]*?routing:[\s\S]*?disposition:\s*delivery_finalizer,\s*selected_route:\s*WF-ROUTE-012/u,
    /action:\s*cleanup,\s*selected_route:\s*WF-ROUTE-013/u,
  ];
  const deliveryActionRequests = /action:\s*delivery_finalizer([\s\S]*?)action:\s*cleanup/u.exec(conductorActionRequest)?.[1] ?? "";
  const conductorActionResultContracts = [
    /outcome:\s*family_invalidated/u,
    /selected_route:\s*WF-ROUTE-010,\s*outcome:\s*delivery_completed\s*\|\s*delivery_invalidated\s*\|\s*root_projected/u,
    /selected_route:\s*WF-ROUTE-012,\s*outcome:\s*delivery_invalidated/u,
    /outcome:\s*cleaned,\s*conductor_exit:\s*required/u,
  ];
  if (conductorActionRequestContracts.some((pattern) => !pattern.test(conductorActionRequest)) ||
      [...deliveryActionRequests.matchAll(/remote_ref:\s*RemoteRefSnapshot/gu)].length !== 2 ||
      conductorActionResultContracts.some((pattern) => !pattern.test(conductorActionResult))) {
    violations.push({
      code: "missing_conductor_action_contract",
      file: "contracts.md",
      target: "ConductorActionRequest|ConductorActionResult",
    });
  }

  const cycleBasisContracts = [
    /UnapprovedCycleBasis\s*\{\s*specification:\s*CycleSpecification,\s*approval_record:\s*null\s*\}/u,
    /SealedCycleBasis\s*\{\s*specification:\s*CycleSpecification\s*&\s*\{\s*specification_seal_digest:\s*digest\s*\},\s*approval_record:\s*CycleApprovalRecord\s*&\s*\{[\s\S]*?specification_seal_digest:\s*typeof specification\.specification_seal_digest,\s*workspace_base_revision:\s*typeof specification\.workspace_base_revision\s*\}\s*\}/u,
    /CycleTypedCompletionRecord<Basis,\s*Record>\s*=\s*Record\s*&\s*\{\s*record_id:\s*typeof Basis\.specification\.cycle_completion_record_id,\s*issue_id:\s*typeof Basis\.specification\.cycle_id,\s*cycle_id:\s*typeof Basis\.specification\.cycle_id\s*\}/u,
    /CycleTypedInvalidationRecord<Basis,\s*Record>\s*=\s*Record\s*&\s*\{\s*record_id:\s*typeof Basis\.specification\.cycle_invalidation_record_id,\s*issue_id:\s*typeof Basis\.specification\.cycle_id,\s*cycle_id:\s*typeof Basis\.specification\.cycle_id\s*\}/u,
    /CycleTerminalSelection<Basis,\s*SelectedCompletion,\s*Invalidation>\s*=\s*TerminalRecordSelection<\s*CycleTypedCompletionRecord<Basis,\s*SelectedCompletion>,\s*CycleAnyCompletionRecord<Basis>,\s*CycleTypedInvalidationRecord<Basis,\s*Invalidation>\s*>/u,
  ];
  const terminalSelectionContract = /TerminalRecordSelection<SelectedCompletion,\s*SupersededCompletion,\s*Invalidation>\s*=([\s\S]*?)\n\nUnapprovedCycleBasis/u.exec(contracts)?.[1] ?? "";
  const terminalSelectionContracts = [
    /NoTerminalRecordSelection\s*\{\s*selection:\s*none,\s*completion_record:\s*null,\s*invalidation_record:\s*null,\s*terminal_record:\s*null\s*\}/u,
    /selection:\s*completion,\s*completion_record:\s*SelectedCompletion,\s*invalidation_record:\s*null,\s*terminal_record:\s*SelectedCompletion/u,
    /selection:\s*invalidation,\s*completion_record:\s*SupersededCompletion\s*\|\s*InvalidCompletionRecordObservation\s*\|\s*null,\s*invalidation_record:\s*Invalidation,\s*terminal_record:\s*Invalidation/u,
  ];
  const externalTerminalObservationContracts = [
    /TerminalRecordStatusMismatch<SourceStatus,\s*TerminalStatus>\s*\{[\s\S]*?expected_source_status:\s*SourceStatus,[\s\S]*?record_terminal_status:\s*TerminalStatus/u,
    /CycleTerminalRecordStatusMismatch\s*=\s*TerminalRecordStatusMismatch<\s*Draft\s*\|\s*In Progress\s*\|\s*Awaiting Acceptance,\s*Succeeded\s*\|\s*Rejected\s*\|\s*Failed\s*\|\s*Canceled\s*>/u,
    /StageTerminalRecordStatusMismatch\s*=\s*TerminalRecordStatusMismatch<\s*Todo\s*\|\s*In Progress,\s*Done\s*\|\s*Failed\s*\|\s*Canceled\s*>/u,
    /SelectedTerminalRecordMismatch<Selection,\s*Mismatch>\s*=\s*Mismatch\s*&\s*\{[\s\S]*?record_id:\s*typeof Selection\.terminal_record\.record_id,[\s\S]*?expected_source_status:\s*typeof Selection\.terminal_record\.basis_status,[\s\S]*?record_terminal_status:\s*terminal status derived from Selection\.terminal_record/u,
    /ExternalTerminalRecordSetObservation<CompletionObservation>\s*\{\s*terminal_selection:\s*NoTerminalRecordSelection,\s*completion_record_observation:\s*CompletionObservation\s*\|\s*null,\s*invalidation_record_observation:\s*null\s*\}/u,
    /ExternalTerminalCycleCase<Basis,\s*Phase>\s*=\s*ExternalTerminalRecordSetObservation<\s*InvalidCompletionRecordObservation\s*&\s*\{[\s\S]*?record_id:\s*typeof Basis\.specification\.cycle_completion_record_id,[\s\S]*?expected_record_kind:\s*cycle_completion[\s\S]*?status:\s*Succeeded\s*\|\s*Rejected\s*\|\s*Failed\s*\|\s*Canceled,[\s\S]*?projection_state:\s*external_terminal_unrecorded,\s*last_valid_phase:\s*Phase/u,
    /ExternalTerminalCycleObservation\s*=\s*\(UnapprovedCycleBasis\s*&\s*ExternalTerminalCycleCase<UnapprovedCycleBasis,\s*draft>\)\s*\|\s*\(SealedCycleBasis\s*&\s*ExternalTerminalCycleCase<\s*SealedCycleBasis,\s*draft\s*\|\s*in_progress\s*\|\s*awaiting_acceptance\s*>\)/u,
    /CycleObservation\s*=\s*CycleDocument\s*\|\s*CycleTerminalMismatchObservation\s*\|\s*ExternalTerminalCycleObservation\s*\|\s*InvalidCycleCompletionObservation\s*\|\s*InvalidCycleBasisObservation\s*\|\s*InvalidCycleDocument/u,
    /cycle_document:\s*CycleObservation/u,
    /ExternalTerminalStageObservation\s*=\s*StageDocumentCommon\s*&\s*\{[\s\S]*?status:\s*Done\s*\|\s*Failed\s*\|\s*Canceled,[\s\S]*?terminal_selection:\s*NoTerminalRecordSelection,[\s\S]*?record_id:\s*typeof completion_record_id,[\s\S]*?expected_record_kind:\s*stage_completion[\s\S]*?invalidation_record_observation:\s*null/u,
    /StageObservation\s*=\s*StageDocument\s*\|\s*ExternalTerminalStageObservation/u,
    /plan:\s*StageObservation\s*\|\s*null,\s*works:\s*StageObservation\[\],\s*verify:\s*StageObservation\s*\|\s*null/u,
  ];
  if (!terminalSelectionContracts[0].test(contracts) ||
      terminalSelectionContracts.slice(1).some((pattern) => !pattern.test(terminalSelectionContract))) {
    violations.push({
      code: "invalid_terminal_record_selection_contract",
      file: "contracts.md",
      target: "TerminalRecordSelection",
    });
  }
  if (externalTerminalObservationContracts.some((pattern) => !pattern.test(contracts)) ||
      /ExternalTerminalRecordObservation/u.test(contracts)) {
    violations.push({
      code: "unconstructible_external_terminal_route_input",
      file: "contracts.md",
      target: "ExternalTerminalCycleObservation|ExternalTerminalStageObservation",
    });
  }
  const cycleObservationContracts = [
    /CycleAnchorField\s*=\s*record_id\s*\|\s*issue_id\s*\|\s*cycle_id[\s\S]*?specification_seal_digest\s*\|\s*workspace_base_revision/u,
    /InvalidCycleBasisObservation\s*\{\s*specification:\s*CycleSpecification,\s*revision,\s*observed_cycle_document_digest,[\s\S]*?projection_state:\s*invalid_cycle_basis,[\s\S]*?basis_failure:\s*invalid_approval_record\s*\|\s*approval_basis_mismatch\s*\|\s*sealed_specification_mismatch,[\s\S]*?approval_record_observation:\s*InvalidTaskIssueRecord\s*\|\s*CycleApprovalBasisMismatch\s*\}/u,
    /InvalidCycleCompletionCase<Phase>\s*\{\s*status:\s*Draft\s*\|\s*In Progress\s*\|\s*Awaiting Acceptance,[\s\S]*?projection_state:\s*invalid_completion_record,[\s\S]*?terminal_selection:\s*NoTerminalRecordSelection,[\s\S]*?expected_record_kind:\s*cycle_completion[\s\S]*?invalidation_record_observation:\s*null\s*\}/u,
    /CycleTerminalProjectionCase<Source,\s*Target,\s*Selection>\s*\{[\s\S]*?terminal_selection:\s*Selection\s*\}\s*branded with terminal_selection\.terminal_record\.basis_status == Source/u,
    /InvalidCycleCompletionObservation\s*=\s*\(UnapprovedCycleBasis\s*&\s*InvalidCycleCompletionCase<draft>\)\s*\|\s*\(SealedCycleBasis\s*&\s*InvalidCycleCompletionCase<\s*draft\s*\|\s*in_progress\s*\|\s*awaiting_acceptance\s*>\)/u,
  ];
  const cycleSourceMismatchContract = /CycleTerminalSourceMismatchCase<Basis,\s*Status>\s*\{([^}]*)\}\s*branded with status != terminal_record_observation\.expected_source_status/u
    .exec(contracts)?.[1] ?? "";
  const cycleStatusMismatchContract = /CycleTerminalStatusMismatchCase<Basis,\s*Status>\s*\{([^}]*)\}\s*branded with status != terminal_record_observation\.record_terminal_status/u
    .exec(contracts)?.[1] ?? "";
  if (cycleObservationContracts.some((pattern) => !pattern.test(contracts)) ||
      !/projection_state:\s*terminal_source_mismatch/u.test(cycleSourceMismatchContract) ||
      !/terminal_record_observation:\s*SelectedTerminalRecordMismatch<[\s\S]*?CycleTerminalRecordStatusMismatch/u.test(cycleSourceMismatchContract) ||
      !/projection_state:\s*terminal_status_mismatch/u.test(cycleStatusMismatchContract) ||
      !/terminal_record_observation:\s*SelectedTerminalRecordMismatch<[\s\S]*?CycleTerminalRecordStatusMismatch/u.test(cycleStatusMismatchContract)) {
    violations.push({
      code: "invalid_cycle_observation_contract",
      file: "contracts.md",
      target: "CycleObservation",
    });
  }
  const pendingCycleVariants = [
    /CycleTerminalProjectionCase<Draft,\s*Failed,/u,
    /CycleTerminalProjectionCase<Draft,\s*Canceled,/u,
    /CycleTerminalProjectionCase<In Progress,\s*Failed,/u,
    /CycleTerminalProjectionCase<In Progress,\s*Canceled,/u,
    /CycleTerminalProjectionCase<Awaiting Acceptance,\s*Succeeded,\s*CycleTerminalSelection<SealedCycleBasis,\s*AcceptedCycleCompletionRecord,\s*never>>/u,
    /CycleTerminalProjectionCase<Awaiting Acceptance,\s*Rejected,[\s\S]*?RejectedCycleCompletion/u,
    /CycleTerminalProjectionCase<Awaiting Acceptance,\s*Failed,[\s\S]*?last_valid_phase:\s*awaiting_acceptance/u,
    /CycleTerminalProjectionCase<Awaiting Acceptance,\s*Canceled,[\s\S]*?AwaitingAcceptanceCanceledCycleCompletion/u,
  ];
  const cycleDocumentBody = /CycleDocument\s*=([\s\S]*?)CycleObservation/u.exec(contracts)?.[1] ?? "";
  const terminalCycleVariants = [
    /status:\s*Succeeded,[\s\S]*?terminal_selection:\s*CycleTerminalSelection<SealedCycleBasis,\s*AcceptedCycleCompletionRecord,[\s\S]*?terminal_status:\s*Succeeded/u,
    /status:\s*Rejected,[\s\S]*?terminal_selection:\s*CycleTerminalSelection<[\s\S]*?completion:\s*RejectedCycleCompletion[\s\S]*?terminal_status:\s*Rejected/u,
    /status:\s*Failed,[\s\S]*?terminal_selection:\s*CycleTerminalSelection<[\s\S]*?completion:\s*DraftFailedCycleCompletion[\s\S]*?last_valid_phase:\s*draft/u,
    /status:\s*Failed,[\s\S]*?terminal_selection:\s*CycleTerminalSelection<[\s\S]*?completion:\s*InProgressFailedCycleCompletion[\s\S]*?terminal_status:\s*Failed/u,
    /status:\s*Canceled,[\s\S]*?terminal_selection:\s*CycleTerminalSelection<[\s\S]*?completion:\s*DraftCanceledCycleCompletion[\s\S]*?terminal_status:\s*Canceled/u,
    /status:\s*Canceled,[\s\S]*?terminal_selection:\s*CycleTerminalSelection<[\s\S]*?completion:\s*DraftCanceledCycleCompletion\s*\|\s*InProgressCanceledCycleCompletion\s*\|\s*AwaitingAcceptanceCanceledCycleCompletion/u,
  ];
  if (cycleBasisContracts.some((pattern) => !pattern.test(contracts)) ||
      pendingCycleVariants.some((pattern) => !pattern.test(contracts)) ||
      terminalCycleVariants.some((pattern) => !pattern.test(cycleDocumentBody))) {
    violations.push({
      code: "invalid_cycle_document_terminal_mapping",
      file: "contracts.md",
      target: "CycleDocument",
    });
  }

  const deliveryEvidenceKinds = [
    "convergence_mismatch",
    "completion_slot_conflict",
    "delivery_effect_conflict",
    "root_done_before_completion",
  ];
  const deliveryMismatchEvidence = /DeliveryInvalidationEvidence\s*=\s*\{\s*kind:\s*convergence_mismatch,\s*first_round:\s*DeliveryObservationRound,\s*second_round:\s*DeliveryObservationRound,\s*observation_order:\s*linear\s*->\s*git\s*->\s*delivery\s*->\s*linear\s*->\s*git\s*->\s*delivery,\s*mismatched_fields\[\],\s*first_basis_digest,\s*second_basis_digest\s*\}\s*\|/u;
  const deliveryInvalidation = /DeliveryInvalidationRecord\s*=\s*TaskIssueRecordCommon\s*&\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "";
  if (!/DeliveryInvalidationEvidence\s*=\s*\{/u.test(contracts) ||
      !deliveryMismatchEvidence.test(contracts) ||
      deliveryEvidenceKinds.some((kind) => !new RegExp(`kind:\\s*${kind}\\b`, "u").test(contracts)) ||
      !/invalidation_evidence:\s*DeliveryInvalidationEvidence\b/u.test(deliveryInvalidation) ||
      /convergence_proof:\s*(?:Acceptance|Delivery)ConvergenceProof\b/u.test(deliveryInvalidation)) {
    violations.push({
      code: "invalid_delivery_invalidation_evidence_contract",
      file: "contracts.md",
      target: "DeliveryInvalidationRecord",
    });
  }

  if (!/verify_directives:\s*\[VerificationDirective,\s*\.\.\.VerificationDirective\[\]\]/u.test(contracts)) {
    violations.push({
      code: "empty_verify_directives_contract",
      file: "contracts.md",
      target: "CycleSpecification.verify_directives",
    });
  }
  const planResult = /PlanResult\s*=\s*RoleResultCommon\s*&\s*\{\s*plan_issue_id\s*\}\s*&\s*\(([\s\S]*?)\n\)/u
    .exec(contracts)?.[1] ?? "";
  if (/\bverify_directive_ids\b/u.test(planResult)) {
    violations.push({
      code: "plan_selects_verify_directives",
      file: "contracts.md",
      target: "PlanResult",
    });
  }

  const acceptanceProof = /AcceptanceConvergenceProof\s*\{\s*proof_scope:\s*acceptance,\s*first_round:\s*AcceptanceObservationRound,\s*second_round:\s*AcceptanceObservationRound,\s*observation_order:\s*linear\s*->\s*git\s*->\s*linear\s*->\s*git,\s*stable_decision_basis_digest\s*\}/u;
  const deliveryProof = /DeliveryConvergenceProof\s*\{\s*proof_scope:\s*delivery,\s*first_round:\s*DeliveryObservationRound,\s*second_round:\s*DeliveryObservationRound,\s*observation_order:\s*linear\s*->\s*git\s*->\s*delivery\s*->\s*linear\s*->\s*git\s*->\s*delivery,\s*stable_decision_basis_digest\s*\}/u;
  const acceptanceProofUses = [...contracts.matchAll(/acceptance_convergence_proof:\s*AcceptanceConvergenceProof\b/gu)].length;
  if (!acceptanceProof.test(contracts) || !deliveryProof.test(contracts) ||
      acceptanceProofUses !== 3 ||
      !/convergence_proof:\s*DeliveryConvergenceProof\b/u.test(contracts) ||
      /\bCrossProviderConvergenceProof\b/u.test(contracts)) {
    violations.push({
      code: "invalid_scope_specific_convergence_contract",
      file: "contracts.md",
      target: "AcceptanceConvergenceProof|DeliveryConvergenceProof",
    });
  }

  const stageDocumentMappings = [
    /PlanStageDocument<Basis:\s*SealedCycleBasis>\s*=\s*StageDocumentCommon[\s\S]*?StageProjection<\s*typeof parent_issue_id,\s*typeof issue_id,\s*typeof completion_record_id,\s*typeof invalidation_record_id,\s*CompletedPlanCompletion<Basis>,\s*FailedPlanCompletion,\s*CanceledPlanCompletion\s*>/u,
    /WorkStageDocument\s*=\s*StageDocumentCommon\s*&\s*\{\s*kind:\s*work\s*\}\s*&\s*StageProjection<\s*typeof parent_issue_id,\s*typeof issue_id,\s*typeof completion_record_id,\s*typeof invalidation_record_id,\s*CompletedWorkCompletion,\s*FailedWorkCompletion,\s*CanceledWorkCompletion\s*>/u,
    /VerifyStageDocument\s*=\s*StageDocumentCommon\s*&\s*\{\s*kind:\s*verify\s*\}\s*&\s*StageProjection<\s*typeof parent_issue_id,\s*typeof issue_id,\s*typeof completion_record_id,\s*typeof invalidation_record_id,\s*PassedVerifyCompletion,\s*FailedVerifyCompletion,\s*CanceledVerifyCompletion\s*>/u,
    /StageDocument\s*=\s*PlanStageDocument<SealedCycleBasis>\s*\|\s*WorkStageDocument\s*\|\s*VerifyStageDocument/u,
  ];
  const stageRecordSourceBindings = [
    /StageTypedCompletionRecord<CycleId,\s*StageId,\s*RecordId,\s*C>\s*=\s*StageCompletionRecord\s*&\s*\{\s*record_id:\s*RecordId,\s*issue_id:\s*StageId,\s*cycle_id:\s*CycleId,\s*stage_id:\s*StageId,\s*basis_status:\s*In Progress,\s*completion:\s*C\s*\}/u,
    /StageTypedInvalidationRecord<CycleId,\s*StageId,\s*RecordId,\s*SourceStatus,\s*I>\s*=\s*StageInvalidationRecord\s*&\s*I\s*&\s*\{\s*record_id:\s*RecordId,\s*issue_id:\s*StageId,\s*cycle_id:\s*CycleId,\s*stage_id:\s*StageId,\s*basis_status:\s*SourceStatus\s*\}/u,
    /StageAnyInvalidationRecord<CycleId,\s*StageId,\s*RecordId>\s*=\s*StageTypedInvalidationRecord<\s*CycleId,\s*StageId,\s*RecordId,\s*Todo\s*\|\s*In Progress,\s*StageInvalidationRecord\s*>/u,
  ];
  const stageProjectionContract = /StageProjection<CycleId,\s*StageId,\s*CompletionRecordId,\s*InvalidationRecordId,\s*DoneCompletion,\s*FailedCompletion,\s*CanceledCompletion>\s*=([\s\S]*?)StageExpectedIdentity/u.exec(contracts)?.[1] ?? "";
  const stageCompletionPending = /StageCompletionProjectionPending<CycleId,[\s\S]*?status:\s*In Progress,[\s\S]*?StageTypedCompletionRecord<CycleId,\s*StageId,\s*CompletionRecordId,[\s\S]*?never\s*>/u;
  const stageInvalidationPending = /StageInvalidationProjectionPending<SourceStatus,[\s\S]*?status:\s*SourceStatus,[\s\S]*?StageTypedInvalidationRecord<\s*CycleId,\s*StageId,\s*InvalidationRecordId,\s*SourceStatus,[\s\S]*?terminal_status:\s*Failed/u;
  const stageProjectionVariants = [
    /status:\s*Todo\s*\|\s*In Progress,\s*projection_state:\s*none,\s*terminal_selection:\s*NoTerminalRecordSelection/u,
    /status:\s*Done,\s*projection_state:\s*none,\s*terminal_selection:\s*TerminalRecordSelection<\s*StageTypedCompletionRecord<CycleId,\s*StageId,\s*CompletionRecordId,\s*DoneCompletion>,\s*StageAnyCompletionRecord<[\s\S]*?StageTypedInvalidationRecord<CycleId,\s*StageId,\s*InvalidationRecordId,[\s\S]*?terminal_status:\s*Done/u,
    /status:\s*Failed,\s*projection_state:\s*none,\s*terminal_selection:\s*TerminalRecordSelection<\s*StageTypedCompletionRecord<CycleId,\s*StageId,\s*CompletionRecordId,\s*FailedCompletion>,\s*StageAnyCompletionRecord<[\s\S]*?StageTypedInvalidationRecord<CycleId,\s*StageId,\s*InvalidationRecordId,[\s\S]*?terminal_status:\s*Failed/u,
    /status:\s*Canceled,\s*projection_state:\s*none,\s*terminal_selection:\s*TerminalRecordSelection<\s*StageTypedCompletionRecord<CycleId,\s*StageId,\s*CompletionRecordId,[\s\S]*?CanceledCompletion>,\s*StageAnyCompletionRecord<[\s\S]*?StageTypedInvalidationRecord<CycleId,\s*StageId,\s*InvalidationRecordId,[\s\S]*?terminal_status:\s*Canceled/u,
  ];
  const stagePendingInvalidationKinds = [
    "invalid_record_basis",
    "unresolvable_record_slot",
    "authoritative_record_lost",
    "sealed_fact_mutated",
    "invalid_status_transition",
  ];
  const invalidStageObservationContracts = [
    /StageExpectedIdentity\s*\{\s*cycle_id,\s*issue_id,\s*parent_issue_id:\s*typeof cycle_id,\s*kind:\s*plan\s*\|\s*work\s*\|\s*verify,\s*completion_record_id,\s*invalidation_record_id,\s*instruction_digest\s*\}/u,
    /InvalidStageFactObservation\s*\{\s*expected:\s*StageExpectedIdentity,[\s\S]*?projection_state:\s*invalid_stage_fact,[\s\S]*?terminal_record_observation:\s*InvalidTaskIssueRecord\s*\|\s*null\s*\}/u,
    /InvalidStageCompletionObservation\s*\{\s*expected:\s*StageExpectedIdentity,[\s\S]*?observed_status:\s*In Progress,[\s\S]*?projection_state:\s*invalid_completion_record,\s*terminal_selection:\s*NoTerminalRecordSelection,[\s\S]*?record_id:\s*typeof expected\.completion_record_id,[\s\S]*?expected_record_kind:\s*stage_completion[\s\S]*?invalidation_record_observation:\s*null\s*\}/u,
    /InvalidStageObservation\s*=\s*InvalidStageFactObservation\s*\|\s*InvalidStageCompletionObservation/u,
    /StageObservation\s*=\s*StageDocument\s*\|\s*ExternalTerminalStageObservation\s*\|\s*InvalidStageObservation/u,
    /StageInvalidationProjectionPending<\s*Todo,[\s\S]*?StageInvalidationProjectionPending<\s*In Progress,/u,
  ];
  const stageSourceMismatchContract = /StageTerminalSourceMismatch<CycleId,[\s\S]*?=\s*\{([^}]*)\}\s*branded with status != terminal_record_observation\.expected_source_status/u
    .exec(contracts)?.[1] ?? "";
  const stageStatusMismatchContract = /StageTerminalStatusMismatch<CycleId,[\s\S]*?=\s*\{([^}]*)\}\s*branded with status != terminal_record_observation\.record_terminal_status/u
    .exec(contracts)?.[1] ?? "";
  const stageInvalidationContract = /StageInvalidationRecord\s*=([\s\S]*?)AcceptedCycleCompletionRecord/u.exec(contracts)?.[1] ?? "";
  if (stageDocumentMappings.some((pattern) => !pattern.test(contracts)) ||
      stageRecordSourceBindings.some((pattern) => !pattern.test(contracts)) ||
      stageProjectionVariants.some((pattern) => !pattern.test(stageProjectionContract)) ||
      invalidStageObservationContracts.some((pattern) => !pattern.test(contracts)) ||
      !/projection_state:\s*terminal_source_mismatch/u.test(stageSourceMismatchContract) ||
      !/terminal_record_observation:\s*SelectedTerminalRecordMismatch<[\s\S]*?StageTerminalRecordStatusMismatch/u.test(stageSourceMismatchContract) ||
      !/projection_state:\s*terminal_status_mismatch/u.test(stageStatusMismatchContract) ||
      !/terminal_record_observation:\s*SelectedTerminalRecordMismatch<[\s\S]*?StageTerminalRecordStatusMismatch/u.test(stageStatusMismatchContract) ||
      !stageCompletionPending.test(contracts) ||
      !stageInvalidationPending.test(contracts) ||
      stagePendingInvalidationKinds.some((kind) => !contracts.includes(kind)) ||
      !/invalidation_kind:\s*invalid_terminal,\s*terminal_status:\s*Done\s*\|\s*Failed\s*\|\s*Canceled/u.test(stageInvalidationContract) ||
      stagePendingInvalidationKinds.some((kind) => !stageInvalidationContract.includes(kind))) {
    violations.push({
      code: "invalid_stage_document_terminal_mapping",
      file: "contracts.md",
      target: "StageDocument",
    });
  }

  const familyInvalidationContract = /RootFamilyInvalidationRecord\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "";
  const familyInvalidationIdentity = rows.get("RI-ID-005")?.row["Deterministic basis"] ?? "";
  if (!/identity_derivation_version/u.test(familyInvalidationContract) ||
      !/basis_issue_revision,\s*basis_status,\s*basis_document_digest/u.test(familyInvalidationContract) ||
      architectureRuleValue(familyInvalidationIdentity) !== "Root ID, record kind, derivation version") {
    violations.push({
      code: "invalid_root_family_invalidation_identity",
      file: "contracts.md",
      target: "RootFamilyInvalidationRecord",
    });
  }

  const failureThreeWrite = architectureRuleValue(rows.get("WF-FAIL-003")?.row["Required write"] ?? "");
  const failureFifteenWrite = architectureRuleValue(rows.get("WF-FAIL-015")?.row["Required write"] ?? "");
  if (!failureThreeWrite.includes("unresolvable_record_slot Stage invalidation") ||
      !failureThreeWrite.includes("unresolvable_record_slot Cycle invalidation") ||
      !failureFifteenWrite.includes("sealed_fact_mutated") ||
      !/\bunresolvable_record_slot\b/u.test(stageInvalidationContract) ||
      !/\bsealed_fact_mutated\b/u.test(stageInvalidationContract) ||
      !quarantinedCycleInvalidation.includes("unresolvable_record_slot") ||
      !quarantinedCycleInvalidation.includes("sealed_fact_mutated")) {
    violations.push({
      code: "incomplete_cycle_invalidation_reason_mapping",
      file: "contracts.md",
      target: "WF-FAIL-003|WF-FAIL-015",
    });
  }

  const performerDocument = sources.get("performer.md") ?? "";
  if (/excluded from every serialization/u.test(contractsDocument) ||
      !/same live provider thread transport/u.test(performerDocument) ||
      !/Symphony re-injection into next user input/u.test(performerDocument) ||
      !/same live provider thread transport only/u.test(contractsDocument) ||
      !/no Symphony storage、re-injection or workflow use/u.test(contractsDocument)) {
    violations.push({
      code: "invalid_work_continuation_transport_scope",
      file: "contracts.md",
      target: "WorkTurnResult",
    });
  }

  const roleFenceContracts = [
    /RoleRequestCommon\s*\{\s*schema_version:\s*1,\s*root_id,\s*cycle_id,\s*runtime_generation,\s*correlation_id\s*\}/u,
    /RoleResultCommon\s*\{\s*schema_version:\s*1,\s*root_id,\s*cycle_id,\s*runtime_generation,\s*correlation_id,\s*input_request_digest\s*\}/u,
    /PlanRequest\s*=\s*RoleRequestCommon\s*&/u,
    /WorkRequest\s*=\s*RoleRequestCommon\s*&/u,
    /VerifyRequest\s*=\s*RoleRequestCommon\s*&/u,
    /PlanResult\s*=\s*RoleResultCommon\s*&/u,
    /WorkResult\s*=\s*RoleResultCommon\s*&/u,
    /WorkTurnResult\s*=\s*RoleResultCommon\s*&/u,
    /VerifyResult\s*=\s*RoleResultCommon\s*&/u,
  ];
  if (roleFenceContracts.some((pattern) => !pattern.test(contracts))) {
    violations.push({
      code: "unfenced_role_envelope",
      file: "contracts.md",
      target: "Plan|Work|Verify request/result",
    });
  }

  const rootSemanticSnapshot = /RootSemanticSnapshot\s*\{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? "";
  if (!/\btask:\s*TaskSnapshot\b/u.test(rootSemanticSnapshot) ||
      !/\bgit:\s*GitSnapshot\b/u.test(rootSemanticSnapshot) ||
      !/\brouting:\s*RootRoutingDisposition\s*&\s*\{\s*disposition:\s*root_boundary\s*\}/u.test(rootSemanticSnapshot) ||
      /\bRootFactDiff\b/u.test(contracts)) {
    violations.push({
      code: "partial_root_semantic_input_contract",
      file: "contracts.md",
      target: "RootSemanticSnapshot",
    });
  }
  if (!/\btask:\s*TaskSnapshotObservation\b/u.test(taskPollResult) ||
      !/\bnotification:\s*TaskObservationEvent\s*\|\s*null\b/u.test(taskPollResult) ||
      /\btasks\s*:/u.test(taskPollResult)) {
    violations.push({ code: "invalid_single_root_poll_contract", file: "contracts.md", target: "TaskPollResult" });
  }

  const conductor = sources.get("conductor.md") ?? "";
  const delivery = sources.get("git-worktree-delivery.md") ?? "";
  if (!/terminal-Cycle `Todo` descendants are frozen/u.test(conductor) ||
      !/no dispatched open Stage/u.test(conductor) ||
      !/delivery-side cleanup proof/u.test(delivery) ||
      !/no delivery obligation/u.test(delivery) ||
      !/valid delivery completion\/invalidation record/u.test(delivery) ||
      !/delivery gap is closed for `CO-CLEAN-001`/u.test(delivery) ||
      !/global cleanup eligibility remains Conductor-owned/u.test(delivery) ||
      /all Stage statuses terminal|terminal Cycle and no dispatched open Stage/u
        .test(`${conductor}\n${delivery}`)) {
    violations.push({
      code: "invalid_terminal_cycle_cleanup_gate",
      file: "conductor.md",
      target: "CO-CLEAN-001|GD-WT-004",
    });
  }
  const cycleDiagram = [...conductor.matchAll(/```mermaid\s*\n([\s\S]*?)\n```/gu)]
    .map((match) => match[1])
    .find((body) => /Commit\s*-->\s*Verify\[/u.test(body));
  if (!cycleDiagram || !/^\s*%%\s+source-rules:.*\bCO-EXEC-007\b/mu.test(cycleDiagram)) {
    violations.push({ code: "incomplete_cycle_diagram_rule_projection", file: "conductor.md", target: "CO-EXEC-007" });
  }

  return violations.sort((left, right) =>
    left.file.localeCompare(right.file) || left.code.localeCompare(right.code) ||
    String(left.target).localeCompare(String(right.target)));
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
      if (anchor && !architectureHeadingAnchors(sources.get(resolved)).has(decodeURIComponent(anchor))) {
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
    ...inspectArchitecturePresentation(sources),
    ...inspectArchitectureRuleModel(sources, new Set(files)),
    ...inspectWorkflowRuleSemantics(sources),
    ...inspectArchitectureCrossSemantics(sources),
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
