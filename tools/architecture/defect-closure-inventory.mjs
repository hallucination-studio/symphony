import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const moduleFilePattern = /^(\d{2})-[a-z0-9-]+\.md$/u;
const terminalStatuses = new Set([
  "fixed_verified",
  "retained_and_reverified",
  "eliminated_by_hard_cut",
  "not_a_defect",
]);

function headingAnchor(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/gu, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/gu, "-");
}

function auditFindingFromHeading(taskNumber, heading) {
  const named = heading.match(/^T\d+-F(\d+):\s*(.+)$/u);
  const decimal = heading.match(/^Finding\s+\d+\.(\d+):\s*(.+)$/u);
  const simple = heading.match(/^Finding\s+(\d+):\s*(.+)$/u);
  const numbered = heading.match(/^(\d+)\.\s*(.+)$/u);
  const match = named ?? decimal ?? simple ?? numbered;
  if (!match) return undefined;
  return { findingNumber: Number(match[1]), title: match[2].trim() };
}

function acceptedListFindings(source) {
  const heading = "## Accepted Findings";
  const start = source.indexOf(heading);
  if (start < 0) return [];
  const bodyStart = start + heading.length;
  const nextHeading = source.indexOf("\n## ", bodyStart);
  const section = source.slice(bodyStart, nextHeading < 0 ? undefined : nextHeading);
  return [...section.matchAll(/^(\d+)\. \*\*([^*]+)\*\*/gmu)].map((match) => ({
    findingNumber: Number(match[1]),
    title: match[2].replace(/[.:]\s*$/u, "").trim(),
    anchor: "accepted-findings",
  }));
}

async function inventoryAuditFindings(root) {
  const modulesDirectory = path.join(root, "tasks", "architecture-audit", "modules");
  const names = (await readdir(modulesDirectory)).filter((name) => moduleFilePattern.test(name)).sort();
  const findings = [];

  for (const name of names) {
    const taskNumber = Number(name.match(moduleFilePattern)[1]);
    if (taskNumber >= 27) continue;
    const relativePath = `tasks/architecture-audit/modules/${name}`;
    const source = await readFile(path.join(root, relativePath), "utf8");
    const headingFindings = [...source.matchAll(/^### (.+)$/gmu)]
      .map((match) => {
        const finding = auditFindingFromHeading(taskNumber, match[1]);
        return finding && { ...finding, anchor: headingAnchor(match[1]) };
      })
      .filter(Boolean);
    const moduleFindings = headingFindings.length > 0 ? headingFindings : acceptedListFindings(source);

    for (const finding of moduleFindings) {
      findings.push({
        id: `AUDIT-T${taskNumber}-F${finding.findingNumber}`,
        kind: "audit_finding",
        title: finding.title,
        source: `${relativePath}#${finding.anchor}`,
        evidence: `tasks/architecture-audit/evidence/${name.replace(/\.md$/u, "")}/manifest.md`,
      });
    }
  }
  return findings;
}

async function inventoryOldRequirements(root) {
  const relativePath = "tasks/architecture-audit/implementation/index.md";
  const source = await readFile(path.join(root, relativePath), "utf8");
  const queueHeading = "## Superseded Ordered Functional Queue And Evidence Destinations";
  const queueStart = source.indexOf(queueHeading);
  if (queueStart < 0) throw new Error("superseded R-phase queue is missing");
  const nextHeading = source.indexOf("\n## ", queueStart + queueHeading.length);
  const queue = source.slice(queueStart, nextHeading < 0 ? undefined : nextHeading);
  const requirements = [];
  for (const match of queue.matchAll(/^\| (\d+) \| ([^|]+) \|/gmu)) {
    const order = Number(match[1]);
    if (order < 6 || order > 12) continue;
    const phase = order <= 8 ? "R4" : order <= 10 ? "R5" : "R6";
    requirements.push({
      id: `OLD-${phase}-${order}`,
      kind: "old_requirement",
      title: match[2].trim(),
      source: `${relativePath}#superseded-ordered-functional-queue-and-evidence-destinations`,
    });
  }
  return requirements;
}

async function inventoryCurrentFailures(root) {
  const relativePath = "tasks/todo.md";
  const source = await readFile(path.join(root, relativePath), "utf8");
  if (!source.includes("TerminalStageRecoveryClassification.ts") || !source.includes("StageOutcome")) {
    throw new Error("current StageOutcome architecture failure is missing from tasks/todo.md");
  }
  return [{
    id: "CHECK-STAGE-OUTCOME",
    kind: "current_failure",
    title: "TerminalStageRecoveryClassification.ts retains retired StageOutcome",
    source: `${relativePath}#n0-authority-and-disposition`,
  }];
}

export async function inventoryDefectSources(root) {
  const sources = [
    ...(await inventoryAuditFindings(root)),
    ...(await inventoryOldRequirements(root)),
    ...(await inventoryCurrentFailures(root)),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const duplicate = sources.find((source, index) => sources.findIndex(({ id }) => id === source.id) !== index);
  if (duplicate) throw new Error(`duplicate defect source ID: ${duplicate.id}`);
  return sources;
}

function taskNumberFromSourceId(sourceId) {
  return Number(sourceId.match(/^AUDIT-T(\d+)-F\d+$/u)?.[1]);
}

function closureOwner(source) {
  if (source.kind === "current_failure") return "N5.4";
  if (source.kind === "old_requirement") {
    const order = Number(source.id.match(/-(\d+)$/u)?.[1]);
    if (order <= 8) return "N5.5";
    if (order <= 10) return "N5.6";
    return order === 11 ? "N5.2" : "N6.1";
  }
  const task12Owners = new Map([
    ["AUDIT-T12-F1", "N2.2"],
    ["AUDIT-T12-F2", "N1.2"],
    ["AUDIT-T12-F3", "N4.3"],
    ["AUDIT-T12-F4", "N4.3"],
  ]);
  const task12Owner = task12Owners.get(source.id);
  if (task12Owner !== undefined) return task12Owner;
  const task = taskNumberFromSourceId(source.id);
  if (task <= 2 || (task >= 10 && task <= 18)) return "N5.4";
  if (task <= 8) return "N5.3";
  if (task === 9) return "N4.1";
  if (task <= 22) return "N5.5";
  return "N5.6";
}

function realBoundaryObligation(source) {
  if (source.kind === "old_requirement") {
    return /^OLD-R[56]-/u.test(source.id) ? "required" : "not_required";
  }
  if (source.kind !== "audit_finding") return "not_required";
  const task = taskNumberFromSourceId(source.id);
  return (task >= 3 && task <= 8) || (task >= 22 && task <= 26)
    ? "required"
    : "not_required";
}

export function buildInitialClosureRows(sources) {
  return sources.map((source) => source.id === "CHECK-STAGE-OUTCOME"
    ? {
        closureId: `C-${source.id}`,
        sourceId: source.id,
        source: source.source,
        owner: closureOwner(source),
        regression: `RED/GREEN or absence proof: ${source.title}`,
        realBoundary: realBoundaryObligation(source),
        status: "fixed_verified",
        verification: "retired-inventory tests 9/9; Conductor tests 406/406; architecture tests 57/57",
      }
    : {
        closureId: `C-${source.id}`,
        sourceId: source.id,
        source: source.source,
        owner: closureOwner(source),
        regression: `RED/GREEN or absence proof: ${source.title}`,
        realBoundary: realBoundaryObligation(source),
        status: "open",
      });
}

export async function validateDefectSourceLinks(root, sources) {
  const violations = [];
  const contentByFile = new Map();
  for (const source of sources) {
    const [relativePath, anchor] = source.source.split("#", 2);
    let content = contentByFile.get(relativePath);
    if (content === undefined) {
      try {
        content = await readFile(path.join(root, relativePath), "utf8");
        contentByFile.set(relativePath, content);
      } catch {
        violations.push({ code: "missing_source_file", sourceId: source.id });
        continue;
      }
    }
    const anchors = new Set([...content.matchAll(/^#{1,6} (.+)$/gmu)].map((match) => headingAnchor(match[1])));
    if (!anchor || !anchors.has(anchor)) {
      violations.push({ code: "missing_source_anchor", sourceId: source.id });
    }
    if (source.evidence) {
      try {
        await access(path.join(root, source.evidence));
      } catch {
        violations.push({ code: "missing_evidence_manifest", sourceId: source.id });
      }
    }
  }
  return violations;
}

export function validateClosureMatrix(sources, rows) {
  const violations = [];
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const closureCounts = new Map();
  const sourceCounts = new Map();

  for (const row of rows) {
    closureCounts.set(row.closureId, (closureCounts.get(row.closureId) ?? 0) + 1);
    sourceCounts.set(row.sourceId, (sourceCounts.get(row.sourceId) ?? 0) + 1);
    const source = sourcesById.get(row.sourceId);
    if (!source) {
      violations.push({ code: "unknown_source", sourceId: row.sourceId });
    } else if (row.source !== source.source) {
      violations.push({ code: "source_link_mismatch", sourceId: row.sourceId });
    }
    if (!row.owner || !row.regression || !row.realBoundary || !row.status) {
      violations.push({ code: "incomplete_closure_row", sourceId: row.sourceId });
    }
    if (row.status !== "open" && !terminalStatuses.has(row.status)) {
      violations.push({ code: "invalid_closure_status", sourceId: row.sourceId });
    }
    if (terminalStatuses.has(row.status) && !row.verification) {
      violations.push({ code: "terminal_row_without_verification", sourceId: row.sourceId });
    }
  }

  for (const [closureId, count] of closureCounts) {
    if (count > 1) violations.push({ code: "duplicate_closure_id", closureId });
  }
  for (const [sourceId, count] of sourceCounts) {
    if (count > 1) violations.push({ code: "duplicate_source_mapping", sourceId });
  }
  for (const source of sources) {
    if (!sourceCounts.has(source.id)) violations.push({ code: "unmapped_source", sourceId: source.id });
  }
  return violations.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
