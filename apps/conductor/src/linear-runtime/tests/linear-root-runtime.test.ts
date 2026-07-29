import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalFactInput } from "../api/CanonicalFact.js";
import type { RecoveredRootState, RootStateRecoveryInterface, RootStateRecoveryResult } from "../api/RootStateRecoveryInterface.js";
import type { LinearRootRuntimeOutput, NativeEffectObservationOutcome } from "../api/LinearRootRuntimeInterface.js";
import { CanonicalObservationDiffPolicyImpl } from "../internal/CanonicalObservationDiffPolicyImpl.js";
import { CanonicalObservationPolicyImpl } from "../internal/CanonicalObservationPolicyImpl.js";
import { LinearRootRuntimeImpl } from "../internal/LinearRootRuntimeImpl.js";

const canonical = new CanonicalObservationPolicyImpl();
const diff = new CanonicalObservationDiffPolicyImpl(canonical);
const provenance = { actorKind: "symphony" as const, observedAt: "2026-07-29T00:00:00.000Z" };

function status(statusId: string, name: string): CanonicalFactInput {
  return { value: { kind: "linear_status", statusId, name, category: "unstarted", position: 1 }, provenance };
}

function recovered(...facts: CanonicalFactInput[]): RecoveredRootState {
  const sealed = diff.seal(canonical.canonicalize(facts));
  return { rootIssueId: "root-1", contentDigest: sealed.contentDigest, observation: sealed.observation };
}

class ScriptedRecovery implements RootStateRecoveryInterface {
  readonly calls: string[] = [];

  constructor(private readonly results: RootStateRecoveryResult[]) {}

  async recover(rootIssueId: string): Promise<RootStateRecoveryResult> {
    this.calls.push(rootIssueId);
    const result = this.results.shift();
    if (result === undefined) throw new Error("unexpected_recovery_call");
    return result;
  }
}

test("publishes recovered state before notifying convergence and excludes wake hints from authority", async () => {
  const state = recovered(status("status-1", "Todo"));
  const recovery = new ScriptedRecovery([{ kind: "recovered", state }]);
  const notifications: LinearRootRuntimeOutput[] = [];
  const holder: { runtime?: LinearRootRuntimeImpl } = {};
  const runtime = new LinearRootRuntimeImpl({
    rootIssueId: "root-1",
    recovery,
    async notifyConvergence(output) {
      assert.equal(holder.runtime?.lifecycle(), "ready");
      assert.equal(holder.runtime?.current()?.contentDigest, state.contentDigest);
      notifications.push(output);
    },
  });
  holder.runtime = runtime;

  const output = await runtime.wake("webhook");

  assert.equal(output.kind, "recovered");
  assert.ok(Object.isFrozen(output));
  assert.deepEqual(notifications, [output]);
  assert.deepEqual(recovery.calls, ["root-1"]);
  assert.equal(JSON.stringify(output).includes("webhook"), false);
});

test("publishes zero-change and one atomic multi-change batch", async () => {
  const initial = recovered(status("status-1", "Todo"), status("status-old", "Old"));
  const changed = recovered(status("status-1", "Planning"), status("status-new", "New"));
  const recovery = new ScriptedRecovery([
    { kind: "recovered", state: initial },
    { kind: "recovered", state: initial },
    { kind: "recovered", state: changed },
  ]);
  const notifications: LinearRootRuntimeOutput[] = [];
  const runtime = new LinearRootRuntimeImpl({ rootIssueId: "root-1", recovery, notifyConvergence(output) { notifications.push(output); } });

  assert.equal((await runtime.wake("poll")).kind, "recovered");
  const unchanged = await runtime.wake("process");
  const change = await runtime.wake("poll");

  assert.deepEqual(unchanged, { kind: "unchanged", contentDigest: initial.contentDigest });
  assert.equal(change.kind, "changed");
  if (change.kind !== "changed") return;
  assert.deepEqual(change.batch.changes.map(({ kind }) => kind), ["replacement", "current_value", "tombstone"]);
  assert.equal(runtime.current()?.contentDigest, changed.contentDigest);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1], change);
});

test("concurrent wake hints serialize complete recoveries", async () => {
  const state = recovered(status("status-1", "Todo"));
  const releases: Array<() => void> = [];
  let active = 0;
  let maximumActive = 0;
  const recovery: RootStateRecoveryInterface = {
    async recover() {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { kind: "recovered", state };
    },
  };
  const runtime = new LinearRootRuntimeImpl({ rootIssueId: "root-1", recovery, notifyConvergence() {} });

  const outputs = [runtime.wake("poll"), runtime.wake("webhook"), runtime.wake("process")];
  await waitFor(() => releases.length === 1);
  releases.shift()!();
  await waitFor(() => releases.length === 1);
  releases.shift()!();
  await waitFor(() => releases.length === 1);
  releases.shift()!();

  assert.deepEqual((await Promise.all(outputs)).map(({ kind }) => kind), ["recovered", "unchanged", "unchanged"]);
  assert.equal(maximumActive, 1);
});

test("reconnect invalidates a late recovery and the next wake performs a fresh bootstrap", async () => {
  const stale = recovered(status("status-1", "Stale"));
  const fresh = recovered(status("status-1", "Fresh"));
  let release!: () => void;
  const firstRead = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const recovery: RootStateRecoveryInterface = {
    async recover() {
      calls += 1;
      if (calls === 1) await firstRead;
      return { kind: "recovered", state: calls === 1 ? stale : fresh };
    },
  };
  const runtime = new LinearRootRuntimeImpl({ rootIssueId: "root-1", recovery, notifyConvergence() {} });
  const old = runtime.wake("poll");
  await waitFor(() => runtime.lifecycle() === "recovering");

  runtime.invalidateForReconnect();
  release();

  assert.deepEqual(await old, {
    kind: "recovery_required",
    failure: { code: "root_runtime_generation_invalidated", category: "runtime", retryable: true },
  });
  assert.equal(runtime.lifecycle(), "recovery_required");
  assert.equal(runtime.current(), undefined);
  assert.equal((await runtime.wake("process")).kind, "recovered");
  assert.equal(runtime.current()?.contentDigest, fresh.contentDigest);
});

test("stop fences late recovery and recovery failure discards current authority", async () => {
  const state = recovered(status("status-1", "Todo"));
  const failed: RootStateRecoveryResult = {
    kind: "failed",
    failure: { code: "root_linear_coverage_incomplete", category: "coverage", retryable: true },
  };
  const recovery = new ScriptedRecovery([{ kind: "recovered", state }, failed]);
  const runtime = new LinearRootRuntimeImpl({ rootIssueId: "root-1", recovery, notifyConvergence() {} });
  await runtime.wake("poll");
  const output = await runtime.wake("poll");
  assert.deepEqual(output, { kind: "recovery_required", failure: failed.failure });
  assert.equal(runtime.current(), undefined);

  let release!: () => void;
  const delayed: RootStateRecoveryInterface = {
    async recover() {
      await new Promise<void>((resolve) => { release = resolve; });
      return { kind: "recovered", state };
    },
  };
  const stopped = new LinearRootRuntimeImpl({ rootIssueId: "root-1", recovery: delayed, notifyConvergence() {} });
  const late = stopped.wake("poll");
  await waitFor(() => stopped.lifecycle() === "recovering" && release !== undefined);
  stopped.stop();
  release();
  assert.equal((await late).kind, "recovery_required");
  assert.equal(stopped.lifecycle(), "stopped");
  assert.equal(stopped.current(), undefined);
  assert.equal((await stopped.wake("poll")).kind, "recovery_required");
});

test("reconnect also fences a recovery whose convergence notification is still pending", async () => {
  const state = recovered(status("status-1", "Todo"));
  let release!: () => void;
  const notified = new Promise<void>((resolve) => { release = resolve; });
  let notificationStarted = false;
  const runtime = new LinearRootRuntimeImpl({
    rootIssueId: "root-1",
    recovery: new ScriptedRecovery([{ kind: "recovered", state }]),
    async notifyConvergence() {
      notificationStarted = true;
      await notified;
    },
  });
  const pending = runtime.wake("webhook");
  await waitFor(() => notificationStarted);

  runtime.invalidateForReconnect();
  release();

  assert.equal((await pending).kind, "recovery_required");
  assert.equal(runtime.lifecycle(), "recovery_required");
  assert.equal(runtime.current(), undefined);
});

test("only an applied matching targeted read-back batch advances current state", async () => {
  const initial = recovered(status("status-1", "Todo"));
  const target = recovered(status("status-1", "In Progress"));
  const recovery = new ScriptedRecovery([{ kind: "recovered", state: initial }]);
  const notifications: LinearRootRuntimeOutput[] = [];
  const runtime = new LinearRootRuntimeImpl({
    rootIssueId: "root-1",
    recovery,
    notifyConvergence(output) { notifications.push(output); },
  });
  await runtime.wake("poll");

  const notApplied = await runtime.observeMutation({ kind: "not_applied" });
  const batch = diff.calculate(initial, target.observation, initial.contentDigest);
  const applied = await runtime.observeMutation(appliedOutcome(batch));

  assert.deepEqual(notApplied, { kind: "unchanged", contentDigest: initial.contentDigest });
  assert.equal(applied.kind, "changed");
  assert.equal(runtime.current()?.contentDigest, target.contentDigest);
  assert.equal(recovery.calls.length, 1);
  assert.equal(notifications.length, 2);
});

for (const kind of ["acceptance_unknown", "precondition_failed", "readback_mismatch"] as const) {
  test(`${kind} discards current state and performs complete fresh recovery`, async () => {
    const initial = recovered(status("status-1", "Todo"));
    const fresh = recovered(status("status-1", "Fresh"));
    const recovery = new ScriptedRecovery([
      { kind: "recovered", state: initial },
      { kind: "recovered", state: fresh },
    ]);
    const runtime = new LinearRootRuntimeImpl({ rootIssueId: "root-1", recovery, notifyConvergence() {} });
    await runtime.wake("poll");

    const output = await runtime.observeMutation({ kind });

    assert.equal(output.kind, "recovered");
    assert.equal(runtime.current()?.contentDigest, fresh.contentDigest);
    assert.deepEqual(recovery.calls, ["root-1", "root-1"]);
  });
}

test("invalid applied read-back and partial multi-effect uncertainty recover native progress without command replay", async () => {
  const initial = recovered(status("status-1", "Todo"));
  const firstEffect = recovered(status("status-1", "In Progress"));
  const nativeAfterSecond = recovered(status("status-1", "Done"));
  const recovery = new ScriptedRecovery([
    { kind: "recovered", state: initial },
    { kind: "recovered", state: nativeAfterSecond },
  ]);
  const runtime = new LinearRootRuntimeImpl({ rootIssueId: "root-1", recovery, notifyConvergence() {} });
  await runtime.wake("poll");
  const firstBatch = diff.calculate(initial, firstEffect.observation, initial.contentDigest);
  assert.equal((await runtime.observeMutation(appliedOutcome(firstBatch))).kind, "changed");

  const outcome: NativeEffectObservationOutcome = { kind: "acceptance_unknown" };
  const recoveredProgress = await runtime.observeMutation(outcome);

  assert.equal(recoveredProgress.kind, "recovered");
  assert.equal(runtime.current()?.contentDigest, nativeAfterSecond.contentDigest);
  assert.deepEqual(Object.keys(outcome), ["kind"]);

  const wrongBase = { ...firstBatch, baseDigest: "sha256:wrong" };
  const invalidRecovery = new ScriptedRecovery([
    { kind: "recovered", state: initial },
    { kind: "recovered", state: nativeAfterSecond },
  ]);
  const invalidRuntime = new LinearRootRuntimeImpl({ rootIssueId: "root-1", recovery: invalidRecovery, notifyConvergence() {} });
  await invalidRuntime.wake("poll");
  assert.equal((await invalidRuntime.observeMutation(appliedOutcome(wrongBase))).kind, "recovered");
  assert.equal(invalidRuntime.current()?.contentDigest, nativeAfterSecond.contentDigest);
});

test("an applied outcome cannot smuggle changes for more than its one targeted identity", async () => {
  const initial = recovered(status("status-1", "Todo"), status("status-2", "Todo"));
  const target = recovered(status("status-1", "Done"), status("status-2", "Done"));
  const recovery = new ScriptedRecovery([
    { kind: "recovered", state: initial },
    { kind: "recovered", state: target },
  ]);
  const runtime = new LinearRootRuntimeImpl({ rootIssueId: "root-1", recovery, notifyConvergence() {} });
  await runtime.wake("poll");
  const readBack = diff.calculate(initial, target.observation, initial.contentDigest);

  const output = await runtime.observeMutation({
    kind: "applied",
    targetIdentity: { sourceKind: "linear_status", sourceId: "status-1" },
    readBack,
  });

  assert.equal(output.kind, "recovered");
  assert.equal(runtime.current()?.contentDigest, target.contentDigest);
});

function appliedOutcome(
  readBack: Parameters<CanonicalObservationDiffPolicyImpl["applyBatch"]>[1],
): Extract<NativeEffectObservationOutcome, { kind: "applied" }> {
  const change = readBack.changes[0];
  assert.ok(change);
  return {
    kind: "applied",
    targetIdentity: change.kind === "tombstone" ? change.identity : change.fact.identity,
    readBack,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition_not_reached");
}
