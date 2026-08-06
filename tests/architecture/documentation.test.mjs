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

test("target topology is Root to Cycle with one Artist and one Critic", async () => {
  const sources = await loadArchitecture();
  const workflow = sources.get("workflow-model.md");
  const rootIssue = sources.get("root-issue.md");

  assert.match(workflow, /`WF-TOPO-001` \| Cycle \| Root/);
  assert.match(workflow, /`WF-TOPO-002` \| Artist \| Cycle \| exactly one/);
  assert.match(workflow, /`WF-TOPO-003` \| Critic \| Cycle \| exactly one/);
  assert.match(workflow, /Artist must terminate\s+before Critic starts/);
  assert.match(rootIssue, /Root.*--> C1\[Cycle 001\]/);
  assert.match(rootIssue, /C1 --> E1\[Artist\]/);
  assert.match(rootIssue, /C1 --> A1\[Critic\]/);
});

test("Artist Markdown remains display-only and never pre-judges a fresh read-only Critic", async () => {
  const sources = await loadArchitecture();
  const workflow = sources.get("workflow-model.md");
  const performer = sources.get("performer.md");
  const workspace = sources.get("workspace.md");

  assert.match(workflow, /Artist process fails or exits unexpectedly.*still dispatch Critic/);
  assert.match(workflow, /verdict alone determines the Cycle result/);
  assert.match(workflow, /Artist Markdown is appended byte-for-byte once to the Artist Issue description/);
  assert.match(workflow, /does not repeat Cycle\s+description, acceptance, or boundaries/);
  assert.match(performer, /Artist Markdown is captured only for exact terminal description projection and is\s+untrusted; it is not parsed or supplied to Critic/);
  assert.match(performer, /`PF-SESSION-003` \| Critic \| a distinct fresh process after Artist terminates \| read-only/);
  assert.match(workspace, /Artist failed.*partial changes and residual effects/);
});

test("task state, pending finding, and Inbox enforce the Root boundary", async () => {
  const sources = await loadArchitecture();
  const workflow = sources.get("workflow-model.md");
  const reconciliation = sources.get("root-reconciliation.md");
  const rootIssue = sources.get("root-issue.md");

  assert.match(workflow, /trusted task state.*Succeeded Cycles with an `accepted` Critic verdict/);
  assert.match(reconciliation, /Pending Finding.*one current Rejected\/Failed summary/);
  assert.match(reconciliation, /active Cycle.*retain newer comments as pending/);
  assert.match(rootIssue, /Artist or Critic comments, any author \| display-only/);
});

test("manual Root launch is the only public execution entry", async () => {
  const sources = await loadArchitecture();
  const conductor = sources.get("conductor.md");
  const taskManagement = sources.get("task-management.md");

  for (const flag of [
    "--linear-root",
    "--workspace",
    "--dir",
    "--reconcile-agent",
    "--reconcile-model",
    "--reconcile-reasoning-effort",
    "--artist-agent",
    "--artist-model",
    "--artist-reasoning-effort",
    "--critic-agent",
    "--critic-model",
    "--critic-reasoning-effort",
    "--max-cycles",
  ]) {
    assert.match(conductor, new RegExp(flag));
  }
  assert.match(conductor, /`--reconcile-agent codex` \| closed Reconcile role adapter/);
  assert.match(conductor, /`--artist-agent codex` \| closed Artist role adapter/);
  assert.match(conductor, /`--critic-agent codex` \| closed Critic role adapter/);
  assert.doesNotMatch(conductor, /\s--agent(?:\s|`)/u);
  assert.doesNotMatch(conductor, /--dashboard|--task|--issue/u);
  assert.match(conductor, /Root mode is the only public execution entry/);
  assert.match(conductor, /no one-shot\s+role CLI/);
  assert.match(taskManagement, /caller provides no team or workflow-state IDs/);
});

test("Linear statuses are canonical, visible, and explicitly projected", async () => {
  const sources = await loadArchitecture();
  const workflow = sources.get("workflow-model.md");
  const taskManagement = sources.get("task-management.md");
  const conductor = sources.get("conductor.md");
  const rootIssue = sources.get("root-issue.md");
  const contracts = sources.get("contracts.md");

  for (const [name, type] of [
    ["Todo", "unstarted"],
    ["In Progress", "started"],
    ["In Review", "started"],
    ["Done", "completed"],
    ["Canceled", "canceled"],
  ]) {
    assert.match(workflow, new RegExp("\\\\| `" + name + "` \\| `" + type + "` \\|"));
  }
  assert.match(contracts, /LinearStateType = unstarted \| started \| completed \| canceled/);
  assert.match(contracts, /IssueStatus = todo \| active \| completed \| canceled/);
  assert.match(contracts, /Lifecycle decisions therefore\s+use the exact canonical `status_id`/);
  assert.match(taskManagement, /resolves the five canonical statuses by exact name and expected type/);
  assert.match(taskManagement, /no exact-name state \| create the exact name\/type/);
  assert.match(taskManagement, /wrong type \| stop before an Agent starts or any Issue mutation/);
  assert.match(taskManagement, /more than one exact-name state/);
  assert.match(taskManagement, /canonical-state creation fails \| expose the provider error and stop/);
  assert.match(taskManagement, /Any other user-defined state is ignored completely/);
  assert.match(taskManagement, /never treats another `started` state as/);
  assert.match(workflow, /Root \| `Todo` after Prepare and before first fresh Reconcile[\s\S]*durable Cycle family -> `In Progress`[\s\S]*latest_critique[\s\S]*`In Review`[\s\S]*valid Delivery projection -> `Done`/);
  assert.match(workflow, /Cycle \| `Todo` when created[\s\S]*recorded family sets `In Progress`[\s\S]*starting Critic sets `In Review`[\s\S]*terminal Cycle result sets `Done`/);
  assert.match(workflow, /Artist \| `Todo` when created[\s\S]*process launch sets `In Progress`[\s\S]*process return, timeout, interruption, or start failure sets `Done`/);
  assert.match(workflow, /Critic \| `Todo` when created[\s\S]*Critic launch sets `In Review`[\s\S]*Critic report or process error sets `Done`; the report is exact Markdown/);
  assert.match(workflow, /unfinished descendant at startup[\s\S]*set `Canceled` before fresh Reconcile/);
  assert.match(taskManagement, /Issue status transitions are explicit Linear mutations/);
  assert.match(conductor, /\| Artist \| fresh workspace-write process with final `cycle-NNN-artist-result\.md`/);
  assert.match(conductor, /\| Critic \| fresh read-only process with final `cycle-NNN-critic-result\.md`/);
  assert.match(conductor, /set every unfinished Cycle, Artist, and Critic to canonical `Canceled`/);
  assert.match(rootIssue, /canonical `Canceled` state/);
  assert.match(workflow, /Root Reconcile remains the only semantic authority for `create_cycle`, `complete`,\s+and `needs_human`/);
  assert.match(conductor, /Root\s+Reconcile never calls Linear or chooses a status ID/);
});

test("Critic Markdown is the sole semantic result and Root State is the Reconcile boundary", async () => {
  const sources = await loadArchitecture();
  const workflow = sources.get("workflow-model.md");
  const reconciliation = sources.get("root-reconciliation.md");
  const rootIssue = sources.get("root-issue.md");

  assert.match(workflow, /Critic Markdown is appended byte-for-byte once to the Critic Issue description/);
  assert.match(workflow, /Conductor parses this Markdown once into the typed\s+`CritiqueResult`/);
  assert.match(workflow, /reads it back and validates it, then uses the\s+re-read value for Cycle and Root progression/);
  assert.match(workflow, /Only this JSON file is uploaded to\s+the Cycle as `application\/json`/);
  assert.match(workflow, /Cycle Result comment records its resource\s+link or the current upload error/);
  assert.match(workflow, /never starts a second summarization or\s+format-repair Agent call/);
  assert.match(workflow, /written to\s+`RootState\.latest_critique` before the\s+next\s+Reconcile/);
  assert.match(rootIssue, /role report to each role description/);
  assert.match(rootIssue, /parsed Critique is mechanically serialized as\s+`cycle-NNN-critique-result\.json`, written privately, and read back and validated/);
  assert.match(rootIssue, /Only this JSON file is uploaded\s+for the Cycle with `application\/json` content type/);
  assert.match(rootIssue, /If upload fails,[\s\S]*does not alter the Critic\s+verdict or progression/);
  assert.match(rootIssue, /JSONL and stderr\s+remain private local diagnostics[\s\S]*never\s+uploaded as comments or files/);
  assert.match(reconciliation, /parses the exact Critique Markdown once, serializes its typed\s+value to `cycle-NNN-critique-result\.json`/);
  assert.match(reconciliation, /then writes the re-read fields to `RootState\.latest_critique`, promotes trusted\s+fields/);
  assert.match(reconciliation, /Cycle Result as a separate mechanical projection/);
  assert.match(reconciliation, /Root Reconcile never receives the complete Root Issue\s+tree, the managed Root snapshot, Cycle history\/result comments, Cycle DAG/);
  assert.match(reconciliation, /Cycle Result remains\s+a mechanical persistence and operator\s+projection only/);
  assert.doesNotMatch(reconciliation, /completed Cycle mechanical result, when/u);
});

test("fresh Root Reconcile and visible Issue titles have closed contracts", async () => {
  const sources = await loadArchitecture();
  const workflow = sources.get("workflow-model.md");
  const reconciliation = sources.get("root-reconciliation.md");
  const rootIssue = sources.get("root-issue.md");
  const taskManagement = sources.get("task-management.md");
  const conductor = sources.get("conductor.md");

  assert.match(workflow, /startup gates normalize it to `Todo`/);
  assert.match(reconciliation, /normalizes a\s+nonterminal Root to `Todo` before the first fresh Reconcile/);
  assert.match(conductor, /normalize a nonterminal Root to canonical Todo before fresh Reconcile/);
  assert.match(rootIssue, /`\[Cycle NNN\] <objective>` with a concise imperative\s+objective and a maximum total title length of 80 characters/);
  assert.match(rootIssue, /exactly `\[Artist\] Cycle NNN` and\s+`\[Critic\] Cycle NNN`/);
  assert.match(taskManagement, /`\[Cycle NNN\] <objective>` \(concise imperative wording;\s+maximum 80 characters total with word-safe ellipsis fallback\), `\[Artist\] Cycle NNN`, and\s+`\[Critic\] Cycle NNN`/);
});

test("role configuration is independent and closed", async () => {
  const sources = await loadArchitecture();
  const contracts = sources.get("contracts.md");
  const conductor = sources.get("conductor.md");
  const performer = sources.get("performer.md");
  const reconciliation = sources.get("root-reconciliation.md");
  const roadmap = sources.get("roadmap.md");

  for (const flag of [
    "--reconcile-agent",
    "--reconcile-model",
    "--reconcile-reasoning-effort",
    "--artist-agent",
    "--artist-model",
    "--artist-reasoning-effort",
    "--critic-agent",
    "--critic-model",
    "--critic-reasoning-effort",
  ]) {
    assert.match(conductor, new RegExp(flag));
  }
  assert.match(contracts, /artist_model\?: string/);
  assert.match(contracts, /critic_reasoning_effort\?: string/);
  assert.match(contracts, /not public contract fields/);
  assert.match(contracts, /reconcile_agent: codex/);
  assert.match(contracts, /reconcile_reasoning_effort\?: string/);
  assert.match(reconciliation, /own independent role launch configuration/);
  assert.doesNotMatch(reconciliation, /uses the full Artist role configuration/);
  assert.match(performer, /local Codex configuration and authentication/);
  assert.match(roadmap, /independent Reconcile, Artist, and Critic role configuration/);
  assert.match(roadmap, /per-Cycle routing, compatibility\s+aliases/);
  assert.match(performer, /cross-role transcript/);
});

test("diagnostic evidence stays private and non-semantic", async () => {
  const sources = await loadArchitecture();
  const performer = sources.get("performer.md");
  const contracts = sources.get("contracts.md");
  const conductor = sources.get("conductor.md");
  const workflow = sources.get("workflow-model.md");
  const roadmap = sources.get("roadmap.md");
  const e2e = await readFile(path.join(repositoryRoot, "docs/testing/e2e.md"), "utf8");

  assert.match(performer, /diagnostic_jsonl_path\?/);
  assert.match(performer, /diagnostic_stderr_path\?/);
  assert.match(performer, /diagnostic_jsonl_ref\?/);
  assert.match(performer, /diagnostic_stderr_ref\?/);
  assert.match(performer, /thread_id\?/);
  assert.match(performer, /never supplied to the Critic prompt, Root Reconcile, or Linear\s+descriptions\/comments/);
  assert.match(contracts, /private local diagnostic references/);
  assert.match(contracts, /Raw bytes and `thread_id` are\s+never supplied to Critic or Root Reconcile and never uploaded to Linear/);
  assert.match(workflow, /Raw Agent JSONL,\s+stderr, and causal error context may be retained only/);
  assert.match(workflow, /show only the current `error\.message`, first 50 characters/);
  assert.match(workflow, /walk causes, add prefixes or codes/);
  assert.match(conductor, /opaque local `diagnostic_ref`/);
  assert.match(conductor, /Unknown failures are handled without an exhaustive reason-code taxonomy/);
  assert.match(conductor, /current boundary's original message limited to 50\s+characters, without cause traversal or added prefixes/);
  assert.match(roadmap, /private diagnostics/);
  assert.match(e2e, /archives\s+the private run-directory diagnostic evidence before cleaning/);
  assert.match(e2e, /only a stable reason and `diagnostic_ref`/);
});

test("V2 Podium Desktop keeps local scheduling outside Conductor", async () => {
  const sources = await loadArchitecture();
  const workflow = sources.get("workflow-model.md");
  const roadmap = sources.get("roadmap.md");
  const workspace = sources.get("workspace.md");
  const contracts = sources.get("contracts.md");
  const conductor = sources.get("conductor.md");

  assert.match(roadmap, /V2 Podium Desktop/);
  assert.match(roadmap, /manage multiple local Conductors/);
  assert.match(roadmap, /persisted `ProjectBinding`/);
  assert.match(workflow, /higher priority.*preempt.*lower priority/);
  assert.match(workflow, /equal priorities do not preempt/);
  assert.match(workflow, /process-tree confirmation/);
  assert.match(workspace, /Assignment records, process IDs, and the pending queue are Desktop memory/);
  assert.match(workspace, /stable allocation/);
  assert.match(contracts, /ProjectBinding/);
  assert.match(contracts, /routing_label/);
  assert.match(conductor, /one `--linear-root`, one `--workspace`, and one `--dir`/);
  assert.match(conductor, /Podium scheduling, UI, or E2E behavior for `NeedsHuman`/);
});

test("Done Roots and terminal descendants are not modified", async () => {
  const sources = await loadArchitecture();
  const workflow = sources.get("workflow-model.md");
  const reconciliation = sources.get("root-reconciliation.md");
  const conductor = sources.get("conductor.md");

  assert.match(workflow, /Root \| `Done`.*no Root-owned mutation; exit successfully/);
  assert.match(workflow, /Terminal Issues are never reopened or rewritten/);
  assert.match(reconciliation, /Root is already `Done`.*return no-op[\s\S]*team workflow-contract check/);
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
