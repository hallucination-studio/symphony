import assert from "node:assert/strict";
import test from "node:test";

import {
  provisionConductorBindings,
  startConductorProcesses,
} from "../../tools/e2e/podium-control-plane.mjs";

test("public control plane creates every Binding before it starts any Conductor process", async () => {
  const events = [];
  const client = {
    async command(body) {
      if (body.kind === "create_conductor") {
        events.push(`create:${body.repository.repository_handle}`);
        const suffix = body.repository.repository_handle.slice(-1);
        return {
          kind: "conductor_created",
          conductor_id: `conductor-${suffix}`,
          binding_id: `binding-${suffix}`,
          conductor_short_hash: `hash-${suffix}`,
          repository_identity: `repository-${suffix}`,
        };
      }
      events.push(`start:${body.conductor_id}`);
      return {
        kind: "conductor_command_completed",
        conductor_id: body.conductor_id,
        command_kind: "start_conductor",
      };
    },
  };
  const bindings = await provisionConductorBindings({
    client,
    projectId: "project-1",
    repositories: repositories(),
  });

  assert.deepEqual(events, ["create:repo-a", "create:repo-b", "create:repo-c"]);
  assert.deepEqual(bindings.map(({ conductor_id }) => conductor_id), [
    "conductor-a", "conductor-b", "conductor-c",
  ]);

  await startConductorProcesses({ client, conductors: bindings });
  assert.deepEqual(events.slice(3), [
    "start:conductor-a", "start:conductor-b", "start:conductor-c",
  ]);
});

test("public control plane rejects malformed Binding metadata before process start", async () => {
  let starts = 0;
  await assert.rejects(
    provisionConductorBindings({
      client: {
        async command(body) {
          if (body.kind === "start_conductor") starts += 1;
          return { kind: "conductor_created", conductor_id: "conductor-a" };
        },
      },
      projectId: "project-1",
      repositories: repositories(),
    }),
    /e2e_podium_conductor_creation_invalid/u,
  );
  assert.equal(starts, 0);
});

function repositories() {
  return ["a", "b", "c"].map((suffix) => ({
    repository_handle: `repo-${suffix}`,
    repository_identity: `repository-${suffix}`,
    base_branch: "main",
  }));
}
