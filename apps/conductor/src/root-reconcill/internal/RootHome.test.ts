import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseCorrelationId,
  parseObservationDigest,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseThreadId,
} from "../../contracts/identity.js";
import { RootHomeManager } from "./RootHome.js";

async function directories() {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-root-home-"));
  const programData = path.join(root, "program");
  const performerHome = path.join(root, "performer");
  await Promise.all([mkdir(programData), mkdir(performerHome)]);
  return { root, programData, performerHome };
}

function state(rootId = "LIN-1") {
  return {
    schema_version: 1 as const,
    root_id: parseRootIssueId(rootId),
    runtime_generation: parseRuntimeGeneration(1),
    thread_id: parseThreadId("thread:1"),
    accepted_observation_digest: parseObservationDigest("digest:1"),
    in_flight_correlation: parseCorrelationId("corr:1"),
  };
}

test("continuity is atomically written and contains only approved state", async () => {
  const fixture = await directories();
  const manager = await RootHomeManager.create(fixture.programData, fixture.performerHome);
  const home = await manager.open(parseRootIssueId("LIN-1"));
  await home.continuity.write(state());
  assert.deepEqual(await home.continuity.load(), state());
  await home.continuity.write({ ...state(), runtime_generation: parseRuntimeGeneration(2) });
  assert.equal((await home.continuity.load()).runtime_generation, 2);
  assert.deepEqual(await readdir(path.dirname(home.continuity.statePath)), ["state.json"]);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(home.continuity.statePath, "utf8"))).sort(), [
    "accepted_observation_digest", "in_flight_correlation", "root_id", "runtime_generation", "schema_version", "thread_id",
  ]);
});

test("Root and Performer Homes reject equality and both containment directions", async () => {
  const fixture = await directories();
  await assert.rejects(RootHomeManager.create(fixture.programData, fixture.programData), /overlap/u);
  const nestedPerformer = path.join(fixture.programData, "performer");
  await mkdir(nestedPerformer);
  await assert.rejects(RootHomeManager.create(fixture.programData, nestedPerformer), /overlap/u);
  const nestedProgram = path.join(fixture.performerHome, "program");
  await mkdir(nestedProgram);
  await assert.rejects(RootHomeManager.create(nestedProgram, fixture.performerHome), /overlap/u);
});

test("Root and Performer Homes reject symlink aliases", async () => {
  const fixture = await directories();
  const alias = path.join(fixture.root, "performer-alias");
  await symlink(fixture.programData, alias, "dir");
  await assert.rejects(RootHomeManager.create(fixture.programData, alias), /overlap/u);
});

test("Root and Performer Homes reject case-normalized aliases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-root-case-"));
  const upper = path.join(root, "CaseHome");
  const lower = path.join(root, "casehome");
  await mkdir(upper);
  await mkdir(lower).catch(() => undefined);
  await assert.rejects(RootHomeManager.create(upper, lower), /overlap/u);
});

test("delete refuses live runtime, mismatched owner, and path escape", async () => {
  const fixture = await directories();
  const manager = await RootHomeManager.create(fixture.programData, fixture.performerHome);
  const rootId = parseRootIssueId("LIN-1");
  const home = await manager.open(rootId);
  await home.continuity.write(state("LIN-2"));
  await assert.rejects(manager.delete(rootId, () => true), /root_runtime_is_live/u);
  await assert.rejects(manager.delete(rootId, () => false), /root_home_owner_mismatch/u);

  const other = await directories();
  const escapingManager = await RootHomeManager.create(other.programData, other.performerHome);
  const escapingPath = escapingManager.pathFor(rootId);
  await mkdir(path.dirname(escapingPath), { recursive: true });
  await symlink(fixture.performerHome, escapingPath, "dir");
  await assert.rejects(escapingManager.delete(rootId, () => false), /invalid_root_home/u);
});
