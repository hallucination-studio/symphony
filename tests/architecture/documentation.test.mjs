import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { auditArchitectureDocs } from "../../tools/architecture/audit-docs.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const architectureRoot = path.join(repositoryRoot, "docs/architecture");

async function loadArchitecture() {
  const names = (await readdir(architectureRoot))
    .filter((name) => name.endsWith(".md"))
    .sort();
  return new Map(
    await Promise.all(
      names.map(async (name) => [
        name,
        await readFile(path.join(architectureRoot, name), "utf8"),
      ]),
    ),
  );
}

test("repository architecture audit is clean", async () => {
  assert.deepEqual(await auditArchitectureDocs(repositoryRoot), []);
});

function collectRuleDefinitions(sources) {
  const definitions = new Map();
  const pattern = /^\| `([A-Z]{2}-[A-Z]+-\d{3})` \|/gm;

  for (const [file, source] of sources) {
    for (const match of source.matchAll(pattern)) {
      const rule = match[1];
      assert.equal(
        definitions.has(rule),
        false,
        `${rule} is defined by both ${definitions.get(rule)} and ${file}`,
      );
      definitions.set(rule, file);
    }
  }

  return definitions;
}

test("architecture documents have valid local links", async () => {
  const sources = await loadArchitecture();
  sources.set("../README.md", await readFile(path.join(repositoryRoot, "README.md"), "utf8"));

  const broken = [];
  const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const [file, source] of sources) {
    const base = file === "../README.md" ? repositoryRoot : architectureRoot;
    for (const match of source.matchAll(linkPattern)) {
      const target = match[1].split("#", 1)[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      try {
        await readFile(path.resolve(base, target));
      } catch {
        broken.push({ file, target });
      }
    }
  }

  assert.deepEqual(broken, []);
});

test("architecture rule definitions are unique and every reference resolves", async () => {
  const sources = await loadArchitecture();
  const definitions = collectRuleDefinitions(sources);
  const unresolved = [];
  const rulePattern = /\b([A-Z]{2}-[A-Z]+-\d{3})\b/g;

  for (const [file, source] of sources) {
    for (const match of source.matchAll(rulePattern)) {
      if (!definitions.has(match[1])) unresolved.push({ file, rule: match[1] });
    }
  }

  assert.deepEqual(unresolved, []);
});

test("rule families remain in their named-concern owner", async () => {
  const sources = await loadArchitecture();
  const definitions = collectRuleDefinitions(sources);
  const owners = new Map([
    ["WF", "workflow-model.md"],
    ["RR", "root-reconciliation.md"],
    ["RI", "root-issue.md"],
    ["CO", "conductor.md"],
    ["PF", "performer.md"],
    ["TM", "task-management.md"],
    ["WS", "workspace.md"],
    ["CT", "contracts.md"],
    ["RM", "roadmap.md"],
  ]);
  const misplaced = [];

  for (const [rule, file] of definitions) {
    const expected = owners.get(rule.slice(0, 2));
    if (expected !== file) misplaced.push({ rule, file, expected });
  }

  assert.deepEqual(misplaced, []);
});

test("Mermaid projections cite their source rules", async () => {
  const sources = await loadArchitecture();
  const missing = [];

  for (const [file, source] of sources) {
    const blocks = source.matchAll(/```mermaid\n([\s\S]*?)```/g);
    for (const [index, match] of [...blocks].entries()) {
      if (!match[1].includes("%% source-rules:")) missing.push({ file, block: index + 1 });
    }
  }

  assert.deepEqual(missing, []);
});

test("target topology is Root to Cycle with one Execute and one Audit", async () => {
  const sources = await loadArchitecture();
  const workflow = sources.get("workflow-model.md");
  const rootIssue = sources.get("root-issue.md");

  assert.match(workflow, /`WF-TOPO-001` \| Cycle \| Root/);
  assert.match(workflow, /`WF-TOPO-002` \| Execute \| Cycle \| exactly one/);
  assert.match(workflow, /`WF-TOPO-003` \| Audit \| Cycle \| exactly one/);
  assert.match(workflow, /Execute must terminate\s+before Audit starts/);
  assert.match(rootIssue, /Root.*--> C1\[Cycle 001\]/);
  assert.match(rootIssue, /C1 --> E1\[Execute\]/);
  assert.match(rootIssue, /C1 --> A1\[Audit\]/);
});

test("Execute process facts never bypass or pre-judge a fresh read-only Audit", async () => {
  const sources = await loadArchitecture();
  const workflow = sources.get("workflow-model.md");
  const performer = sources.get("performer.md");
  const workspace = sources.get("workspace.md");

  assert.match(workflow, /Execute process fails or exits unexpectedly.*still dispatch Audit/);
  assert.match(workflow, /verdict alone determines the Cycle result/);
  assert.match(workflow, /Execute model output is neither parsed nor projected/);
  assert.match(performer, /`PF-SESSION-003` \| Audit \| a distinct fresh process after Execute terminates \| read-only/);
  assert.match(workspace, /Execute failed.*partial changes and residual effects/);
});

test("task state, pending finding, and Inbox enforce the Root boundary", async () => {
  const sources = await loadArchitecture();
  const workflow = sources.get("workflow-model.md");
  const reconciliation = sources.get("root-reconciliation.md");
  const rootIssue = sources.get("root-issue.md");

  assert.match(workflow, /trusted task state.*Succeeded Cycles with an `accepted` Audit verdict/);
  assert.match(reconciliation, /Pending Finding.*one current Rejected\/Failed summary/);
  assert.match(reconciliation, /active Cycle.*retain newer comments as pending/);
  assert.match(rootIssue, /Cycle, Execute, or Audit, any author \| display-only/);
});

test("manual Root launch is the only public execution entry", async () => {
  const sources = await loadArchitecture();
  const conductor = sources.get("conductor.md");
  const taskManagement = sources.get("task-management.md");

  for (const flag of [
    "--linear-root",
    "--agent",
    "--workspace",
    "--dir",
    "--model",
    "--reasoning-effort",
    "--max-cycles",
  ]) {
    assert.match(conductor, new RegExp(flag));
  }
  assert.doesNotMatch(conductor, /--dashboard|--task|--issue/u);
  assert.match(conductor, /Root mode is the only public execution entry/);
  assert.match(conductor, /no one-shot\s+role CLI/);
  assert.match(taskManagement, /Caller-provided team, project, state, label, and template IDs are not inputs/);
});

test("Cycle Result is an Audit projection and not Reconcile input", async () => {
  const sources = await loadArchitecture();
  const workflow = sources.get("workflow-model.md");
  const reconciliation = sources.get("root-reconciliation.md");
  const rootIssue = sources.get("root-issue.md");

  assert.match(workflow, /Cycle Result repeats only the mapped result/);
  assert.match(workflow, /never copies Audit evidence or creates another authority/);
  assert.match(rootIssue, /Root Reconcile reads neither comment/);
  assert.match(reconciliation, /Root State is updated after that result/);
});

test("V1 keeps Podium scheduling and resource allocation out of Conductor", async () => {
  const sources = await loadArchitecture();
  const roadmap = sources.get("roadmap.md");
  const workspace = sources.get("workspace.md");

  assert.match(roadmap, /V1 stops at a manually launched Conductor on one machine/);
  assert.match(roadmap, /Podium \| claim eligible Root Issues, allocate workspace\/run-directory pairs/);
  assert.match(workspace, /allocation, claiming, cleanup, and deletion belong to the caller or future Podium/);
});

test("Done Roots and terminal descendants are not modified", async () => {
  const sources = await loadArchitecture();
  const workflow = sources.get("workflow-model.md");
  const reconciliation = sources.get("root-reconciliation.md");
  const conductor = sources.get("conductor.md");

  assert.match(workflow, /Root \| `Done`.*no mutation; exit successfully/);
  assert.match(workflow, /Terminal Issues are never reopened or rewritten/);
  assert.match(reconciliation, /Root is already `Done`.*return no-op/);
  assert.match(conductor, /Root is `Done`.*perform no Linear or workspace mutation/);
});

test("superseded target-design machinery is absent", async () => {
  const sources = await loadArchitecture();
  const combined = [...sources.values()].join("\n");
  const forbidden = [
    /Plan Issue/i,
    /PlanRequest/,
    /PlanResult/,
    /PlanGraphManifest/,
    /exact revision/i,
    /commit proof/i,
    /convergence proof/i,
    /specification seal/i,
    /Git worktree and delivery/i,
    /\bStageObservation\b/,
  ];

  for (const pattern of forbidden) assert.doesNotMatch(combined, pattern);
});

test("architecture prose stays reviewable", async () => {
  const sources = await loadArchitecture();
  const oversized = [];

  for (const [file, source] of sources) {
    for (const [index, line] of source.split("\n").entries()) {
      if (line.length > 240) oversized.push({ file, line: index + 1, length: line.length });
    }
  }

  assert.deepEqual(oversized, []);
});
