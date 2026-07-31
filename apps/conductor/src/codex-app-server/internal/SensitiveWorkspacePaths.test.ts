import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanSensitiveWorkspacePaths } from "./SensitiveWorkspacePaths.js";

test("sensitive workspace scan finds nested credential paths without following symlinks", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-sensitive-workspace-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, "workspace");
  const outside = path.join(temporary, "outside");
  await Promise.all([
    mkdir(path.join(workspace, "nested", "auth"), { recursive: true }),
    mkdir(path.join(workspace, "nested", "certs"), { recursive: true }),
    mkdir(outside),
  ]);
  await Promise.all([
    writeFile(path.join(workspace, "source.ts"), "export {};\n", "utf8"),
    writeFile(path.join(workspace, "nested", ".env.production"), "secret\n", "utf8"),
    writeFile(path.join(workspace, "nested", "certs", "deploy.pem"), "key\n", "utf8"),
    writeFile(path.join(workspace, "nested", "auth", "credentials.json"), "auth\n", "utf8"),
    writeFile(path.join(outside, ".env.external"), "outside\n", "utf8"),
    symlink(outside, path.join(workspace, "linked-outside")),
  ]);
  const canonicalWorkspace = await realpath(workspace);

  assert.deepEqual(await scanSensitiveWorkspacePaths(canonicalWorkspace), [
    path.join(canonicalWorkspace, "nested", ".env.production"),
    path.join(canonicalWorkspace, "nested", "auth", "credentials.json"),
    path.join(canonicalWorkspace, "nested", "certs", "deploy.pem"),
  ]);
});

test("sensitive workspace scan fails closed when the deny set exceeds its bound", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "symphony-sensitive-limit-"));
  context.after(async () => rm(workspace, { recursive: true, force: true }));
  await Promise.all(Array.from(
    { length: 257 },
    (_, index) => writeFile(path.join(workspace, `.env.${index}`), "secret\n", "utf8"),
  ));

  await assert.rejects(scanSensitiveWorkspacePaths(await realpath(workspace)), /sensitive_workspace_scan_failed/u);
});

test("sensitive workspace scan rejects broad host roots before traversal", async () => {
  await assert.rejects(
    scanSensitiveWorkspacePaths(path.parse(os.tmpdir()).root),
    /sensitive_workspace_scan_failed/u,
  );
  await assert.rejects(
    scanSensitiveWorkspacePaths(path.normalize(os.homedir())),
    /sensitive_workspace_scan_failed/u,
  );
});
