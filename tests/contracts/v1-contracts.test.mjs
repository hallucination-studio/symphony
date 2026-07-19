import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const schemaRoot = path.join(root, "packages/contracts/schemas");
const generatedRoot = path.join(root, "packages/contracts/generated");
const protocolFamilies = [
  "common",
  "podium-client",
  "desktop-host",
  "podium-conductor",
  "conductor-performer",
];

async function loadSchema(family) {
  const schemaPath = path.join(schemaRoot, family, `${family}.schema.json`);
  return JSON.parse(await readFile(schemaPath, "utf8"));
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
}

test("all V1 protocol families are closed JSON Schema 2020-12 sources", async () => {
  for (const family of protocolFamilies) {
    const schema = await loadSchema(family);
    assert.equal(
      schema.$schema,
      "https://json-schema.org/draft/2020-12/schema",
      family,
    );
    assert.equal(typeof schema.$id, "string", family);
    assert.ok(schema.$defs && Object.keys(schema.$defs).length > 0, family);

    for (const [name, definition] of Object.entries(schema.$defs)) {
      if (definition.type === "object") {
        assert.equal(
          definition.additionalProperties,
          false,
          `${family}#${name} must reject unknown fields`,
        );
      }
    }
  }
});

test("the schemas include only the approved V1 protocol vocabulary", async () => {
  const schemas = await Promise.all(protocolFamilies.map(loadSchema));
  const source = JSON.stringify(schemas);

  for (const requiredName of [
    "ProtocolError",
    "ConnectLinearCommand",
    "DesktopOverviewView",
    "OpenExternalUrlCommand",
    "ResolveConductorProjectQuery",
    "LinearMutationCommand",
    "PlanTurnCommand",
    "WorkTurnCommand",
    "RootGateTurnCommand",
    "PerformerTurnEvent",
  ]) {
    assert.match(source, new RegExp(`"${requiredName}"`), requiredName);
  }

  for (const forbiddenName of [
    "PriorityRootScheduling",
    "BlockerScheduling",
    "StartOperation",
    "GetOperationStatus",
    "DeliveryReceipt",
    "PlanRevision",
    "ProviderConfigMap",
  ]) {
    assert.doesNotMatch(source, new RegExp(forbiddenName), forbiddenName);
  }
});

test("Roadmap 2 Root scheduling facts are closed and bounded", async () => {
  const schema = await loadSchema("podium-conductor");
  const root = schema.$defs.RootIssueSnapshot;
  const issue = schema.$defs.LinearIssueNodeSnapshot;
  const priority = schema.$defs.LinearPriority;
  const blocker = schema.$defs.LinearBlockerSnapshot;

  assert.ok(root.required.includes("priority"));
  assert.ok(root.required.includes("blockers"));
  assert.equal(root.properties.priority.$ref, "#/$defs/LinearPriority");
  assert.deepEqual(priority.enum, [
    "urgent",
    "high",
    "normal",
    "low",
    "no_priority",
  ]);
  assert.equal(root.properties.blockers.maxItems, 512);
  assert.equal(
    root.properties.blockers.items.$ref,
    "#/$defs/LinearBlockerSnapshot",
  );
  assert.equal(issue.properties.order.type, "number");
  assert.equal(issue.properties.order.minimum, -1000000000);
  assert.equal(issue.properties.order.maximum, 1000000000);
  assert.equal(blocker.additionalProperties, false);
  assert.deepEqual(blocker.required, [
    "source_issue_id",
    "target_issue_id",
    "target_state",
  ]);
});

test("generation is deterministic and check mode detects drift", async () => {
  const first = run("npm", ["run", "contracts:generate"]);
  assert.equal(first.status, 0, first.stderr);

  const generatedFiles = [
    "typescript/contracts.ts",
    "python/contracts.py",
    "rust/src/lib.rs",
  ];
  const before = await Promise.all(
    generatedFiles.map((file) =>
      readFile(path.join(generatedRoot, file), "utf8"),
    ),
  );

  const second = run("npm", ["run", "contracts:generate"]);
  assert.equal(second.status, 0, second.stderr);
  const after = await Promise.all(
    generatedFiles.map((file) =>
      readFile(path.join(generatedRoot, file), "utf8"),
    ),
  );
  assert.deepEqual(after, before);
  assert.match(before[0], /export type PodiumClientConnectLinearCommand/);
  assert.match(before[1], /class ConductorPerformerPlanTurnCommand/);
  assert.match(
    before[2],
    /define_contract_type!\(DesktopHostOpenExternalUrlCommand/,
  );

  const check = run("npm", ["run", "contracts:check"]);
  assert.equal(check.status, 0, check.stderr);

  const target = path.join(generatedRoot, generatedFiles[0]);
  try {
    await writeFile(target, `${before[0]}\n// drift\n`);
    const drift = run("npm", ["run", "contracts:check"]);
    assert.notEqual(drift.status, 0);
    assert.match(drift.stderr, /generated contract drift/i);
  } finally {
    await writeFile(target, before[0]);
  }
});

test("TypeScript, Python, and Rust reject the same invalid fixtures", async () => {
  const fixtureRoot = path.join(
    root,
    "packages/contracts/fixtures/cross-language",
  );
  const validPath = path.join(fixtureRoot, "valid");
  const invalidPath = path.join(fixtureRoot, "invalid");

  const typescript = run("npm", [
    "run",
    "contracts:validate:typescript",
    "--",
    validPath,
    invalidPath,
  ]);
  assert.equal(typescript.status, 0, typescript.stderr);

  const python = run(".venv/bin/python", [
    "packages/contracts/tools/validate_python.py",
    validPath,
    invalidPath,
  ]);
  assert.equal(python.status, 0, python.stderr);

  const cargoTarget = await mkdtemp(path.join(tmpdir(), "symphony-contracts-"));
  const rust = run(
    "cargo",
    [
      "run",
      "--quiet",
      "--manifest-path",
      "packages/contracts/generated/rust/Cargo.toml",
      "--example",
      "validate",
      "--",
      validPath,
      invalidPath,
    ],
    { env: { ...process.env, CARGO_TARGET_DIR: cargoTarget } },
  );
  assert.equal(rust.status, 0, rust.stderr);
});

test("all generated decoders count string bounds by Unicode code point", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "symphony-unicode-"));
  const validPath = path.join(fixtureRoot, "valid");
  const invalidPath = path.join(fixtureRoot, "invalid");
  await mkdir(validPath);
  await mkdir(invalidPath);
  await writeFile(
    path.join(validPath, "unicode.json"),
    JSON.stringify({
      schema: "common.schema.json#/$defs/ShortText",
      value: "😀".repeat(130),
    }),
  );

  const typescript = run("npm", [
    "run",
    "contracts:validate:typescript",
    "--",
    validPath,
    invalidPath,
  ]);
  assert.equal(typescript.status, 0, typescript.stderr);

  const python = run(".venv/bin/python", [
    "packages/contracts/tools/validate_python.py",
    validPath,
    invalidPath,
  ]);
  assert.equal(python.status, 0, python.stderr);

  const cargoTarget = await mkdtemp(path.join(tmpdir(), "symphony-unicode-rust-"));
  const rust = run(
    "cargo",
    [
      "run",
      "--quiet",
      "--manifest-path",
      "packages/contracts/generated/rust/Cargo.toml",
      "--example",
      "validate",
      "--",
      validPath,
      invalidPath,
    ],
    { env: { ...process.env, CARGO_TARGET_DIR: cargoTarget } },
  );
  assert.equal(rust.status, 0, rust.stderr);
});
