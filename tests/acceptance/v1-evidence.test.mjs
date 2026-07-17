import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateV1Registry, V1_ACCEPTANCE_REGISTRY } from "./v1-registry.mjs";
import { evaluateV1Evidence, hashEvidence } from "./v1-evaluator.mjs";

const EXPECTED_IDS = Array.from({ length: 24 }, (_, index) =>
  `A${String(index + 1).padStart(2, "0")}`,
);

test("registry covers A01-A24 exactly once", () => {
  assert.deepEqual(
    V1_ACCEPTANCE_REGISTRY.map(({ id }) => id),
    EXPECTED_IDS,
  );
  assert.ok(Object.isFrozen(V1_ACCEPTANCE_REGISTRY));

  for (const row of V1_ACCEPTANCE_REGISTRY) {
    assert.match(row.citation, /^docs\/architecture\/.+\.md#/);
    assert.ok(row.owner.length > 0);
    assert.ok(row.command.startsWith("npm run acceptance:"));
    assert.ok(["live", "packaged", "static"].includes(row.boundary));
    assert.equal(row.artifactPath, `artifacts/${row.id}.json`);
    assert.match(row.requiredCheck, /^[a-z0-9_]+$/);
    assert.ok(row.requiredTools.length > 0);
    assert.ok(Object.isFrozen(row));
  }
  assert.equal(validateV1Registry(V1_ACCEPTANCE_REGISTRY), true);
});

test("roadmap still defines the same 24 acceptance facts", async () => {
  const roadmap = await readFile("docs/architecture/roadmap.md", "utf8");
  const section = roadmap.split("## 8. V1验收边界")[1]?.split("## 9.")[0] ?? "";
  const facts = [...section.matchAll(/^(\d+)\.\s+(.+?)(?:；)?$/gm)].map((match) => ({
    id: `A${match[1].padStart(2, "0")}`,
    fact: match[2].replaceAll("`", ""),
  }));
  assert.deepEqual(
    facts,
    V1_ACCEPTANCE_REGISTRY.map(({ id, fact }) => ({ id, fact })),
  );
});

test("registry validation rejects missing, duplicate, out-of-range, and open rows", () => {
  const copies = V1_ACCEPTANCE_REGISTRY.map((row) => ({ ...row }));
  assert.equal(validateV1Registry(copies.slice(1)), false);
  assert.equal(validateV1Registry([copies[0], ...copies.slice(0, 23)]), false);
  assert.equal(validateV1Registry(copies.map((row, index) => index ? row : { ...row, id: "A00" })), false);
  assert.equal(validateV1Registry(copies.map((row, index) => index ? row : { ...row, extra: true })), false);
});

test("current matching evidence passes", async () => {
  const fixture = await createEvidenceFixture();
  const result = await evaluateV1Evidence(fixture.options);

  assert.equal(result.status, "passed");
  assert.equal(result.rows.length, 24);
  assert.ok(result.rows.every((row) => row.status === "passed"));
});

test("missing, stale, wrong-commit, wrong-tool, skipped, and tampered evidence block", async () => {
  const cases = [
    ["missing", ({ omittedIds }) => { omittedIds.add("A01"); }],
    ["stale", ({ artifacts }) => { artifacts.A01.generatedAt = "2020-01-01T00:00:00.000Z"; }],
    ["wrong_commit", ({ artifacts }) => { artifacts.A01.sourceCommit = "wrong"; }],
    ["wrong_tool_version", ({ artifacts }) => { artifacts.A01.toolVersion = "wrong"; }],
    ["skipped", ({ artifacts }) => { artifacts.A01.status = "skipped"; }],
    ["nonzero", ({ artifacts }) => { artifacts.A01.exitCode = 1; }],
    ["failed_check", ({ artifacts }) => { artifacts.A01.checks[0].status = "failed"; }],
    ["tampered", ({ artifacts, preserveManifestHash }) => {
      artifacts.A01.reason = "changed after hashing";
      preserveManifestHash.add("A01");
    }],
  ];

  for (const [reason, mutate] of cases) {
    const fixture = await createEvidenceFixture(mutate);
    const result = await evaluateV1Evidence(fixture.options);
    assert.equal(result.status, "blocked", reason);
    assert.equal(result.rows.find(({ id }) => id === "A01")?.status, "blocked", reason);
  }
});

test("unsafe artifact paths and symlinks block", async () => {
  const unsafeRegistry = V1_ACCEPTANCE_REGISTRY.map((row) => ({ ...row }));
  unsafeRegistry[0].artifactPath = "../A01.json";
  const invalidRegistry = await createEvidenceFixture();
  const invalidResult = await evaluateV1Evidence({ ...invalidRegistry.options, registry: unsafeRegistry });
  assert.equal(invalidResult.status, "blocked");
  assert.ok(invalidResult.rows.every(({ reason }) => reason === "registry_invalid"));

  const fixture = await createEvidenceFixture();
  const target = path.join(fixture.evidenceRoot, "real-A01.json");
  const link = path.join(fixture.evidenceRoot, "artifacts/A01.json");
  await rm(link);
  await writeFile(target, "{}\n");
  await symlink(target, link);
  const result = await evaluateV1Evidence(fixture.options);
  assert.equal(result.rows.find(({ id }) => id === "A01")?.reason, "artifact_missing_or_unsafe");
});

test("fake or static evidence cannot satisfy live and packaged rows", async () => {
  for (const boundary of ["fake", "static"]) {
    const fixture = await createEvidenceFixture(async ({ artifacts }) => {
      artifacts.A01.boundary = boundary;
    });
    const result = await evaluateV1Evidence(fixture.options);
    assert.equal(result.rows.find(({ id }) => id === "A01")?.reason, "boundary_mismatch");
  }
});

test("artifacts containing secrets, provider handles, or private paths block", async () => {
  const probes = [
    ["reason", "Bearer private-value", "artifact_contains_sensitive_data"],
    ["reason", `sk-${"x".repeat(24)}`, "artifact_contains_sensitive_data"],
    ["reason", `lin_api_${"x".repeat(24)}`, "artifact_contains_sensitive_data"],
    ["performerId", "opaque-provider-handle", "artifact_invalid"],
    ["reason", "/Users/private/runtime.json", "artifact_contains_sensitive_data"],
  ];
  for (const [key, value, expectedReason] of probes) {
    const fixture = await createEvidenceFixture(({ artifacts }) => {
      artifacts.A01[key] = value;
    });
    const result = await evaluateV1Evidence(fixture.options);
    assert.equal(
      result.rows.find(({ id }) => id === "A01")?.reason,
      expectedReason,
    );
  }
});

test("only tools required by a row can block that row", async () => {
  const fixture = await createEvidenceFixture(({ artifacts, manifest }) => {
    manifest.tools.gh = "unavailable";
    for (const artifact of Object.values(artifacts)) artifact.tools.gh = "unavailable";
  });
  fixture.options.currentToolVersions.gh = "unavailable";
  const result = await evaluateV1Evidence(fixture.options);
  assert.equal(result.rows.find(({ id }) => id === "A01")?.status, "passed");
  assert.equal(result.rows.find(({ id }) => id === "A11")?.reason, "required_tool_unavailable");
});

async function createEvidenceFixture(mutate = async () => {}) {
  const evidenceRoot = await mkdtemp(path.join(tmpdir(), "symphony-v1-evidence-"));
  const artifactDirectory = path.join(evidenceRoot, "artifacts");
  await mkdir(artifactDirectory);

  const now = "2026-07-17T00:00:00.000Z";
  const sourceCommit = "0123456789abcdef";
  const toolVersion = "1";
  const tools = { ...TOOL_VERSIONS };
  const artifacts = Object.fromEntries(
    V1_ACCEPTANCE_REGISTRY.map((row) => [
      row.id,
      {
        schemaVersion: 1,
        acceptanceId: row.id,
        boundary: row.boundary,
        command: row.command,
        runId: "run-1",
        sourceCommit,
        toolVersion,
        tools: { ...tools },
        generatedAt: now,
        exitCode: 0,
        status: "passed",
        reason: "verified",
        checks: [{ name: row.requiredCheck, status: "passed" }],
      },
    ]),
  );
  const preserveManifestHash = new Set();
  const omittedIds = new Set();
  const manifest = {
    schemaVersion: 1,
    runId: "run-1",
    sourceCommit,
    toolVersion,
    startedAt: now,
    finishedAt: now,
    cleanTree: true,
    tools: { ...tools },
    artifacts: {},
  };

  for (const row of V1_ACCEPTANCE_REGISTRY) {
    manifest.artifacts[row.artifactPath] = hashEvidence(artifacts[row.id]);
  }

  await mutate({ artifacts, evidenceRoot, manifest, omittedIds, preserveManifestHash });
  for (const row of V1_ACCEPTANCE_REGISTRY) {
    if (omittedIds.has(row.id)) continue;
    await writeFile(
      path.join(evidenceRoot, row.artifactPath),
      `${JSON.stringify(artifacts[row.id], null, 2)}\n`,
    );
    if (!preserveManifestHash.has(row.id)) {
      manifest.artifacts[row.artifactPath] = hashEvidence(artifacts[row.id]);
    }
  }
  await writeFile(path.join(evidenceRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    options: {
      evidenceRoot,
      expectedCommit: sourceCommit,
      expectedToolVersion: toolVersion,
      currentToolVersions: { ...tools },
      currentTreeClean: true,
      now: new Date(now),
    },
    evidenceRoot,
  };
}

const TOOL_VERSIONS = {
  node: "v22.21.0",
  npm: "10.0.0",
  git: "git version test",
  gh: "gh version test",
  python: "Python test",
  rustc: "rustc test",
  tauri: "tauri test",
};
