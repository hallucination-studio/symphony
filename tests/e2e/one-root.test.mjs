import test from "node:test";
import path from "node:path";

import { assertCompletedMultiWorkRoot, waitForRoot, withOneRoot } from "./black-box-runner.mjs";

const repositoryPath = path.resolve(import.meta.dirname, "../..");

test("built Conductor completes one real multi-Work Root through Linear", { timeout: 31 * 60_000 }, async () => {
  await withOneRoot(repositoryPath, async ({ client, rootId, child, output }) => {
    const tree = await waitForRoot(client, rootId, (current) => current.status === "In Review", { child, output });
    assertCompletedMultiWorkRoot(tree);
    if (child.exitCode !== null) throw new Error("e2e_conductor_exited_early");
    if (!output.stdout().includes('"event":"conductor_ready"')) throw new Error("e2e_conductor_not_ready");
    if (output.stderr().includes('"event":"conductor_failed"')) throw new Error("e2e_conductor_failed");
  });
});
