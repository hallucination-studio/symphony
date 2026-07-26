import assert from "node:assert/strict";
import test from "node:test";

import { createConfiguredParallelBlackBoxRuntime } from "../../tools/e2e/parallel-black-box-runtime.mjs";

const now = "2026-07-26T00:00:00.000Z";

test("configured runtime owns only temporary resources and builds the exact Campaign after public control-plane readiness", async () => {
  const events = [];
  const runtime = await createConfiguredParallelBlackBoxRuntime({
    config: configuration(),
    sourceRepositoryRoot: "/source",
    resolveTargetTriple: () => "aarch64-apple-darwin",
    now: () => new Date(now),
    createCampaignId: () => "campaign-test",
    makeTemporaryDirectory: async () => "/temporary/runtime",
    makeDirectory: async (directory) => { events.push(`mkdir:${directory}`); },
    checkExecutable: async (executable) => { events.push(`executable:${executable}`); },
    removeTemporaryDirectory: async (directory) => { events.push(`remove:${directory}`); },
    provisionControlPlane: async (input) => {
      events.push("control-plane");
      assert.equal(input.sourceRepositoryRoot, "/source");
      assert.equal(input.runtime.databasePath, "/temporary/runtime/podium.db");
      assert.equal(input.runtime.conductorDataRoot, "/temporary/runtime/conductors");
      assert.equal(input.runtime.rootDeadlineAt, "2026-07-26T00:05:00.000Z");
      assert.equal(input.runtime.performerExecutable, "/source/apps/podium-desktop/src-tauri/binaries/performer-aarch64-apple-darwin");
      assert.equal("SYMPHONY_E2E_LINEAR_DEV_TOKEN" in input.runtime.environment, false);
      assert.equal(typeof input.runtime.linearPhysicalRequestGate.beforePhysicalRequest, "function");
      return {
        project_id: "project-1",
        conductors: [conductor("a"), conductor("b"), conductor("c")],
        async close() { events.push("control-plane-close"); },
      };
    },
  });

  assert.deepEqual(runtime.command, {
    version: 1,
    campaign_id: "campaign-test",
    project_id: "project-1",
    started_at: now,
    deadline_at: "2026-07-26T00:05:00.000Z",
    conductors: [conductor("a"), conductor("b"), conductor("c")],
    cases: [
      caseDefinition("cross_conductor_happy_paths", "approve_plan", "happy_path", ["conductor-a", "conductor-b"]),
      caseDefinition("same_conductor_preemption", "preempt_same_priority", "same_conductor_preemption", ["conductor-a"]),
      caseDefinition("plan_rejection_and_supersession", "reject_plan", "plan_rejection_supersession", ["conductor-a"]),
      caseDefinition("root_revision_and_comment", "revise_root", "root_revision_comment", ["conductor-a"]),
      caseDefinition("conductor_restart_isolation", "restart_conductor", "restart_isolation", ["conductor-c", "conductor-a", "conductor-b"]),
      caseDefinition("cycle_exhaustion_and_successor", "exhaust_cycle_budget", "cycle_successor", ["conductor-a"]),
      caseDefinition("delivery_and_review", "deliver_and_review", "delivery_review", ["conductor-a"]),
      caseDefinition("required_linear_write_fail_closed", "required_write_outage", "required_write_fail_closed", ["conductor-a"]),
    ],
  });
  assert.deepEqual(events, [
    "executable:/source/apps/podium-desktop/src-tauri/binaries/performer-aarch64-apple-darwin",
    "mkdir:/temporary/runtime/conductors",
    "control-plane",
  ]);

  await runtime.close();
  await runtime.close();
  assert.deepEqual(events.slice(-2), ["control-plane-close", "remove:/temporary/runtime"]);
});

test("configured runtime removes its temporary root when public control-plane provisioning fails", async () => {
  const events = [];
  await assert.rejects(
    createConfiguredParallelBlackBoxRuntime({
      config: configuration(),
      sourceRepositoryRoot: "/source",
      makeTemporaryDirectory: async () => "/temporary/runtime",
      makeDirectory: async () => {},
      checkExecutable: async () => {},
      removeTemporaryDirectory: async (directory) => { events.push(`remove:${directory}`); },
      provisionControlPlane: async () => { throw new Error("external failure"); },
    }),
    (error) => error.code === "parallel_black_box_runtime_control_plane_failed",
  );
  assert.deepEqual(events, ["remove:/temporary/runtime"]);
});

test("configured runtime preserves a closed control-plane phase failure", async () => {
  const events = [];
  await assert.rejects(
    createConfiguredParallelBlackBoxRuntime({
      config: configuration(),
      sourceRepositoryRoot: "/source",
      makeTemporaryDirectory: async () => "/temporary/runtime",
      makeDirectory: async () => {},
      checkExecutable: async () => {},
      removeTemporaryDirectory: async (directory) => { events.push(`remove:${directory}`); },
      provisionControlPlane: async () => {
        const error = new Error("untrusted upstream detail");
        error.code = "parallel_black_box_control_plane_binding_project_pool_routing_conflict";
        throw error;
      },
    }),
    (error) => error.code === "parallel_black_box_control_plane_binding_project_pool_routing_conflict" &&
      !error.message.includes("upstream detail"),
  );
  assert.deepEqual(events, ["remove:/temporary/runtime"]);
});

test("configured runtime removes its temporary root when an invalid public control plane cannot close", async () => {
  const events = [];
  await assert.rejects(
    createConfiguredParallelBlackBoxRuntime({
      config: configuration(),
      sourceRepositoryRoot: "/source",
      makeTemporaryDirectory: async () => "/temporary/runtime",
      makeDirectory: async () => {},
      checkExecutable: async () => {},
      removeTemporaryDirectory: async (directory) => { events.push(`remove:${directory}`); },
      provisionControlPlane: async () => ({
        project_id: "project-1",
        conductors: [],
        async close() {
          events.push("control-plane-close");
          throw new Error("close failed");
        },
      }),
    }),
    (error) => error.code === "parallel_black_box_runtime_control_plane_invalid",
  );
  assert.deepEqual(events, ["control-plane-close", "remove:/temporary/runtime"]);
});

test("configured runtime accepts public opaque identifiers that begin with digits", async () => {
  const conductors = [
    opaqueConductor("1"),
    opaqueConductor("2"),
    opaqueConductor("3"),
  ];
  const runtime = await createConfiguredParallelBlackBoxRuntime({
    config: configuration(),
    sourceRepositoryRoot: "/source",
    resolveTargetTriple: () => "aarch64-apple-darwin",
    now: () => new Date(now),
    createCampaignId: () => "campaign-test",
    makeTemporaryDirectory: async () => "/temporary/runtime",
    makeDirectory: async () => {},
    checkExecutable: async () => {},
    removeTemporaryDirectory: async () => {},
    provisionControlPlane: async () => ({
      project_id: "1a2b3c4d-5678-90ab-cdef-1234567890ab",
      conductors,
      async close() {},
    }),
  });

  assert.equal(runtime.command.project_id, "1a2b3c4d-5678-90ab-cdef-1234567890ab");
  assert.deepEqual(runtime.command.conductors, conductors);
  await runtime.close();
});

function configuration() {
  return {
    linear: { clientId: "client-id", projectSlugId: "project-slug", setupAuthorized: true },
    secrets: {
      linearDevToken: "symphony-token",
      linearHumanApiKey: "human-token",
      linearClientSecret: "client-secret",
      codexApiKey: "codex-key",
    },
    codex: { baseUrl: "https://codex.example.test", model: "gpt-5-codex" },
  };
}

function conductor(suffix) {
  return {
    binding_id: `binding-${suffix}`,
    conductor_id: `conductor-${suffix}`,
    conductor_short_hash: `abcdef1234${suffix}${suffix}`,
    repository_identity: `repository-${suffix}`,
  };
}

function opaqueConductor(prefix) {
  return {
    binding_id: `${prefix}a2b3c4d-5678-90ab-cdef-1234567890ab`,
    conductor_id: `${prefix}b2c3d4e-5678-90ab-cdef-1234567890ab`,
    conductor_short_hash: `abcdef1234${prefix}${prefix}`,
    repository_identity: `${prefix}repo-identity`,
  };
}

function caseDefinition(case_id, human_script_id, evidence_predicate_id, routed_conductor_ids) {
  return {
    case_id,
    mandatory: true,
    routed_conductor_ids,
    deadline_at: "2026-07-26T00:05:00.000Z",
    human_script_id,
    evidence_predicate_id,
  };
}
