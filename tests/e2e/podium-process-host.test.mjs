import assert from "node:assert/strict";
import test from "node:test";

import { createE2EProcessHost } from "../../tools/e2e/podium-process-host.mjs";

test("E2E process host owns process lifecycle and relays Profile commands only to the matching live Conductor", async () => {
  const starts = [];
  const harnesses = [];
  const hostOwner = createE2EProcessHost({
    repositories: [{
      repository_handle: "repo-a",
      repository_identity: "repository-a",
      repository_display_name: "Repository A",
      repository_root: "/tmp/repository-a",
      base_branch: "main",
    }],
    async startProcess(input) {
      starts.push(input);
      const harness = {
        requests: [],
        closes: 0,
        abruptTerminates: [],
        async request(body, secret) {
          this.requests.push({ body, secret });
          return { kind: "profile_status", profile: { profile_id: "profile-a" } };
        },
        async close() { this.closes += 1; },
        async terminateAbruptly(signal) { this.abruptTerminates.push(signal); },
      };
      harnesses.push(harness);
      return harness;
    },
  });
  const repository = await hostOwner.host.resolveRepository("repo-a", "main");
  assert.deepEqual(repository, {
    repositoryHandle: "repo-a",
    repositoryIdentity: "repository-a",
    repositoryDisplayName: "Repository A",
    repositoryRoot: "/tmp/repository-a",
    baseBranch: "main",
  });

  const process = conductorInput();
  await hostOwner.host.startConductor(process);
  const secret = Buffer.from("secret", "utf8");
  const response = await hostOwner.host.relayProfile({
    kind: "get_profile_status",
    conductor_id: "conductor-a",
    profile_id: "profile-a",
  }, secret);
  assert.deepEqual(response, { kind: "profile_status", profile: { profile_id: "profile-a" } });
  assert.equal(harnesses[0].requests[0].secret, secret);

  await hostOwner.host.restartConductor("conductor-a");
  assert.deepEqual(harnesses[0].abruptTerminates, ["SIGKILL"]);
  assert.equal(harnesses[0].closes, 0);
  assert.equal(starts.length, 2);

  await hostOwner.close();
  assert.equal(harnesses[1].closes, 1);
});

test("E2E process host refuses a process without a hard termination boundary", async () => {
  const process = {
    closes: 0,
    async request() { return {}; },
    async close() { this.closes += 1; },
  };
  const hostOwner = createE2EProcessHost({
    repositories: [repository()],
    async startProcess() { return process; },
  });

  await assert.rejects(
    hostOwner.host.startConductor(conductorInput()),
    /e2e_conductor_process_invalid/u,
  );
  assert.equal(process.closes, 1);
  await hostOwner.close();
});

test("E2E process host rejects an unknown repository or Profile command target", async () => {
  const hostOwner = createE2EProcessHost({
    repositories: [{
      repository_handle: "repo-a",
      repository_identity: "repository-a",
      repository_display_name: "Repository A",
      repository_root: "/tmp/repository-a",
      base_branch: "main",
    }],
    async startProcess() { throw new Error("not_called"); },
  });
  await assert.rejects(hostOwner.host.resolveRepository("repo-a", "trunk"), /e2e_repository_selection_invalid/u);
  await assert.rejects(
    hostOwner.host.startConductor({ ...conductorInput(), repositoryHandle: "repo-missing" }),
    /e2e_repository_selection_invalid/u,
  );
  await assert.rejects(
    hostOwner.host.relayProfile({ kind: "get_profiles", conductor_id: "conductor-a" }),
    /e2e_conductor_process_missing/u,
  );
});

test("E2E process host closes a process that finishes starting after its owner closes", async () => {
  let resolveStart;
  const lateProcess = {
    closes: 0,
    async request() { return {}; },
    async close() { this.closes += 1; },
    async terminateAbruptly() {},
  };
  const hostOwner = createE2EProcessHost({
    repositories: [{
      repository_handle: "repo-a",
      repository_identity: "repository-a",
      repository_display_name: "Repository A",
      repository_root: "/tmp/repository-a",
      base_branch: "main",
    }],
    async startProcess() {
      return new Promise((resolve) => { resolveStart = () => resolve(lateProcess); });
    },
  });

  const start = hostOwner.host.startConductor(conductorInput());
  await waitFor(() => typeof resolveStart === "function");
  const close = hostOwner.close();
  resolveStart();

  await assert.rejects(start, /e2e_process_host_closed/u);
  await close;
  assert.equal(lateProcess.closes, 1);
  await assert.rejects(hostOwner.host.startConductor(conductorInput()), /e2e_process_host_closed/u);
});

function conductorInput() {
  return {
    bindingId: "binding-a",
    conductorId: "conductor-a",
    conductorShortHash: "hash-a",
    linearInstallationId: "installation-a",
    organizationId: "organization-a",
    repositoryHandle: "repo-a",
    repositoryRoot: "/tmp/repository-a",
    baseBranch: "main",
  };
}

function repository() {
  return {
    repository_handle: "repo-a",
    repository_identity: "repository-a",
    repository_display_name: "Repository A",
    repository_root: "/tmp/repository-a",
    base_branch: "main",
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("test_wait_timeout");
}
