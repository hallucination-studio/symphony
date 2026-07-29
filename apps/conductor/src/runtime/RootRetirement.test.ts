import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseObservationDigest,
  parseRepositoryId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseThreadId,
  type RootIssueId,
} from "../contracts/identity.js";
import type { LinearObservation } from "../contracts/observation.js";
import type { RootToolCall } from "../contracts/root-interaction.js";
import type { RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface } from "../linear/api/LinearGatewayInterface.js";
import type {
  RootReconcillFactoryInput,
  RootReconcillFactoryInterface,
  RootReconcillInterface,
} from "../root-reconcill/api/RootReconcillInterface.js";
import { RootHomeManager } from "../root-reconcill/internal/RootHome.js";
import type { RuntimeEvent } from "../runtime-logs/StructuredLogger.js";
import { RootRetirement } from "./RootRetirement.js";
import type { RootToolExecutor, RootToolsFactoryInterface } from "./RootRuntime.js";
import { RootRuntimeRegistry } from "./RootRuntimeRegistry.js";

function workspace(rootId: RootIssueId): RootWorkspaceIdentity {
  return {
    root_id: rootId,
    repository_id: parseRepositoryId(`repo:${rootId}`),
    base_branch: "main",
    head_branch: `symphony/${rootId}`,
  };
}

function toolCall(rootId: RootIssueId): RootToolCall {
  return {
    schema_version: 1,
    kind: "tool",
    tool: "plan",
    root_id: rootId,
    runtime_generation: parseRuntimeGeneration(1),
    correlation_id: parseCorrelationId(`${rootId}:late-tool`),
    cycle_issue_id: parseCycleIssueId(`${rootId}:cycle`),
  };
}

interface RootControl {
  readonly events: string[];
  acceptingLateOutput: boolean;
  failClose: boolean;
  releaseClose: (() => void) | null;
  closeGate: Promise<void>;
}

class ProcessRootFactory implements RootReconcillFactoryInterface {
  readonly controls = new Map<RootIssueId, RootControl>();

  holdClose(rootId: RootIssueId): void {
    const control = this.controls.get(rootId);
    if (!control) throw new Error("missing_root_control");
    control.closeGate = new Promise<void>((resolve) => { control.releaseClose = resolve; });
  }

  failClose(rootId: RootIssueId): void {
    const control = this.controls.get(rootId);
    if (!control) throw new Error("missing_root_control");
    control.failClose = true;
  }

  emitLate(rootId: RootIssueId): boolean {
    const control = this.controls.get(rootId);
    if (!control) throw new Error("missing_root_control");
    if (!control.acceptingLateOutput) return false;
    control.events.push("late_output_accepted");
    return true;
  }

  async create(input: RootReconcillFactoryInput): Promise<RootReconcillInterface> {
    const control: RootControl = {
      events: [],
      acceptingLateOutput: true,
      failClose: false,
      releaseClose: null,
      closeGate: Promise.resolve(),
    };
    this.controls.set(input.root_id, control);
    return {
      rootId: input.root_id,
      runtimeGeneration: input.runtime_generation,
      bootstrap: () => Promise.reject(new Error("unexpected_bootstrap")),
      advance: () => Promise.reject(new Error("unexpected_advance")),
      close: async () => {
        control.acceptingLateOutput = false;
        control.events.push("turn_fenced");
        await control.closeGate;
        if (control.failClose) throw new Error("sensitive_process_failure");
        control.events.push("process_stopped");
      },
    };
  }
}

class ProcessToolsFactory implements RootToolsFactoryInterface {
  create(): RootToolExecutor {
    return {
      execute: () => Promise.reject(new Error("raw_tool_called")),
    };
  }
}

async function exists(value: string): Promise<boolean> {
  try { await access(value); return true; } catch { return false; }
}

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-retirement-"));
  const programData = path.join(temporary, "program");
  const performerHome = path.join(temporary, "performer");
  await Promise.all([mkdir(programData), mkdir(performerHome)]);
  const performerMarker = path.join(performerHome, "owner.txt");
  await writeFile(performerMarker, "performer\n", "utf8");
  const homes = await RootHomeManager.create(programData, performerHome);
  const firstId = parseRootIssueId("LIN-1");
  const secondId = parseRootIssueId("LIN-2");
  for (const [rootId, thread] of [[firstId, "thread:1"], [secondId, "thread:2"]] as const) {
    const home = await homes.open(rootId);
    await home.continuity.write({
      schema_version: 1,
      root_id: rootId,
      runtime_generation: parseRuntimeGeneration(1),
      thread_id: parseThreadId(thread),
      accepted_observation_digest: parseObservationDigest(`digest:${rootId}`),
      in_flight_correlation: null,
    });
  }
  const roots = new ProcessRootFactory();
  const registry = new RootRuntimeRegistry(homes, roots, new ProcessToolsFactory());
  const firstRuntime = await registry.create({
    root_id: firstId, runtime_generation: parseRuntimeGeneration(1), workspace: workspace(firstId),
  });
  const secondRuntime = await registry.create({
    root_id: secondId, runtime_generation: parseRuntimeGeneration(1), workspace: workspace(secondId),
  });
  const observations = new Map<RootIssueId, LinearObservation>([
    [firstId, { root_id: firstId, root_status: "In Review", active_cycle: null }],
    [secondId, { root_id: secondId, root_status: "Done", active_cycle: null }],
  ]);
  const linear: LinearGatewayInterface = {
    discoverRoots: () => Promise.reject(new Error("unexpected_discovery")),
    readRoot: (rootId) => {
      const observation = observations.get(rootId);
      return observation ? Promise.resolve(observation) : Promise.reject(new Error("missing_observation"));
    },
    mutate: () => Promise.reject(new Error("unexpected_mutation")),
  };
  const events: RuntimeEvent[] = [];
  const retirement = new RootRetirement(linear, registry, homes, { publish: (event) => events.push(event) });
  return {
    homes, registry, roots, observations, retirement, events,
    firstId, secondId, firstRuntime, secondRuntime, performerMarker,
  };
}

test("fresh In Review retains its runtime and fresh Done retires only the matching Root after all fences close", async () => {
  const f = await fixture();
  const retained = await f.retirement.retireIfDone(f.firstId);
  assert.equal(retained.kind, "retained_in_review");
  assert.equal(f.registry.has(f.firstId), true);
  assert.equal(await exists(f.homes.pathFor(f.firstId)), true);

  f.roots.holdClose(f.secondId);
  const retiring = f.retirement.retireIfDone(f.secondId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.roots.controls.get(f.secondId)?.events, ["turn_fenced"]);
  await assert.rejects(f.secondRuntime.tools.execute(toolCall(f.secondId)), /root_tools_closed/u);
  assert.equal(f.roots.emitLate(f.secondId), false);
  assert.equal(f.registry.has(f.secondId), true);
  assert.equal(await exists(f.homes.pathFor(f.secondId)), true);

  f.roots.controls.get(f.secondId)?.releaseClose?.();
  const retired = await retiring;
  assert.equal(retired.kind, "retired");
  assert.deepEqual(f.roots.controls.get(f.secondId)?.events, ["turn_fenced", "process_stopped"]);
  assert.equal(f.registry.has(f.secondId), false);
  assert.equal(await exists(f.homes.pathFor(f.secondId)), false);
  assert.equal(f.registry.has(f.firstId), true);
  assert.equal(await exists(f.homes.pathFor(f.firstId)), true);
  assert.equal(await readFile(f.performerMarker, "utf8"), "performer\n");
  assert.deepEqual(f.events.map(({ event }) => event), [
    "root_retirement_started", "root_retirement_retained",
    "root_retirement_started", "root_retirement_completed",
  ]);
});

test("process shutdown failure keeps both Root Homes and permanently blocks scheduler reuse", async () => {
  const f = await fixture();
  f.observations.set(f.firstId, { root_id: f.firstId, root_status: "Done", active_cycle: null });
  f.roots.failClose(f.firstId);

  await assert.rejects(f.retirement.retireIfDone(f.firstId), /root_runtime_close_failed/u);
  assert.equal(f.retirement.state, "stopped");
  assert.equal(f.registry.has(f.firstId), true);
  assert.equal(await exists(f.homes.pathFor(f.firstId)), true);
  assert.equal(await exists(f.homes.pathFor(f.secondId)), true);
  await assert.rejects(f.retirement.retireIfDone(f.secondId), /root_retirement_not_idle/u);
  assert.deepEqual(f.events.at(-1), {
    event: "root_retirement_failed",
    correlation_id: "retirement:1",
    root_id: f.firstId,
    reason_code: "retirement_failed",
  });
});

test("mismatched Home owner is never deleted and blocks retirement of another Root", async () => {
  const f = await fixture();
  f.observations.set(f.firstId, { root_id: f.firstId, root_status: "Done", active_cycle: null });
  const continuityPath = path.join(f.homes.pathFor(f.firstId), "symphony", "state.json");
  const mismatched = JSON.parse(await readFile(continuityPath, "utf8")) as Record<string, unknown>;
  mismatched.root_id = f.secondId;
  await writeFile(continuityPath, `${JSON.stringify(mismatched)}\n`, "utf8");

  await assert.rejects(f.retirement.retireIfDone(f.firstId), /root_home_owner_mismatch/u);
  assert.equal(f.retirement.state, "stopped");
  assert.equal(await exists(f.homes.pathFor(f.firstId)), true);
  assert.equal(await exists(f.homes.pathFor(f.secondId)), true);
  assert.equal(await readFile(f.performerMarker, "utf8"), "performer\n");
  await assert.rejects(f.retirement.retireIfDone(f.secondId), /root_retirement_not_idle/u);
});

test("live-runtime guard prevents Home deletion even after a faulty close boundary", async () => {
  const f = await fixture();
  const faultyRegistry = {
    has: (rootId: RootIssueId) => f.registry.has(rootId),
    close: () => Promise.resolve(),
  };
  const retirement = new RootRetirement(
    {
      discoverRoots: () => Promise.reject(new Error("unexpected_discovery")),
      readRoot: () => Promise.resolve({ root_id: f.firstId, root_status: "Done", active_cycle: null }),
      mutate: () => Promise.reject(new Error("unexpected_mutation")),
    },
    faultyRegistry,
    f.homes,
    { publish: () => undefined },
  );

  await assert.rejects(retirement.retireIfDone(f.firstId), /root_runtime_is_live/u);
  assert.equal(await exists(f.homes.pathFor(f.firstId)), true);
  assert.equal(await exists(f.homes.pathFor(f.secondId)), true);
  assert.equal(await readFile(f.performerMarker, "utf8"), "performer\n");
});
