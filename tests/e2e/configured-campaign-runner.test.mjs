import assert from "node:assert/strict";
import test from "node:test";

import { createMandatoryParallelBlackBoxCases } from "../../tools/e2e/parallel-black-box-contract.mjs";
import { runConfiguredParallelBlackBoxE2ECampaign } from "../../tools/e2e/target-architecture.mjs";

test("configured Campaign runner assembles verified public boundaries and closes its temporary runtime", async () => {
  const events = [];
  const command = campaignCommand();
  const result = campaignResult(command);
  const human = {
    async readActorId() { return "human-actor"; },
    async readSymphonyActorId() { return "symphony-actor"; },
    async clearE2EProjectIssues(input) {
      events.push({ kind: "cleanup", input });
      return { project_id: "project-1" };
    },
    async discoverProjectRouting(input) {
      events.push({ kind: "routing", input });
      return routing();
    },
  };
  const runtime = runtimeOwner(command, events);

  const execution = await runConfiguredParallelBlackBoxE2ECampaign({
    environment: { configured: "yes" },
    loadConfig: ({ environment }) => {
      events.push({ kind: "config", environment });
      return configuration();
    },
    createVerifiedActors: async (input) => {
      events.push({ kind: "actors", input });
      return { human };
    },
    createRuntime: async (input) => {
      events.push({ kind: "runtime", input });
      return runtime;
    },
    createCampaignPorts: (input) => {
      events.push({ kind: "ports", input });
      return { public: "ports" };
    },
    runCampaign: async (input) => {
      events.push({ kind: "campaign", input });
      return result;
    },
    readFreshEvidenceSnapshot: async (input) => {
      events.push({ kind: "fresh", input });
      return { kind: "incomplete" };
    },
  });

  assert.deepEqual(execution, { command, result });
  assert.deepEqual(events.map(({ kind }) => kind), ["config", "actors", "cleanup", "runtime", "routing", "ports", "campaign", "close"]);
  assert.deepEqual(events[1].input, {
    symphonyAccessToken: "symphony-token",
    humanApiKey: "human-token",
  });
  assert.deepEqual(events[2].input, { project_slug_id: "project-1" });
  assert.equal(events[4].input.project_id, "project-1");
  assert.deepEqual(events[4].input.conductor_short_hashes, ["abcdef123456", "abcdef123457", "abcdef123458"]);
  assert.equal(events[5].input.human, human);
  assert.equal(events[5].input.project_id, "project-1");
  assert.equal(events[5].input.restart_conductor, runtime.control_plane.restartConductor);
  assert.equal(events[5].input.required_write_outage, runtime.required_write_outage);
  assert.equal(typeof events[5].input.readFreshEvidenceSnapshot, "function");
  assert.deepEqual(events[6].input, { command, ports: { public: "ports" } });

  await events[5].input.readFreshEvidenceSnapshot({
    root_issue_ids: ["root-1"],
    repository_contexts: runtime.control_plane.repository_contexts,
  });
  assert.deepEqual(events[8], {
    kind: "fresh",
    input: {
      root_issue_ids: ["root-1"],
      repository_contexts: runtime.control_plane.repository_contexts,
      linear_api_key: "human-token",
    },
  });
});

test("configured Campaign runner never creates a runtime when the pre-run Project cleanup fails", async () => {
  const events = [];

  await assert.rejects(
    runConfiguredParallelBlackBoxE2ECampaign({
      loadConfig: () => configuration(),
      createVerifiedActors: async () => ({
        human: {
          async clearE2EProjectIssues() {
            events.push({ kind: "cleanup" });
            throw new Error("cleanup unavailable");
          },
        },
      }),
      createRuntime: async () => {
        events.push({ kind: "runtime" });
        return runtimeOwner(campaignCommand(), events);
      },
    }),
    /cleanup unavailable/u,
  );

  assert.deepEqual(events, [{ kind: "cleanup" }]);
});

test("configured Campaign runner closes its runtime when public routing cannot be discovered", async () => {
  const events = [];

  await assert.rejects(
    runConfiguredParallelBlackBoxE2ECampaign({
      loadConfig: () => configuration(),
      createVerifiedActors: async () => ({
        human: {
          async clearE2EProjectIssues() { return { project_id: "project-1" }; },
          async discoverProjectRouting() { throw new Error("routing unavailable"); },
        },
      }),
      createRuntime: async () => runtimeOwner(campaignCommand(), events),
      createCampaignPorts: () => { throw new Error("must not create ports"); },
      runCampaign: async () => { throw new Error("must not run Campaign"); },
    }),
    /routing unavailable/u,
  );

  assert.deepEqual(events, [{ kind: "close" }]);
});

function configuration() {
  return {
    secrets: {
      linearDevToken: "symphony-token",
      linearHumanApiKey: "human-token",
      linearClientSecret: "client-secret",
      codexApiKey: "codex-key",
    },
    linear: { clientId: "client-id", projectSlugId: "project-1", setupAuthorized: true },
    codex: { baseUrl: "https://codex.example.test", model: "gpt-5-codex" },
  };
}

function campaignCommand() {
  const conductors = ["a", "b", "c"].map((suffix) => ({
    binding_id: `binding-${suffix}`,
    conductor_id: `conductor-${suffix}`,
    conductor_short_hash: `abcdef12345${suffix === "a" ? "6" : suffix === "b" ? "7" : "8"}`,
    repository_identity: `repository-${suffix}`,
  }));
  return {
    version: 1,
    campaign_id: "campaign-1",
    project_id: "project-1",
    started_at: "2026-07-26T00:00:00.000Z",
    deadline_at: "2026-07-26T00:05:00.000Z",
    conductors,
    cases: createMandatoryParallelBlackBoxCases({
      conductor_ids: conductors.map(({ conductor_id: conductorId }) => conductorId),
      deadline_at: "2026-07-26T00:05:00.000Z",
    }),
  };
}

function campaignResult(command) {
  return {
    version: 1,
    campaign_id: command.campaign_id,
    cases: command.cases.map(({ case_id: caseId }) => ({
      case_id: caseId,
      status: "passed",
      reason_code: "confirmed",
      evidence_refs: [`linear:${caseId}`],
      observed_at: "2026-07-26T00:05:00.000Z",
    })),
    durable_overlap_evidence_refs: ["linear:root-1", "git:repository-a"],
  };
}

function runtimeOwner(command, events) {
  return {
    command,
    control_plane: {
      repository_contexts: ["a", "b", "c"].map((suffix) => ({
        repository_identity: `repository-${suffix}`,
        repository_root: `/repo/${suffix}`,
        base_branch: "main",
      })),
      async restartConductor() {},
    },
    required_write_outage: { arm() {}, async waitUntilBlocked() {}, restore() {} },
    async close() { events.push({ kind: "close" }); },
  };
}

function routing() {
  return {
    team_id: "team-1",
    routing_labels: [
      { conductor_short_hash: "abcdef123456", label_id: "label-a" },
      { conductor_short_hash: "abcdef123457", label_id: "label-b" },
      { conductor_short_hash: "abcdef123458", label_id: "label-c" },
    ],
  };
}
