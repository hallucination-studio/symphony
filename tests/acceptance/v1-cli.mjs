import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { evaluateV1Evidence, hashEvidence } from "./v1-evaluator.mjs";
import { V1_ACCEPTANCE_REGISTRY } from "./v1-registry.mjs";

export const ACCEPTANCE_TOOL_VERSION = "1";

const [mode, ...arguments_] = process.argv.slice(2);

if (mode === "collect") {
  await collect(arguments_);
} else if (mode === "evaluate") {
  await evaluate(arguments_);
} else {
  throw new Error("usage: v1-cli.mjs collect [--output DIR] | evaluate [--input DIR]");
}

async function collect(arguments_) {
  const output = option(arguments_, "--output") ?? ".test/v1-acceptance";
  const timestamp = new Date().toISOString();
  const sourceCommit = git("rev-parse", "HEAD");
  const cleanTree = git("status", "--porcelain") === "";
  const tools = toolVersions();
  const manifest = {
    schemaVersion: 1,
    runId: randomUUID(),
    sourceCommit,
    toolVersion: ACCEPTANCE_TOOL_VERSION,
    startedAt: timestamp,
    finishedAt: timestamp,
    cleanTree,
    tools,
    artifacts: {},
  };

  await mkdir(path.join(output, "artifacts"), { recursive: true });
  await Promise.all(V1_ACCEPTANCE_REGISTRY.map(async (row) => {
    const reason = blockedReason(row);
    const artifact = {
      schemaVersion: 1,
      acceptanceId: row.id,
      runId: manifest.runId,
      boundary: row.boundary,
      command: row.command,
      sourceCommit,
      toolVersion: ACCEPTANCE_TOOL_VERSION,
      tools,
      generatedAt: timestamp,
      exitCode: 2,
      status: "blocked",
      reason,
      checks: [{ name: row.requiredCheck, status: "blocked", reason }],
    };
    manifest.artifacts[row.artifactPath] = hashEvidence(artifact);
    await writeFile(
      path.join(output, row.artifactPath),
      `${JSON.stringify(artifact, null, 2)}\n`,
      { flag: "wx" },
    );
  }));
  await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });

  const verdict = await evaluateV1Evidence({
    evidenceRoot: output,
    expectedCommit: sourceCommit,
    expectedToolVersion: ACCEPTANCE_TOOL_VERSION,
    currentToolVersions: tools,
    currentTreeClean: cleanTree,
  });
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  process.exitCode = 1;
}

async function evaluate(arguments_) {
  const input = option(arguments_, "--input") ?? ".test/v1-acceptance";
  const cleanTree = git("status", "--porcelain") === "";
  const verdict = await evaluateV1Evidence({
    evidenceRoot: input,
    expectedCommit: git("rev-parse", "HEAD"),
    expectedToolVersion: ACCEPTANCE_TOOL_VERSION,
    currentToolVersions: toolVersions(),
    currentTreeClean: cleanTree,
  });
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  if (verdict.status !== "passed") process.exitCode = 1;
}

function blockedReason(row) {
  if (row.boundary === "packaged" && process.platform !== "darwin") {
    return "packaged_desktop_requires_macos";
  }
  if (requiresLinear(row.id) && !hasLinearCredentials()) {
    return "linear_credentials_unavailable";
  }
  if (requiresCodex(row.id) && !hasCodexCredentials()) {
    return "codex_profile_credentials_unavailable";
  }
  if (row.id === "A11" && !githubReady()) return "github_delivery_unavailable";
  return `${row.boundary}_acceptance_driver_unavailable`;
}

function requiresLinear(id) {
  return !["A11", "A20", "A22", "A23"].includes(id);
}

function requiresCodex(id) {
  return ["A04", "A05", "A06", "A07", "A08", "A09", "A10", "A13", "A15", "A17", "A19", "A21", "A22", "A23", "A24"].includes(id);
}

function hasLinearCredentials() {
  return Boolean(
    process.env.LINEAR_API_KEY
    || (process.env.SYMPHONY_LINEAR_CLIENT_ID && process.env.SYMPHONY_LINEAR_CLIENT_SECRET),
  );
}

function hasCodexCredentials() {
  return Boolean(process.env.SYMPHONY_E2E_CODEX_HOME_SEED || process.env.OPENAI_API_KEY);
}

function githubReady() {
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function git(...arguments_) {
  return execFileSync("git", arguments_, { encoding: "utf8" }).trim();
}

function toolVersions() {
  return {
    node: process.version,
    npm: version("npm", ["--version"]),
    git: version("git", ["--version"]),
    gh: version("gh", ["--version"]),
    python: version(".venv/bin/python", ["--version"]),
    rustc: version("rustc", ["--version"]),
    tauri: version("npm", ["exec", "--", "tauri", "--version"]),
  };
}

function version(command, arguments_) {
  try {
    return execFileSync(command, arguments_, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n")[0];
  } catch {
    return "unavailable";
  }
}

function option(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
}
