import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { validateV1Registry, V1_ACCEPTANCE_REGISTRY } from "./v1-registry.mjs";

export function hashEvidence(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function evaluateV1Evidence({
  evidenceRoot,
  expectedCommit,
  expectedToolVersion,
  currentToolVersions,
  currentTreeClean = false,
  now = new Date(),
  registry = V1_ACCEPTANCE_REGISTRY,
}) {
  if (!validateV1Registry(registry)) {
    return { status: "blocked", rows: registryRows(registry, "registry_invalid") };
  }

  const manifest = await readArtifactJson(evidenceRoot, "manifest.json");
  if (!validManifest(manifest)) {
    return { status: "blocked", rows: registryRows(registry, "manifest_invalid") };
  }
  if (!sameKeys(manifest.artifacts, Object.fromEntries(registry.map((row) => [row.artifactPath, true])))) {
    return { status: "blocked", rows: registryRows(registry, "manifest_artifact_set_mismatch") };
  }
  if (!manifest.cleanTree) {
    return { status: "blocked", rows: registryRows(registry, "source_tree_dirty") };
  }
  if (!currentTreeClean) {
    return { status: "blocked", rows: registryRows(registry, "current_source_tree_dirty") };
  }
  if (!sameValue(manifest.tools, currentToolVersions)) {
    return { status: "blocked", rows: registryRows(registry, "current_tool_versions_mismatch") };
  }
  const rows = await Promise.all(
    registry.map((row) => evaluateRow({
      evidenceRoot,
      expectedCommit,
      expectedToolVersion,
      manifest,
      now,
      row,
    })),
  );

  return {
    status: rows.every(({ status }) => status === "passed") ? "passed" : "blocked",
    rows,
  };
}

async function evaluateRow(context) {
  const { evidenceRoot, expectedCommit, expectedToolVersion, manifest, now, row } = context;
  const artifact = await readArtifactJson(evidenceRoot, row.artifactPath);
  if (!artifact) return blocked(row.id, "artifact_missing_or_unsafe");
  if (manifest.artifacts[row.artifactPath] !== hashEvidence(artifact)) {
    return blocked(row.id, "artifact_hash_mismatch");
  }
  if (!validArtifact(artifact) || artifact.schemaVersion !== 1 || artifact.acceptanceId !== row.id) {
    return blocked(row.id, "artifact_invalid");
  }
  if (artifact.runId !== manifest.runId) return blocked(row.id, "run_id_mismatch");
  if (artifact.boundary !== row.boundary) return blocked(row.id, "boundary_mismatch");
  if (artifact.command !== row.command) return blocked(row.id, "command_mismatch");
  if (artifact.sourceCommit !== expectedCommit || manifest.sourceCommit !== expectedCommit) {
    return blocked(row.id, "source_commit_mismatch");
  }
  if (artifact.toolVersion !== expectedToolVersion || manifest.toolVersion !== expectedToolVersion) {
    return blocked(row.id, "tool_version_mismatch");
  }
  if (!sameValue(artifact.tools, manifest.tools)) return blocked(row.id, "tool_versions_mismatch");
  if (row.requiredTools.some((tool) => artifact.tools[tool] === "unavailable")) {
    return blocked(row.id, "required_tool_unavailable");
  }
  if (!withinRun(artifact.generatedAt, manifest, now)) {
    return blocked(row.id, "artifact_stale");
  }
  if (!artifactIsSanitized(artifact)) return blocked(row.id, "artifact_contains_sensitive_data");
  if (!/^[a-z0-9_]+$/.test(artifact.reason)) return blocked(row.id, "artifact_reason_not_sanitized");
  if (artifact.exitCode !== 0) return blocked(row.id, artifact.reason || "command_failed");
  if (!validChecks(artifact.checks, row.requiredCheck)) {
    return blocked(row.id, "semantic_checks_missing_or_failed");
  }
  if (artifact.status !== "passed") return blocked(row.id, artifact.reason || "artifact_not_passed");

  return { id: row.id, status: "passed", reason: artifact.reason };
}

function validManifest(manifest) {
  return exactKeys(manifest, [
    "artifacts", "cleanTree", "finishedAt", "runId", "schemaVersion",
    "sourceCommit", "startedAt", "tools", "toolVersion",
  ])
    && manifest.schemaVersion === 1
    && typeof manifest.runId === "string" && manifest.runId.length > 0
    && typeof manifest.sourceCommit === "string"
    && typeof manifest.toolVersion === "string"
    && typeof manifest.startedAt === "string"
    && typeof manifest.finishedAt === "string"
    && typeof manifest.cleanTree === "boolean"
    && validTools(manifest.tools)
    && manifest.artifacts && typeof manifest.artifacts === "object";
}

function validChecks(checks, requiredCheck) {
  return Array.isArray(checks)
    && checks.length > 0
    && checks.some((check) => check?.name === requiredCheck && check.status === "passed")
    && checks.every((check) => exactKeys(check, ["name", "status"])
      && check.status === "passed" && typeof check.name === "string");
}

function validArtifact(artifact) {
  return exactKeys(artifact, [
    "acceptanceId", "boundary", "checks", "command", "exitCode", "generatedAt",
    "reason", "runId", "schemaVersion", "sourceCommit", "status", "tools", "toolVersion",
  ]);
}

function validTools(tools) {
  return exactKeys(tools, ["gh", "git", "node", "npm", "python", "rustc", "tauri"])
    && Object.values(tools).every((value) => typeof value === "string" && value.length > 0);
}

function exactKeys(value, expected) {
  return value && typeof value === "object"
    && Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameKeys(left, right) {
  return Object.keys(left).sort().join(",") === Object.keys(right).sort().join(",");
}

function artifactIsSanitized(value, key = "") {
  if (/token|api.?key|authorization|cookie|password|secret|performer.?id|codex.?home|reasoning/i.test(key)) {
    return false;
  }
  if (typeof value === "string") {
    return !/(?:^|\s)(?:\/Users\/|\/home\/|[A-Za-z]:\\)|Bearer\s+\S+|(?:sk|lin_api|lin_oauth)[-_][A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\./i.test(value);
  }
  if (Array.isArray(value)) return value.every((item) => artifactIsSanitized(item));
  if (value && typeof value === "object") {
    return Object.entries(value).every(([childKey, child]) => artifactIsSanitized(child, childKey));
  }
  return true;
}

function withinRun(generatedAtValue, manifest, now) {
  const generatedAt = Date.parse(generatedAtValue);
  const startedAt = Date.parse(manifest.startedAt);
  const finishedAt = Date.parse(manifest.finishedAt);
  return [generatedAt, startedAt, finishedAt, now.getTime()].every(Number.isFinite)
    && startedAt <= generatedAt
    && generatedAt <= finishedAt
    && finishedAt <= now.getTime();
}

async function readArtifactJson(root, relativePath) {
  if (!safeRelativePath(relativePath)) return null;
  const rootPath = await realpath(root).catch(() => null);
  const candidate = path.resolve(root, relativePath);
  if (!rootPath) return null;

  try {
    const stat = await lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const candidatePath = await realpath(candidate);
    if (!candidatePath.startsWith(`${rootPath}${path.sep}`)) return null;
    return JSON.parse(await readFile(candidate, "utf8"));
  } catch {
    return null;
  }
}

function safeRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && !path.isAbsolute(value)
    && !value.split(/[\\/]/).includes("..");
}

function registryRows(registry, reason) {
  return Array.isArray(registry)
    ? registry.map((row, index) => blocked(row?.id ?? `row-${index}`, reason))
    : [blocked("registry", reason)];
}

function blocked(id, reason) {
  return { id, status: "blocked", reason };
}
