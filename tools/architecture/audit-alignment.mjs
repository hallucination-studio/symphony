import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const textExtensions = new Set([
  ".cjs", ".js", ".json", ".mjs", ".py", ".rs", ".toml", ".ts", ".tsx",
]);

const targetRules = [
  ["apps/conductor/src/composition", "conductor", "docs/architecture/repository-directory.md#conductor"],
  ["apps/conductor/src/linear-gateway", "conductor", "docs/architecture/conductor.md#模块"],
  ["apps/conductor/src/root-discovery", "conductor", "docs/architecture/conductor.md#模块"],
  ["apps/conductor/src/root-scheduling", "conductor", "docs/architecture/conductor.md#模块"],
  ["apps/conductor/src/root-reconciliation", "conductor", "docs/architecture/conductor.md#模块"],
  ["apps/conductor/src/root-reconciler-client", "conductor", "docs/architecture/conductor.md#模块"],
  ["apps/conductor/src/root-directive-materialization", "conductor", "docs/architecture/conductor.md#模块"],
  ["apps/conductor/src/performer-agent-client", "conductor", "docs/architecture/conductor.md#模块"],
  ["apps/conductor/src/human-actions", "conductor", "docs/architecture/conductor.md#模块"],
  ["apps/conductor/src/workflow-events", "conductor", "docs/architecture/conductor.md#模块"],
  ["apps/conductor/src/timeline-projections", "conductor", "docs/architecture/conductor.md#模块"],
  ["apps/conductor/src/performer-profiles", "conductor", "docs/architecture/conductor.md#模块"],
  ["apps/conductor/src/git-workspaces", "conductor", "docs/architecture/conductor.md#模块"],
  ["apps/conductor/src/root-delivery", "conductor", "docs/architecture/conductor.md#模块"],
  ["apps/conductor/src/runtime-logs", "conductor", "docs/architecture/conductor.md#模块"],
  ["apps/performer/src/performer/agent_protocol", "performer", "docs/architecture/repository-directory.md#performer"],
  ["apps/performer/src/performer/root_reconciler", "performer", "docs/architecture/repository-directory.md#performer"],
  ["apps/performer/src/performer/role_execution", "performer", "docs/architecture/repository-directory.md#performer"],
  ["apps/performer/src/performer/session_runtime", "performer", "docs/architecture/repository-directory.md#performer"],
  ["apps/performer/src/performer/profile_control", "performer", "docs/architecture/repository-directory.md#performer"],
  ["apps/performer/src/performer/backends", "performer", "docs/architecture/repository-directory.md#performer"],
  ["packages/podium/src/public", "podium", "docs/architecture/repository-directory.md#podium"],
  ["packages/podium/src/internal/linear-gateway", "podium", "docs/architecture/podium.md#模块"],
  ["packages/podium/src/internal/performer-profile-relay", "podium", "docs/architecture/podium.md#模块"],
  ["packages/podium/src/internal/conductor-presence", "podium", "docs/architecture/podium.md#模块"],
  ["packages/podium/src/internal/desktop-views", "podium", "docs/architecture/podium.md#模块"],
  ["packages/podium/src/internal/storage", "podium", "docs/architecture/repository-directory.md#podium"],
  ["packages/contracts/schemas", "shared", "docs/architecture/repository-directory.md#contracts"],
  ["packages/contracts/generated/typescript", "shared", "docs/architecture/repository-directory.md#contracts"],
  ["packages/contracts/generated/python", "shared", "docs/architecture/repository-directory.md#contracts"],
  ["packages/contracts/generated/rust", "shared", "docs/architecture/repository-directory.md#contracts"],
];

const interfaceRules = [
  ["LinearGatewayInterface", "apps/conductor/src/linear-gateway/api/LinearGatewayInterface.ts", "PodiumLinearGatewayClientImpl", "apps/conductor/src/linear-gateway/internal/PodiumLinearGatewayClientImpl.ts", "conductor"],
  ["RootSchedulingPolicyInterface", "apps/conductor/src/root-scheduling/api/RootSchedulingPolicyInterface.ts", "LinearPriorityRootSchedulingPolicyImpl", "apps/conductor/src/root-scheduling/internal/LinearPriorityRootSchedulingPolicyImpl.ts", "conductor"],
  ["RootInvariantPolicyInterface", "apps/conductor/src/root-reconciliation/api/RootInvariantPolicyInterface.ts", "LinearRootInvariantPolicyImpl", "apps/conductor/src/root-reconciliation/internal/LinearRootInvariantPolicyImpl.ts", "conductor"],
  ["RootReconcilerClientInterface", "apps/conductor/src/root-reconciler-client/api/RootReconcilerClientInterface.ts", "PerformerRootReconcilerClientImpl", "apps/conductor/src/root-reconciler-client/internal/PerformerRootReconcilerClientImpl.ts", "conductor"],
  ["RootDirectiveMaterializerInterface", "apps/conductor/src/root-directive-materialization/api/RootDirectiveMaterializerInterface.ts", "LinearRootDirectiveMaterializerImpl", "apps/conductor/src/root-directive-materialization/internal/LinearRootDirectiveMaterializerImpl.ts", "conductor"],
  ["PerformerAgentClientInterface", "apps/conductor/src/performer-agent-client/api/PerformerAgentClientInterface.ts", "SessionPerformerAgentClientImpl", "apps/conductor/src/performer-agent-client/internal/SessionPerformerAgentClientImpl.ts", "conductor"],
  ["GitWorkspaceInterface", "apps/conductor/src/git-workspaces/api/GitWorkspaceInterface.ts", "NativeGitWorkspaceImpl", "apps/conductor/src/git-workspaces/internal/NativeGitWorkspaceImpl.ts", "conductor"],
  ["RootDeliveryInterface", "apps/conductor/src/root-delivery/api/RootDeliveryInterface.ts", "GitRootDeliveryImpl", "apps/conductor/src/root-delivery/internal/GitRootDeliveryImpl.ts", "conductor"],
  ["ProviderBackendInterface", "apps/performer/src/performer/backends/provider_backend_interface.py", "CodexBackendImpl", "apps/performer/src/performer/backends/codex/codex_backend_impl.py", "performer"],
];

const evidenceRules = [
  ["closed protocol schemas", "docs/architecture/contracts.md#契约与接口边界", ["tests/contracts/v1-contracts.test.mjs"]],
  ["Conductor boundary", "docs/architecture/conductor.md#错误与恢复", ["apps/conductor/src/performer-agent-client/tests/agent-client.test.ts"]],
  ["Performer role runtime", "docs/architecture/performer.md#调用协议", ["apps/performer/tests/test_agent_runtime.py"]],
  ["runtime shutdown", "docs/architecture/runtime-hardening.md#bounded-shutdown", ["tests/integration/runtime-hardening/performer-shutdown.test.mjs"]],
  ["production agent boundary", "docs/architecture/runtime-hardening.md#agent-sessionturn-runtime-boundary", ["tests/integration/agent-boundary/performer-process.test.mjs", "tests/integration/agent-boundary/conductor-process.test.mjs"]],
];

const schemaConsumers = {
  "podium-client": "packages/podium/src/public",
  "desktop-host": "apps/podium-desktop/src-backend",
  "podium-conductor": "apps/conductor/src/private-ipc",
  "conductor-performer": "apps/conductor/src/performer-agent-client",
};

function normalizeFiles(sources) {
  return new Set([...sources.keys()].map((file) => file.split(path.sep).join("/")));
}

function parentPaths(files) {
  const paths = new Set(files);
  for (const file of files) {
    let current = file;
    while (current.includes("/")) {
      current = current.slice(0, current.lastIndexOf("/"));
      paths.add(current);
    }
  }
  return paths;
}

export function inspectArchitectureTargets(targets, sources) {
  const paths = parentPaths(normalizeFiles(sources));
  return targets.map((target) => {
    const { file, owner, source } = targetRule(target);
    return paths.has(file) ? undefined : { code: "missing_target", owner, path: file, source };
  }).filter(Boolean);
}

export function inspectArchitectureEvidence(evidence, sources) {
  const paths = normalizeFiles(sources);
  return evidence.flatMap((entry) => {
    const { concern, source, testPaths } = evidenceRule(entry);
    return testPaths
      .filter((testPath) => !paths.has(testPath))
      .map((testPath) => ({ code: "missing_evidence", concern, source, testPath }));
  });
}

function inspectInterfaceRules(rules, sources) {
  const violations = [];
  for (const entry of rules) {
    const { name, interfacePath, implementation, implementationPath, owner, source } = interfaceRule(entry);
    const interfaceSource = sources.get(interfacePath);
    const implementationSource = sources.get(implementationPath);
    if (interfaceSource === undefined) {
      violations.push({ code: "missing_interface", interface: name, owner, path: interfacePath });
      continue;
    }
    if (implementationSource === undefined) {
      violations.push({ code: "missing_implementation", implementation, interface: name, owner, path: implementationPath });
      continue;
    }
    if (!new RegExp(`\\b${escapeRegExp(name)}\\b`).test(implementationSource)) {
      violations.push({ code: "implementation_not_bound", implementation, interface: name, owner, path: implementationPath });
    }
    const consumerCount = [...sources.entries()].filter(([file, source]) =>
      file !== interfacePath && file !== implementationPath &&
      new RegExp(`\\b${escapeRegExp(name)}\\b`).test(source)).length;
    if (consumerCount === 0) {
      violations.push({ code: "missing_consumer", interface: name, owner, path: interfacePath, source: source ?? "docs/architecture/contracts.md#主要接口" });
    }
  }
  return violations.sort(compareViolation);
}

function inspectOwnerRules(sources) {
  const violations = [];
  for (const [file, source] of sources) {
    const normalized = file.split(path.sep).join("/");
    if (!/^(?:apps|packages)\//u.test(normalized)) continue;
    if (/(?:@linear\/sdk|from\s+["']linear["']|require\(["']@linear\/sdk)/u.test(source) &&
      normalized !== "packages/podium/src/internal/linear-gateway/internal/LinearSdkImpl.ts" &&
      normalized !== "packages/podium/package.json") {
      violations.push({ code: "owner_violation", owner: "podium", path: normalized, rule: "linear_sdk" });
    }
    if (/(?:openai-codex|codex[_-]sdk|from\s+openai\b|import\s+openai\b)/iu.test(source) &&
      !/^apps\/performer\/src\/performer\/backends\/codex\/codex_backend_impl\.py$/u.test(normalized) &&
      normalized !== "apps/performer/pyproject.toml") {
      violations.push({ code: "owner_violation", owner: "performer", path: normalized, rule: "provider_sdk" });
    }
  }
  return violations;
}

export function inspectArchitectureReferences(entries, architectureSources) {
  const available = normalizeFiles(architectureSources);
  return entries.flatMap((entry) => {
    const source = architectureReference(entry);
    if (!source) return [];
    const file = source.split("#", 1)[0];
    if (!available.has(file)) return [{ code: "missing_architecture_source", source }];
    const text = architectureSources.get(file) ?? "";
    const expected = architectureVocabulary(entry);
    return expected !== undefined && !text.includes(expected)
      ? [{ code: "architecture_rule_unowned", expected, source }]
      : [];
  });
}

export function inspectSchemaCoverage(sources) {
  const violations = [];
  const generatedFiles = {
    typescript: "packages/contracts/generated/typescript/contracts.ts",
    python: "packages/contracts/generated/python/contracts.py",
    rust: "packages/contracts/generated/rust/src/lib.rs",
  };
  for (const [file, source] of sources) {
    const match = file.match(/^packages\/contracts\/schemas\/([^/]+)\/\1\.schema\.json$/u);
    if (!match) continue;
    const family = match[1];
    let schema;
    try {
      schema = JSON.parse(source);
    } catch {
      violations.push({ code: "schema_invalid", path: file });
      continue;
    }
    const definitions = schema.$defs && typeof schema.$defs === "object" ? Object.keys(schema.$defs) : [];
    const prefix = pascalCase(family);
    for (const definition of definitions) {
      const typeName = `${prefix}${pascalCase(definition)}`;
      for (const [language, generatedPath] of Object.entries(generatedFiles)) {
        const generated = sources.get(generatedPath);
        if (generated === undefined || !new RegExp(`\\b${escapeRegExp(typeName)}\\b`).test(generated)) {
          violations.push({ code: "missing_generated_variant", family, language, definition, path: generatedPath });
        }
      }
    }
    const evidencePath = "tests/contracts/v1-contracts.test.mjs";
    if (!sources.has(evidencePath)) {
      violations.push({ code: "missing_schema_evidence", family, path: evidencePath, source: "docs/architecture/contracts.md#契约与接口边界" });
    }
    if (family !== "common") {
      const consumerRoot = schemaConsumers[family];
      const hasConsumer = consumerRoot !== undefined && [...sources.keys()].some((candidate) =>
        candidate.startsWith(`${consumerRoot}/`) || candidate === consumerRoot);
      if (!hasConsumer) {
        violations.push({ code: "missing_schema_consumer", family, owner: consumerRoot ?? "unassigned", source: "docs/architecture/repository-directory.md#contracts" });
      }
    }
  }
  return violations.sort(compareViolation);
}

function targetRule(value) {
  if (Array.isArray(value)) {
    return { file: value[0], owner: value[1], source: value[2] };
  }
  return { file: value.file ?? value.path, owner: value.owner, source: value.source };
}

function interfaceRule(value) {
  if (Array.isArray(value)) {
    return {
      name: value[0], interfacePath: value[1], implementation: value[2],
      implementationPath: value[3], owner: value[4],
    };
  }
  return {
    ...value,
    interfacePath: value.interfacePath ?? value.path,
  };
}

function evidenceRule(value) {
  if (Array.isArray(value)) {
    return { concern: value[0], source: value[1], testPaths: value[2] };
  }
  return value;
}

function architectureReference(value) {
  if (!Array.isArray(value)) return value.source;
  if (value.length === 5) return undefined;
  return typeof value[2] === "string" ? value[2] : value[1];
}

function architectureVocabulary(value) {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 5) return value[0];
  if (typeof value[2] === "string") {
    const pathParts = value[0].split("/");
    return pathParts.at(-1) === "src" ? pathParts.at(-2) : pathParts.at(-1);
  }
  return undefined;
}

function pascalCase(value) {
  return value.split(/[^A-Za-z0-9]+/u).filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1)).join("");
}

export function inspectAlignment(model) {
  return [
    ...inspectInterfaceRules(model.interfaces ?? [], model.sources),
    ...inspectOwnerRules(model.sources),
    ...inspectArchitectureEvidence(model.evidence ?? [], model.sources),
  ].sort(compareViolation);
}

function compareViolation(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function trackedSources(root) {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "buffer" });
  const files = stdout.toString("utf8").split("\0").filter(Boolean).sort();
  const entries = await Promise.all(files.map(async (file) => {
    if (!textExtensions.has(path.extname(file))) return [file, ""];
    try {
      return [file, await readFile(path.join(root, file), "utf8")];
    } catch {
      return undefined;
    }
  }));
  return new Map(entries.filter((entry) => entry !== undefined));
}

async function architectureSources(root) {
  const entries = await execFileAsync("git", ["ls-files", "-z", "docs/architecture", "AGENTS.md"], { cwd: root, encoding: "buffer" });
  const files = entries.stdout.toString("utf8").split("\0").filter(Boolean);
  const sources = new Map();
  for (const file of files) {
    try { sources.set(file, await readFile(path.join(root, file), "utf8")); } catch { /* report through the source check */ }
  }
  return sources;
}

export async function auditArchitectureAlignment(root, options = {}) {
  if (options.mode !== "static") throw new Error("alignment_mode_required");
  const sources = await trackedSources(root);
  const architecture = await architectureSources(root);
  const violations = [
    ...inspectArchitectureTargets(targetRules, sources),
    ...inspectInterfaceRules(interfaceRules, sources),
    ...inspectArchitectureReferences([...targetRules, ...interfaceRules, ...evidenceRules], architecture),
    ...inspectArchitectureEvidence(evidenceRules, sources),
    ...inspectSchemaCoverage(sources),
    ...inspectOwnerRules(sources),
  ];
  return violations.sort(compareViolation);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const mode = process.argv.find((argument) => argument.startsWith("--mode="))?.slice("--mode=".length);
  const violations = await auditArchitectureAlignment(process.cwd(), { mode });
  for (const violation of violations) process.stderr.write(`${JSON.stringify(violation)}\n`);
  if (violations.length > 0) process.exitCode = 1;
}
