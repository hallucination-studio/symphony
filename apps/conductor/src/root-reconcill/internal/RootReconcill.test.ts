import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, open, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type {
  CodexProcessLaunch,
  CodexSpawner,
  SpawnedCodexProcess,
} from "../../codex-app-server/internal/CodexProcess.js";
import { JsonlFrameDecoder } from "../../codex-app-server/internal/JsonlPeer.js";
import {
  parseObservationDigest,
  parseRepositoryId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseTaskIssueId,
  parseThreadId,
} from "../../contracts/identity.js";
import { deriveCycleUuid } from "../../contracts/cycle-identities.js";
import {
  parseGitSnapshot,
  parseRootBootstrap,
  parseRootFactDiff,
  parseTaskSnapshot,
  type RootBootstrap,
  type RootFactDiff,
} from "../../contracts/observation.js";
import { rootObservationDigest } from "../../observation/RootObservationFacts.js";
import { RootTools, type DeclaredRootTool } from "../../runtime/RootTools.js";
import {
  bindRootTaskManageCommand,
  RootTaskManageCommandBinding,
} from "../../runtime/RootTaskManageCommand.js";
import { createAcceptedRevisionAuthority } from "../../runtime/RootAcceptedRevision.js";
import type { RootToolBinding, RootToolSpec } from "../../runtime/RootToolBoundary.js";
import type { TaskManageCommandInterface } from "../../task-management/api/TaskManageCommandInterface.js";
import type { LinearIssueRecordComment } from "../../task-management/linear/LinearQueries.js";
import {
  createTaskManageCallerAuthority,
  parseTaskWorkflowIdentities,
} from "../../task-management/api/TaskManageCapability.js";
import {
  TASK_MCP_CAPABILITIES,
  parseTaskMcpResult,
  type UpdateIssueCall,
  type UpdateIssueResult,
} from "../../task-management/mcp/TaskMcpSchemas.js";
import { RootContinuityStore } from "./RootContinuityStore.js";
import {
  CodexRootTurnTransportFactory,
  RootReconcillFactory,
  type RootReconcillLog,
  type RootReconcillToolSet,
  type RootReconcillToolSetFactory,
  type RootTurnRequest,
  type RootTurnTransport,
  type RootTurnTransportFactory,
  type RootTurnTransportResult,
} from "./RootReconcill.js";

const rootId = parseRootIssueId("LIN-1");
const generation = parseRuntimeGeneration(1);
const workflow = parseTaskWorkflowIdentities({
  labels: {
    root: "label:root", cycle: "label:cycle", plan: "label:plan",
    work: "label:work", verify: "label:verify",
  },
  cycle_states: {
    draft: "state:draft", in_progress: "state:cycle-in-progress",
    awaiting_acceptance: "state:awaiting-acceptance", succeeded: "state:succeeded",
    rejected: "state:rejected", failed: "state:cycle-failed", canceled: "state:cycle-canceled",
  },
  stage_states: {
    todo: "state:stage-todo", in_progress: "state:stage-in-progress", done: "state:stage-done",
    failed: "state:stage-failed", canceled: "state:stage-canceled",
  },
});
const callerAuthority = createTaskManageCallerAuthority();
const acceptedRevisionAuthority = createAcceptedRevisionAuthority();

const reconciledRootDescription = [
  "# Root",
  "",
  "## Requirement",
  "",
  "Build the Root runtime.",
  "",
  "- Authorized: define the Root, review and correct one Cycle Draft, then approve its exact revision.",
  "- Required consequences: preserve fresh Task Manager facts and return the approval seal digest.",
  "- Out of scope: Cycle execution, acceptance, delivery, migrations, and compatibility behavior.",
  "",
  "## Domain Knowledge",
  "",
  "- Fresh Task Manager Markdown and structured Issue facts are authoritative.",
  "- Transcript, repository search output, and temporary reasoning are ephemeral.",
  "",
  "## Root ADR",
  "",
  "Decision: keep semantic decisions at the Root boundary and mechanical execution in Conductor.",
  "",
  "Rationale: only Root Reconcill owns requirement and design interpretation.",
  "",
  "Constraints: Root has code-read-only authority and may mutate only Root or Draft Markdown before approval.",
  "",
  "Consequences: an approved Cycle is immutable and later changes require a terminal successor.",
  "",
  "## Acceptance",
  "",
  "- Define persists every closed Root section and reads the exact Root revision back.",
  "- Draft review reads and corrects the complete copied Root snapshot and design.",
  "- Approval changes only the reviewed exact Draft to In Progress and returns its seal digest.",
].join("\n");
const concurrentRootDescription = reconciledRootDescription.replace(
  "Build the Root runtime.",
  "Build the concurrently revised Root runtime.",
);
const cycleDraftDescription = [
  "# Cycle Draft",
  "",
  "## Root Definition Revision",
  "",
  "`revision:root:2`",
  "",
  "## Requirement",
  "",
  "Build the Root runtime.",
  "",
  "- Authorized: define the Root, review and correct one Cycle Draft, then approve its exact revision.",
  "- Required consequences: preserve fresh Task Manager facts and return the approval seal digest.",
  "- Out of scope: Cycle execution, acceptance, delivery, migrations, and compatibility behavior.",
  "",
  "## Domain Knowledge",
  "",
  "- Fresh Task Manager Markdown and structured Issue facts are authoritative.",
  "- Transcript, repository search output, and temporary reasoning are ephemeral.",
  "",
  "## Root ADR",
  "",
  "Decision: keep semantic decisions at the Root boundary and mechanical execution in Conductor.",
  "",
  "Rationale: only Root Reconcill owns requirement and design interpretation.",
  "",
  "Constraints: Root has code-read-only authority and may mutate only Root or Draft Markdown before approval.",
  "",
  "Consequences: an approved Cycle is immutable and later changes require a terminal successor.",
  "",
  "## Acceptance",
  "",
  "- Define persists every closed Root section and reads the exact Root revision back.",
  "- Draft review reads and corrects the complete copied Root snapshot and design.",
  "- Approval changes only the reviewed exact Draft to In Progress and returns its seal digest.",
  "",
  "## Architecture",
  "",
  "Root Reconcill owns semantic Define and Draft approval; Task Manager owns durable Markdown and exact revisions.",
  "Conductor receives authority only after the one-way In Progress transition and cannot reinterpret the design.",
  "",
  "## Feature Design",
  "",
  "Define persists the full Root document, creates one Draft, reviews every copied and designed section,",
  "corrects only Draft Markdown, re-reads it, and approves that exact revision once.",
  "",
  "## Code Design",
  "",
  "Validate closed Markdown and exact revisions at the Root boundary.",
  "Derive the seal only from the applied In Progress fresh resource and expose it only on the Root tool result.",
  "",
  "## Boundaries",
  "",
  "Authorized changes are Root definition, one Draft creation, Draft-only description correction, and exact approval.",
  "Stage creation, execution, acceptance, delivery, migrations, and post-approval specification edits are excluded.",
  "",
  "## Acceptance Mapping",
  "",
  "- Root sections: assert the applied Root resource and subsequent exact Root read.",
  "- Draft correction: assert the fresh Draft Markdown before and after correction.",
  "- Approval: assert the exact corrected revision becomes In Progress and returns a non-null seal digest.",
  "",
  "## Failure Strategy",
  "",
  "Fail closed on malformed or incomplete Markdown, stale revisions, snapshot drift, conflicting graph facts,",
  "unknown acceptance without exact resolution, or any read-back mismatch.",
].join("\n");
function cycleDraftDescriptionForTest(): string {
  return cycleDraftDescription;
}

function bootstrap(
  correlation = "corr:bootstrap:1",
  runtimeGeneration = generation,
): RootBootstrap {
  const task = parseTaskSnapshot({
    root_id: rootId,
    issues: [{
      issue_id: rootId,
      revision: "revision:root:1",
      status: "Todo",
      title: "Build the Root runtime",
      description: null,
      parent_id: null,
      labels: ["label:root"],
      delegate_id: "actor:agent",
      priority: 1,
    }],
    relations: [],
  });
  const git = parseGitSnapshot({
    repository_id: parseRepositoryId("repo:1"),
    base_branch: "main",
    head_branch: "symphony/LIN-1",
    head_revision: "1111111111111111111111111111111111111111",
    workspace_state: "clean",
    diff_digest: "sha256:clean",
    pull_request: null,
  });
  return parseRootBootstrap({
    schema_version: 1,
    root_id: rootId,
    runtime_generation: runtimeGeneration,
    correlation_id: correlation,
    observed_at: "2026-07-30T10:00:00.000Z",
    task,
    git,
  }, { root_id: rootId, runtime_generation: runtimeGeneration });
}

function taskAtRootRevision(revision: string, description: string | null) {
  const task = bootstrap().task;
  return parseTaskSnapshot({
    ...task,
    issues: task.issues.map((issue) => issue.issue_id === parseTaskIssueId(rootId)
      ? { ...issue, revision, description }
      : issue),
  });
}

function completeRootBootstrap(): RootBootstrap {
  const initial = bootstrap();
  return parseRootBootstrap({
    ...initial,
    task: taskAtRootRevision("revision:root:2", reconciledRootDescription),
  }, { root_id: rootId, runtime_generation: generation });
}

function diff(
  from: string,
  to = "sha256:next",
  correlation = "corr:diff:1",
  runtimeGeneration = generation,
): RootFactDiff {
  return parseRootFactDiff({
    schema_version: 1,
    root_id: rootId,
    runtime_generation: runtimeGeneration,
    correlation_id: correlation,
    from_observation_digest: from,
    to_observation_digest: to,
    task_changes: [],
    git_changes: [],
  }, { root_id: rootId, runtime_generation: runtimeGeneration });
}

function completed(
  correlation: string,
  outcome: "quiescent" | "stopped" = "quiescent",
  runtimeGeneration = generation,
): RootTurnTransportResult {
  return {
    turn_id: `turn:${correlation}`,
    status: "completed",
    output: {
      schema_version: 1,
      root_id: rootId,
      runtime_generation: runtimeGeneration,
      correlation_id: correlation,
      outcome,
      sanitized_reason: outcome === "stopped" ? "No safe action remains" : null,
    },
  };
}

interface ControlledAppServer extends SpawnedCodexProcess {
  readonly input: PassThrough;
  readonly output: PassThrough;
  readonly launch: CodexProcessLaunch;
  send(message: Record<string, unknown>): void;
  sendMany(messages: readonly Record<string, unknown>[]): void;
}

function controlledAppServer(
  handle: (message: Record<string, unknown>, server: ControlledAppServer) => void,
): { readonly spawner: CodexSpawner; readonly requests: Record<string, unknown>[]; readonly spawns: ControlledAppServer[] } {
  const requests: Record<string, unknown>[] = [];
  const spawns: ControlledAppServer[] = [];
  const spawner: CodexSpawner = (_options, launch) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = new PassThrough();
    const events = new EventEmitter();
    const requestMethods = new Map<unknown, unknown>();
    let running = true;
    events.once("exit", () => { running = false; });
    const decoder = new JsonlFrameDecoder();
    const server: ControlledAppServer = {
      stdin: input,
      stdout: output,
      stderr,
      events,
      input,
      output,
      launch,
      isRunning: () => running,
      kill: () => {
        queueMicrotask(() => events.emit("exit", 0, null));
        return true;
      },
      send: (message) => {
        const method = requestMethods.get(message.id);
        const localOnly = launch.localOnly;
        const result = message.result;
        const response = method === "thread/start"
          && localOnly !== undefined
          && typeof result === "object"
          && result !== null
          ? {
              ...message,
              result: {
                ...result,
                cwd: localOnly.workspaceRoot,
                approvalPolicy: "never",
                approvalsReviewer: "user",
                activePermissionProfile: { id: localOnly.readPermissionProfile, extends: null },
                instructionSources: [],
                runtimeWorkspaceRoots: [],
              },
            }
          : message;
        output.write(`${JSON.stringify(response)}\n`);
      },
      sendMany: (messages) => {
        for (const message of messages) server.send(message);
      },
    };
    input.on("data", (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        setImmediate(() => {
          requests.push(message);
          requestMethods.set(message.id, message.method);
          const localOnly = launch.localOnly;
          if (localOnly !== undefined) {
            if (message.method === "config/read") {
              server.send({ id: message.id, result: { config: localOnly.expectedConfig, origins: {} } });
              return;
            }
            if (message.method === "remoteControl/status/read") {
              server.send({
                id: message.id,
                result: {
                  status: "disabled",
                  serverName: "symphony-root-test",
                  installationId: "installation-local",
                  environmentId: null,
                },
              });
              return;
            }
            if (message.method === "configRequirements/read") {
              server.send({
                id: message.id,
                error: { code: -32_601, message: "unexpected managed requirements request" },
              });
              return;
            }
            if (message.method === "permissionProfile/list") {
              server.send({
                id: message.id,
                result: {
                  data: [...new Set([localOnly.readPermissionProfile, localOnly.writePermissionProfile])]
                    .map((id) => ({ id, allowed: true })),
                  nextCursor: null,
                },
              });
              return;
            }
            if (message.method === "mcpServerStatus/list") {
              server.send({ id: message.id, result: { data: [], nextCursor: null } });
              return;
            }
          }
          handle(message, server);
        });
      }
    });
    spawns.push(server);
    return server;
  };
  return { spawner, requests, spawns };
}

function initializeResponse(message: Record<string, unknown>, server: ControlledAppServer): boolean {
  if (message.method !== "initialize") return false;
  server.send({
    id: message.id,
    result: {
      codexHome: server.launch.env.CODEX_HOME,
      platformFamily: "unix",
      platformOs: "macos",
      userAgent: "symphony/0.146.0 (Mac OS; arm64)",
    },
  });
  return true;
}

function taskToolCall(
  requestId: string,
  turnId: string,
  functionName: keyof typeof TASK_MCP_CAPABILITIES,
  input: Record<string, unknown>,
  runtimeGeneration = generation,
): Record<string, unknown> {
  return {
    id: requestId,
    method: "item/tool/call",
    params: {
      threadId: "thread-root",
      turnId,
      callId: `call:${requestId}`,
      tool: functionName,
      arguments: {
        schema_version: 1,
        function: functionName,
        root_id: rootId,
        runtime_generation: runtimeGeneration,
        correlation_id: "corr:bootstrap:1",
        capability: TASK_MCP_CAPABILITIES[functionName],
        input,
      },
    },
  };
}

function updateIssueToolCall(
  requestId: string,
  turnId: string,
  expectedRevision: string,
  runtimeGeneration = generation,
): Record<string, unknown> {
  return taskToolCall(requestId, turnId, "update_issue", {
    issue_id: rootId,
    expected_revision: expectedRevision,
    desired: { description: reconciledRootDescription },
  }, runtimeGeneration);
}

function getIssueToolCall(
  requestId: string,
  turnId: string,
  issueId: string = rootId,
): Record<string, unknown> {
  return taskToolCall(requestId, turnId, "get_issue", { issue_id: issueId });
}

function completedTurn(server: ControlledAppServer, turnId = "turn-root"): void {
  server.send({
    method: "turn/completed",
    params: {
      threadId: "thread-root",
      turn: {
        id: turnId,
        status: "completed",
        error: null,
        items: [{
          id: "answer",
          type: "agentMessage",
          text: JSON.stringify({
            schema_version: 1,
            root_id: rootId,
            runtime_generation: generation,
            correlation_id: "corr:bootstrap:1",
            outcome: "quiescent",
            sanitized_reason: null,
          }),
        }],
      },
    },
  });
}

function toolResponse(message: Record<string, unknown>): { readonly success: boolean; readonly body: unknown } {
  const result = message.result as {
    readonly success: boolean;
    readonly contentItems: readonly [{ readonly text: string }];
  };
  return { success: result.success, body: JSON.parse(result.contentItems[0].text) as unknown };
}

function updateResult(
  call: UpdateIssueCall,
  outcome: "applied" | "stale_before_effect",
  revision: string,
): UpdateIssueResult {
  return parseTaskMcpResult({
    schema_version: 1,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
    output: {
      outcome,
      effect_may_have_occurred: outcome === "applied",
      target: { kind: "issue", issue_id: call.input.issue_id },
      fresh_resource: {
        issue_id: call.input.issue_id,
        revision,
        status: "Todo",
        title: "Build the Root runtime",
        description: outcome === "applied"
          ? reconciledRootDescription
          : concurrentRootDescription,
        parent_id: null,
        labels: ["label:root"],
        delegate_id: "actor:agent",
        priority: 1,
      },
      concrete_diff: [{
        kind: "field_changed",
        issue_id: call.input.issue_id,
        field: "description",
        before: call.input.expected_revision === "revision:root:1"
          ? null
          : concurrentRootDescription,
        after: outcome === "applied"
          ? reconciledRootDescription
          : concurrentRootDescription,
      }],
      sanitized_reason: outcome === "applied" ? null : "Issue revision changed",
    },
  }, call) as UpdateIssueResult;
}

function taskManager(
  updateIssue: TaskManageCommandInterface["update_issue"],
): TaskManageCommandInterface {
  const unexpected = (): Promise<never> => Promise.reject(new Error("unexpected_task_manager_call"));
  return {
    get_issue: unexpected,
    list_issues: unexpected,
    list_children: unexpected,
    create_issue: unexpected,
    update_issue: updateIssue,
    archive_issue: unexpected,
    list_relations: unexpected,
    create_relation: unexpected,
    delete_relation: unexpected,
    list_states: unexpected,
    list_labels: unexpected,
  };
}

function trustedCodexTools(
  capabilities: readonly string[] = [],
  declaredTools: readonly DeclaredRootTool<unknown, unknown>[] = [],
): RootTools {
  return new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities,
    task_manager: bindRootTaskManageCommand({
      target: { root_id: rootId, runtime_generation: generation },
      workflow,
      caller_issuer: callerAuthority.issuer,
      task_manager: taskManager(() => Promise.reject(new Error("unexpected_task_manager_call"))),
      snapshot_reader: { readRootSnapshot: async () => bootstrap().task },
      record_reader: { readIssueRecordComments: async () => [] },
      service_actor_id: "actor:symphony",
      approved_cycle_reader: { readApprovedCycle: async () => null },
      accepted_revision_issuer: acceptedRevisionAuthority.issuer,
    }),
    declared_tools: declaredTools,
  });
}

test("Root tool construction rejects a structurally forged Task Manager binding before effects", () => {
  let effects = 0;
  const forged = Object.assign(Object.create(RootTaskManageCommandBinding.prototype) as object, {
    root_id: rootId,
    forCorrelation: () => {
      effects += 1;
      return {};
    },
  }) as unknown as RootTaskManageCommandBinding;

  assert.throws(() => new RootTools({
    target: { root_id: rootId, runtime_generation: generation },
    capabilities: [TASK_MCP_CAPABILITIES.get_issue],
    task_manager: forged,
  }), /unbound_root_task_manager/u);
  assert.equal(effects, 0);
});

async function controlledFixture(
  appServer: ReturnType<typeof controlledAppServer>,
  manager: TaskManageCommandInterface,
  capabilities: readonly string[] = [TASK_MCP_CAPABILITIES.update_issue],
  maxToolCalls = 4,
  turnTimeoutMs = 2_000,
  readRootSnapshot: () => Promise<ReturnType<typeof parseTaskSnapshot>> = async () => bootstrap().task,
  readIssueRecordComments: (issueId: ReturnType<typeof parseTaskIssueId>) => Promise<readonly LinearIssueRecordComment[]>
    = async () => [],
) {
  const rootHome = await mkdtemp(path.join(os.tmpdir(), "symphony-r52-controlled-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-r21-code-"));
  await mkdir(path.join(rootHome, "symphony"));
  const toolLogs: unknown[] = [];
  const transportFactory = new CodexRootTurnTransportFactory({
    executable: "codex",
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    shutdownTimeoutMs: 100,
    apiKey: "test-api-key",
    baseUrl: "https://api.openai.com/v1",
    model: "codex-test",
  }, {
    spawner: appServer.spawner,
    log: (entry) => toolLogs.push(entry),
    resolveWorkspaceRoot: async () => workspaceRoot,
  });
  const factory = new RootReconcillFactory(transportFactory, {
    create: (target) => new RootTools({
      target,
      task_manager: bindRootTaskManageCommand({
        target,
        workflow,
        caller_issuer: callerAuthority.issuer,
        task_manager: manager,
        snapshot_reader: { readRootSnapshot },
        record_reader: { readIssueRecordComments },
        service_actor_id: "actor:symphony",
        approved_cycle_reader: { readApprovedCycle: async () => null },
        accepted_revision_issuer: acceptedRevisionAuthority.issuer,
      }),
      capabilities,
    }),
  }, {
    max_tool_calls: maxToolCalls,
    turn_timeout_ms: turnTimeoutMs,
    log: () => undefined,
  });
  const root = await factory.create({
    root_id: rootId,
    runtime_generation: generation,
    root_home: rootHome,
  });
  return { rootHome, root, toolLogs };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type TurnScript = RootTurnTransportResult | Error | ((request: RootTurnRequest) => Promise<RootTurnTransportResult>);

class FakeTransport implements RootTurnTransport {
  readonly requests: RootTurnRequest[] = [];
  closed = false;

  constructor(
    readonly threadId: ReturnType<typeof parseThreadId>,
    private readonly scripts: TurnScript[],
  ) {}

  async turn(request: RootTurnRequest): Promise<RootTurnTransportResult> {
    this.requests.push(request);
    const script = this.scripts.shift();
    if (script instanceof Error) throw script;
    if (typeof script === "function") return script(request);
    if (script === undefined) throw new Error("missing_transport_script");
    return script;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeTransportFactory implements RootTurnTransportFactory {
  readonly created: FakeTransport[] = [];
  readonly scripts: TurnScript[][] = [];

  create(): Promise<RootTurnTransport> {
    const transport = new FakeTransport(
      parseThreadId(`thread:${this.created.length + 1}`),
      this.scripts.shift() ?? [],
    );
    this.created.push(transport);
    return Promise.resolve(transport);
  }
}

const noTools: RootReconcillToolSet = Object.freeze({
  target: Object.freeze({ root_id: rootId, runtime_generation: generation }),
  specs: Object.freeze([]) as readonly RootToolSpec[],
  hasPendingAcceptance: () => false,
  bindings: () => Object.freeze([]) as readonly RootToolBinding[],
});

const toolFactory: RootReconcillToolSetFactory = { create: () => noTools };

test("Codex Root transport enforces local read-only authority and executes branded code inspection", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-r21-root-transport-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const rootHome = path.join(temporary, "root-home");
  const workspace = path.join(temporary, "workspace");
  const workspaceAlias = path.join(temporary, "workspace-alias");
  await Promise.all([
    mkdir(path.join(rootHome, "symphony"), { recursive: true }),
    mkdir(workspace),
  ]);
  await writeFile(path.join(workspace, "README.md"), "Root bridge inspection\n", "utf8");
  await symlink(workspace, workspaceAlias);
  const canonicalWorkspace = await realpath(workspaceAlias);
  const resolvedRoots: string[] = [];
  const codeResponses: { readonly success: boolean; readonly body: unknown }[] = [];
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
      return;
    }
    if (message.method === "turn/start") {
      server.send({ id: message.id, result: { turn: { id: "turn-code-read" } } });
      setImmediate(() => server.send({
        id: "request:code-read",
        method: "item/tool/call",
        params: {
          threadId: "thread-root",
          turnId: "turn-code-read",
          callId: "call:code-read",
          tool: "read_code_file",
          arguments: {
            schema_version: 1,
            root_id: rootId,
            runtime_generation: generation,
            correlation_id: "corr:bootstrap:1",
            capability: "code_inspection:read_file",
            path: "README.md",
            start_line: 1,
            max_lines: 200,
          },
        },
      }));
      return;
    }
    if (message.id === "request:code-read" && message.result !== undefined) {
      codeResponses.push(toolResponse(message));
      completedTurn(server, "turn-code-read");
    }
  });
  const callerCodexOptions = {
    executable: "codex",
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    shutdownTimeoutMs: 100,
    apiKey: "test-api-key",
    baseUrl: "https://api.openai.com/v1",
    model: "codex-test",
    capabilityMode: { kind: "standard" as const },
  };
  const factory = new CodexRootTurnTransportFactory(callerCodexOptions, {
    spawner: appServer.spawner,
    log: () => undefined,
    resolveWorkspaceRoot: async (requestedRootId) => {
      resolvedRoots.push(requestedRootId);
      return workspaceAlias;
    },
  });

  const transport = await factory.create({
    root_id: rootId,
    runtime_generation: generation,
    root_home: rootHome,
    tools: trustedCodexTools(),
  });
  try {
    assert.deepEqual(resolvedRoots, [rootId]);
    assert.deepEqual(
      appServer.requests.map(({ method }) => method).slice(0, 6),
      [
        "initialize",
        "initialized",
        "config/read",
        "remoteControl/status/read",
        "permissionProfile/list",
        "mcpServerStatus/list",
      ],
    );
    const launch = appServer.spawns[0]?.launch;
    assert.ok(launch?.localOnly);
    assert.equal(launch.localOnly.role, "root");
    assert.equal(launch.localOnly.workspaceRoot, canonicalWorkspace);
    assert.equal(launch.cwd, canonicalWorkspace);
    assert.equal(launch.env.CODEX_HOME, rootHome);
    assert.equal("HOME" in launch.env, false);
    assert.equal("SYMPHONY_LINEAR_TOKEN" in launch.env, false);
    assert.deepEqual(
      appServer.requests.find(({ method }) => method === "thread/start")?.params,
      {
        cwd: canonicalWorkspace,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissions: launch.localOnly.readPermissionProfile,
        dynamicTools: launch.localOnly.dynamicTools,
        ephemeral: true,
        environments: [],
        runtimeWorkspaceRoots: [canonicalWorkspace],
        selectedCapabilityRoots: [],
        baseInstructions: launch.localOnly.baseInstructions,
        developerInstructions: launch.localOnly.developerInstructions,
        config: launch.localOnly.threadConfig,
      },
    );
    assert.deepEqual(
      launch.localOnly.dynamicTools.map(({ name }) => name),
      ["list_code_directory", "read_code_file", "search_code"],
    );
    assert.equal(
      Object.values(launch.localOnly.threadConfig.features as Readonly<Record<string, boolean>>)
        .every((enabled) => enabled === false),
      true,
    );
    const result = await transport.turn({
      input: "Inspect the bounded code file.",
      correlation_id: bootstrap().correlation_id,
      output_schema: { type: "object" },
      max_tool_calls: 3,
      timeout_ms: 2_000,
    });
    assert.equal(result.status, "completed");
    assert.equal(codeResponses.length, 1);
    assert.equal(codeResponses[0]?.success, true);
    assert.equal(
      (codeResponses[0]?.body as { readonly content?: unknown }).content,
      "Root bridge inspection\n",
    );
  } finally {
    await transport.close();
  }
});

test("Codex Root transport rejects an invalid routed workspace before process allocation", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-r21-invalid-workspace-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const rootHome = path.join(temporary, "root-home");
  const filePath = path.join(temporary, "not-a-directory");
  await mkdir(rootHome);
  const file = await open(filePath, "wx");
  await file.close();
  const appServer = controlledAppServer(() => undefined);
  let resolvedWorkspace = filePath;
  const factory = new CodexRootTurnTransportFactory({
    executable: "codex",
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    shutdownTimeoutMs: 100,
    apiKey: "test-api-key",
    baseUrl: "https://api.openai.com/v1",
    model: "codex-test",
  }, {
    spawner: appServer.spawner,
    log: () => undefined,
    resolveWorkspaceRoot: async () => resolvedWorkspace,
  });

  for (const invalid of [filePath, path.join(temporary, "missing"), "relative/workspace"]) {
    resolvedWorkspace = invalid;
    await assert.rejects(factory.create({
      root_id: rootId,
      runtime_generation: generation,
      root_home: rootHome,
      tools: trustedCodexTools(),
    }), /invalid_root_workspace/u);
  }
  assert.equal(appServer.spawns.length, 0);
});

test("Codex Root transport rejects Performer and write-capable Git tools before process allocation", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-r21-denied-tools-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const rootHome = path.join(temporary, "root-home");
  const workspace = path.join(temporary, "workspace");
  await Promise.all([mkdir(rootHome), mkdir(workspace)]);
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-forbidden" } } });
    }
  });
  const factory = new CodexRootTurnTransportFactory({
    executable: "codex",
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    shutdownTimeoutMs: 100,
    apiKey: "test-api-key",
    baseUrl: "https://api.openai.com/v1",
    model: "codex-test",
  }, {
    spawner: appServer.spawner,
    log: () => undefined,
    resolveWorkspaceRoot: async () => workspace,
  });

  for (const [name, capability] of [
    ["plan", "performer:plan"],
    ["prepare_worktree", "git:prepare_worktree"],
    ["create_commit", "git:create_commit"],
  ] as const) {
    const family = name === "plan" ? "performer" as const : "git" as const;
    const declaration = Object.freeze({
      family,
      capability,
      spec: Object.freeze({
        type: "function" as const,
        name,
        description: "Forbidden Root capability",
        inputSchema: Object.freeze({
          type: "object",
          additionalProperties: false,
          properties: Object.freeze({}),
          required: Object.freeze([]),
        }),
      }),
      parseCall: (value: unknown) => value,
      execute: (value: unknown) => Promise.resolve(value),
      parseResult: (value: unknown) => value,
    }) as unknown as DeclaredRootTool<unknown, unknown>;
    const outcome = await Promise.resolve().then(() => {
      const forbiddenTools = trustedCodexTools([capability], [declaration]);
      return factory.create({
        root_id: rootId,
        runtime_generation: generation,
        root_home: rootHome,
        tools: forbiddenTools,
      });
    }).then(async (transport) => {
      await transport.close();
      return "created";
    }, (error: Error) => error.message);
    assert.equal(outcome, "unapproved_root_tool", capability);
  }
  assert.equal(appServer.spawns.length, 0);
});

test("Codex Root transport rejects caller-declared read tool callbacks before process allocation", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-r21-declared-tool-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const rootHome = path.join(temporary, "root-home");
  const workspace = path.join(temporary, "workspace");
  await Promise.all([mkdir(rootHome), mkdir(workspace)]);
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-declared" } } });
    }
  });
  let effects = 0;
  const declaration: DeclaredRootTool<unknown, unknown> = Object.freeze({
    family: "git",
    capability: "git:get_diff",
    spec: Object.freeze({
      type: "function" as const,
      name: "get_diff",
      description: "Caller-declared repository diff reader",
      inputSchema: Object.freeze({
        type: "object",
        additionalProperties: false,
        properties: Object.freeze({}),
        required: Object.freeze([]),
      }),
    }),
    parseCall: (value: unknown) => value,
    execute: (value: unknown) => {
      effects += 1;
      return Promise.resolve(value);
    },
    parseResult: (value: unknown) => value,
  });
  const factory = new CodexRootTurnTransportFactory({
    executable: "codex",
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    shutdownTimeoutMs: 100,
    apiKey: "test-api-key",
    baseUrl: "https://api.openai.com/v1",
    model: "codex-test",
  }, {
    spawner: appServer.spawner,
    log: () => undefined,
    resolveWorkspaceRoot: async () => workspace,
  });

  const outcome = await factory.create({
    root_id: rootId,
    runtime_generation: generation,
    root_home: rootHome,
    tools: trustedCodexTools([declaration.capability], [declaration]),
  }).then(async (transport) => {
    await transport.close();
    return "created";
  }, (error: Error) => error.message);
  assert.equal(outcome, "root_local_only_tool_denied");
  assert.equal(effects, 0);
  assert.equal(appServer.spawns.length, 0);
});

test("Codex Root transport rejects an untrusted same-identity tool implementation before process allocation", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-r21-tool-drift-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const rootHome = path.join(temporary, "root-home");
  const workspace = path.join(temporary, "workspace");
  await Promise.all([mkdir(rootHome), mkdir(workspace)]);
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-tool-drift" } } });
    }
  });
  const toolSpec = (name: string, capability: string): RootToolSpec => Object.freeze({
    type: "function",
    name,
    description: "Bounded Root capability",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({ capability: Object.freeze({ const: capability }) }),
    }),
  });
  const initialSpec = toolSpec("get_issue", TASK_MCP_CAPABILITIES.get_issue);
  const tools: RootReconcillToolSet = Object.freeze({
    ...noTools,
    specs: Object.freeze([initialSpec]),
    bindings: () => Object.freeze([Object.freeze({
      spec: initialSpec,
      execute: () => Promise.resolve({}),
    })]),
  });
  const factory = new CodexRootTurnTransportFactory({
    executable: "codex",
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    shutdownTimeoutMs: 100,
    apiKey: "test-api-key",
    baseUrl: "https://api.openai.com/v1",
    model: "codex-test",
  }, {
    spawner: appServer.spawner,
    log: () => undefined,
    resolveWorkspaceRoot: async () => workspace,
  });

  await assert.rejects(factory.create({
    root_id: rootId,
    runtime_generation: generation,
    root_home: rootHome,
    tools,
  }), /root_local_only_tool_denied/u);
  assert.equal(appServer.spawns.length, 0);
});

test("Codex Root transport bounds workspace resolution by its startup timeout", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-r21-workspace-timeout-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const rootHome = path.join(temporary, "root-home");
  await mkdir(rootHome);
  const appServer = controlledAppServer(() => undefined);
  const factory = new CodexRootTurnTransportFactory({
    executable: "codex",
    startupTimeoutMs: 10,
    requestTimeoutMs: 2_000,
    shutdownTimeoutMs: 100,
    apiKey: "test-api-key",
    baseUrl: "https://api.openai.com/v1",
    model: "codex-test",
  }, {
    spawner: appServer.spawner,
    log: () => undefined,
    resolveWorkspaceRoot: () => new Promise<string>(() => undefined),
  });

  const outcome = await Promise.race([
    factory.create({
      root_id: rootId,
      runtime_generation: generation,
      root_home: rootHome,
      tools: trustedCodexTools(),
    }).then(async (transport) => {
      await transport.close();
      return "created";
    }, (error: Error) => error.message),
    new Promise<string>((resolve) => setTimeout(() => resolve("external_timeout"), 100)),
  ]);
  assert.equal(outcome, "invalid_root_workspace");
  assert.equal(appServer.spawns.length, 0);
});

async function fixture(scripts: TurnScript[]) {
  const rootHome = await mkdtemp(path.join(os.tmpdir(), "symphony-r52-reconcill-"));
  await mkdir(path.join(rootHome, "symphony"));
  const transports = new FakeTransportFactory();
  transports.scripts.push(scripts);
  const logs: RootReconcillLog[] = [];
  const factory = new RootReconcillFactory(transports, toolFactory, {
    max_tool_calls: 3,
    turn_timeout_ms: 2_000,
    log: (entry) => logs.push(entry),
  });
  const root = await factory.create({ root_id: rootId, runtime_generation: generation, root_home: rootHome });
  return { rootHome, transports, logs, root };
}

test("factory-produced Root Reconcill exposes only public identity fields as enumerable state", async () => {
  const f = await fixture([]);

  try {
    assert.deepEqual(Object.keys(f.root).sort(), ["rootId", "runtimeGeneration"]);
  } finally {
    await f.root.close();
  }
});

test("factory rejects a wrong-Root or stale-generation tool set before transport allocation", async () => {
  const wrongTargets = [
    { root_id: parseRootIssueId("LIN-2"), runtime_generation: generation },
    { root_id: rootId, runtime_generation: parseRuntimeGeneration(generation + 1) },
  ];
  const attempts = await Promise.all(wrongTargets.map(async (target, index) => {
    const rootHome = await mkdtemp(path.join(os.tmpdir(), `symphony-r52-tool-target-${index}-`));
    await mkdir(path.join(rootHome, "symphony"));
    const transports = new FakeTransportFactory();
    const factory = new RootReconcillFactory(transports, {
      create: () => Object.freeze({ ...noTools, target: Object.freeze(target) }),
    }, {
      max_tool_calls: 3,
      turn_timeout_ms: 2_000,
      log: () => undefined,
    });
    const status = await factory.create({
      root_id: rootId,
      runtime_generation: generation,
      root_home: rootHome,
    }).then(async (root) => {
      await root.close();
      return "fulfilled" as const;
    }, () => "rejected" as const);
    return { status, transport_allocations: transports.created.length };
  }));

  assert.deepEqual(attempts, [
    { status: "rejected", transport_allocations: 0 },
    { status: "rejected", transport_allocations: 0 },
  ]);
});

test("bootstrap persists its generation, thread, and correlation before transport invocation", async () => {
  const observed: Array<Awaited<ReturnType<RootContinuityStore["loadOptional"]>>> = [];
  const f = await fixture([async () => {
    observed.push(await new RootContinuityStore(f.rootHome).loadOptional());
    return completed("corr:bootstrap:1");
  }]);

  try {
    assert.equal((await f.root.run(bootstrap())).outcome, "quiescent");
    const continuity = observed[0];
    assert.deepEqual(continuity === null || continuity === undefined ? continuity : {
      root_id: continuity.root_id,
      runtime_generation: continuity.runtime_generation,
      thread_id: continuity.thread_id,
      in_flight_correlation: continuity.in_flight_correlation,
    }, {
      root_id: rootId,
      runtime_generation: generation,
      thread_id: "thread:1",
      in_flight_correlation: "corr:bootstrap:1",
    });
  } finally {
    await f.root.close();
  }
});

test("bootstrap and adjacent diff use one thread, strict outcomes, and accepted continuity", async () => {
  let inFlight: Awaited<ReturnType<RootContinuityStore["load"]>> | undefined;
  const source = bootstrap();
  const firstDigest = rootObservationDigest(source.task, source.git);
  const f = await fixture([
    completed("corr:bootstrap:1"),
    async () => {
      inFlight = await new RootContinuityStore(f.rootHome).load();
      return completed("corr:diff:1", "stopped");
    },
  ]);

  await assert.rejects(f.root.run(diff(firstDigest)), /root_bootstrap_required/u);
  assert.deepEqual(await f.root.run(source), {
    schema_version: 1,
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: "corr:bootstrap:1",
    outcome: "quiescent",
  });
  assert.deepEqual(await new RootContinuityStore(f.rootHome).load(), {
    schema_version: 1,
    root_id: rootId,
    runtime_generation: generation,
    thread_id: "thread:1",
    accepted_observation_digest: firstDigest,
    in_flight_correlation: null,
  });

  const next = diff(firstDigest);
  assert.equal((await f.root.run(next)).outcome, "stopped");
  assert.equal(f.transports.created.length, 1);
  assert.equal(f.transports.created[0]?.requests.length, 2);
  assert.equal(inFlight?.accepted_observation_digest, firstDigest);
  assert.equal(inFlight?.in_flight_correlation, "corr:diff:1");
  assert.deepEqual(await new RootContinuityStore(f.rootHome).load(), {
    schema_version: 1,
    root_id: rootId,
    runtime_generation: generation,
    thread_id: "thread:1",
    accepted_observation_digest: parseObservationDigest("sha256:next"),
    in_flight_correlation: null,
  });
  await assert.rejects(f.root.run(diff("sha256:next", "sha256:later")), /root_reconcill_terminal/u);

  const requests = f.transports.created[0]?.requests ?? [];
  assert.equal(JSON.parse(requests[0]?.input ?? "{}").input_kind, "bootstrap");
  assert.equal(JSON.parse(requests[1]?.input ?? "{}").input_kind, "diff");
  for (const request of requests) {
    assert.equal(request.max_tool_calls, 3);
    assert.equal(request.timeout_ms, 2_000);
    assert.equal(request.output_schema.type, "object");
    assert.equal("oneOf" in request.output_schema, false);
    assert.deepEqual(request.output_schema.required, [
      "schema_version",
      "root_id",
      "runtime_generation",
      "correlation_id",
      "outcome",
      "sanitized_reason",
    ]);
    const schema = JSON.stringify(request.output_schema);
    assert.equal(schema.includes("quiescent"), true);
    assert.equal(schema.includes("stopped"), true);
    for (const forbidden of ["StartCycle", "ContinueCycle", "next_action", "timed_out", "canceled"]) {
      assert.equal(schema.includes(forbidden), false, forbidden);
    }
  }
});

test("throwing log observers cannot split Reconcill and runtime continuity", async () => {
  const rootHome = await mkdtemp(path.join(os.tmpdir(), "symphony-r52-log-observer-"));
  await mkdir(path.join(rootHome, "symphony"));
  const transports = new FakeTransportFactory();
  transports.scripts.push([completed("corr:bootstrap:1")]);
  const factory = new RootReconcillFactory(transports, toolFactory, {
    max_tool_calls: 3,
    turn_timeout_ms: 2_000,
    log: () => { throw new Error("log_sink_unavailable"); },
  });
  const root = await factory.create({ root_id: rootId, runtime_generation: generation, root_home: rootHome });
  const source = bootstrap();

  assert.equal((await root.run(source)).outcome, "quiescent");
  assert.equal(
    (await new RootContinuityStore(rootHome).load()).accepted_observation_digest,
    rootObservationDigest(source.task, source.git),
  );
  await root.close();
});

test("continuity write failure keeps the exact turn correlation in sanitized logs", async () => {
  const f = await fixture([completed("corr:bootstrap:1")]);
  await mkdir(new RootContinuityStore(f.rootHome).statePath);

  await assert.rejects(f.root.run(bootstrap()), /root_continuity_unavailable/u);
  assert.deepEqual(f.logs.at(-1), {
    event: "root_reconcill_turn_failed",
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: "corr:bootstrap:1",
    thread_id: "thread:1",
    input_kind: "bootstrap",
    reason_code: "continuity_unavailable",
  });
  await f.root.close();
});

test("continuity sync failure removes its unpublished state temporary", async (t) => {
  const f = await fixture([completed("corr:bootstrap:1")]);
  const probePath = path.join(f.rootHome, "file-handle-prototype-probe");
  const probe = await open(probePath, "wx", 0o600);
  const fileHandlePrototype = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
  await probe.close();
  await unlink(probePath);
  t.mock.method(fileHandlePrototype, "sync", () => Promise.reject(new Error("state_sync_failed")));

  try {
    await assert.rejects(f.root.run(bootstrap()), /root_continuity_unavailable/u);
    const stateDirectory = path.dirname(new RootContinuityStore(f.rootHome).statePath);
    assert.deepEqual(
      (await readdir(stateDirectory)).filter((entry) => entry.startsWith(".state.")),
      [],
    );
  } finally {
    t.mock.restoreAll();
    await f.root.close();
  }
});

test("malformed runtime input fails through the sanitized contract path", async () => {
  const f = await fixture([completed("corr:bootstrap:1")]);

  await assert.rejects(f.root.run(null as never), /root_reconcill_invalid_input/u);
  assert.equal(f.transports.created[0]?.requests.length, 0);
  await assert.rejects(f.root.run(bootstrap()), /root_reconcill_terminal/u);
  await f.root.close();
});

test("an oversized Root prompt is rejected before aggregate JSON serialization", async () => {
  const source = bootstrap();
  const description = "x".repeat(100_000);
  const oversized = parseRootBootstrap({
    ...source,
    task: {
      root_id: rootId,
      issues: [
        { ...source.task.issues[0], description },
        {
          ...source.task.issues[0],
          issue_id: "LIN-2",
          revision: "revision:child:2",
          parent_id: rootId,
          description,
        },
        {
          ...source.task.issues[0],
          issue_id: "LIN-3",
          revision: "revision:child:3",
          parent_id: rootId,
          description,
        },
      ],
      relations: [],
    },
  }, { root_id: rootId, runtime_generation: generation });
  const f = await fixture([]);
  const stringify = JSON.stringify;
  let promptSerializationAttempts = 0;
  JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
    if (
      typeof value === "object"
      && value !== null
      && (value as { role?: unknown }).role === "RootReconcill"
    ) promptSerializationAttempts += 1;
    return Reflect.apply(stringify, JSON, [value, ...rest]) as string | undefined;
  }) as typeof JSON.stringify;

  try {
    await assert.rejects(f.root.run(oversized), /root_reconcill_boundary_failed/u);
  } finally {
    JSON.stringify = stringify;
    await f.root.close();
  }

  assert.equal(promptSerializationAttempts, 0);
  assert.equal(f.transports.created[0]?.requests.length, 0);
});

test("host timeout and cancellation are visible and preserve the bootstrap generation fence", async () => {
  const timedOut = await fixture([new Error("codex_turn_timed_out")]);
  try {
    assert.deepEqual(await timedOut.root.run(bootstrap()), {
      schema_version: 1,
      root_id: rootId,
      runtime_generation: generation,
      correlation_id: "corr:bootstrap:1",
      outcome: "timed_out",
      sanitized_reason: "Root reasoning turn exceeded its time budget",
    });
    const continuity = await new RootContinuityStore(timedOut.rootHome).load();
    assert.equal(continuity.runtime_generation, generation);
    assert.equal(continuity.thread_id, "thread:1");
    assert.equal(continuity.in_flight_correlation, "corr:bootstrap:1");
  } finally {
    await timedOut.root.close();
  }

  const canceled = await fixture([{
    turn_id: "turn:canceled",
    status: "interrupted",
  }]);
  try {
    assert.deepEqual(await canceled.root.run(bootstrap()), {
      schema_version: 1,
      root_id: rootId,
      runtime_generation: generation,
      correlation_id: "corr:bootstrap:1",
      outcome: "canceled",
      sanitized_reason: "Root reasoning turn was canceled",
    });
    const continuity = await new RootContinuityStore(canceled.rootHome).load();
    assert.equal(continuity.runtime_generation, generation);
    assert.equal(continuity.thread_id, "thread:1");
    assert.equal(continuity.in_flight_correlation, "corr:bootstrap:1");
  } finally {
    await canceled.root.close();
  }
});

for (const scenario of [
  { name: "failed", script: () => new Error("provider boundary failed") },
  { name: "timed-out", script: () => new Error("codex_turn_timed_out") },
] as const) {
  test(`a ${scenario.name} bootstrap requires the next generation in a fresh factory`, async () => {
    const rootHome = await mkdtemp(path.join(os.tmpdir(), `symphony-r52-${scenario.name}-generation-`));
    await mkdir(path.join(rootHome, "symphony"));
    const transports = new FakeTransportFactory();
    transports.scripts.push([scenario.script()], []);
    const tools: RootReconcillToolSetFactory = {
      create: (target) => Object.freeze({ ...noTools, target: Object.freeze(target) }),
    };
    const options = {
      max_tool_calls: 3,
      turn_timeout_ms: 2_000,
      log: () => undefined,
    };
    const firstFactory = new RootReconcillFactory(transports, tools, options);
    const first = await firstFactory.create({
      root_id: rootId,
      runtime_generation: generation,
      root_home: rootHome,
    });
    if (scenario.name === "timed-out") {
      assert.equal((await first.run(bootstrap())).outcome, "timed_out");
    } else {
      await assert.rejects(first.run(bootstrap()), /root_reconcill_boundary_failed/u);
    }
    await first.close();

    const restartFactory = new RootReconcillFactory(transports, tools, options);
    await assert.rejects(
      restartFactory.create({
        root_id: rootId,
        runtime_generation: generation,
        root_home: rootHome,
      }).then(async (unexpected) => { await unexpected.close(); }),
      /invalid_restart_generation/u,
    );
    assert.equal(transports.created.length, 1);

    const restarted = await restartFactory.create({
      root_id: rootId,
      runtime_generation: parseRuntimeGeneration(generation + 1),
      root_home: rootHome,
    });
    assert.equal(transports.created.length, 2);
    await restarted.close();
  });
}

test("process and output failures stay sanitized and preserve the in-flight fence", async () => {
  const source = bootstrap();
  const firstDigest = rootObservationDigest(source.task, source.git);
  const f = await fixture([
    completed("corr:bootstrap:1"),
    new Error("provider-secret-and-command-line"),
  ]);
  await f.root.run(source);
  await assert.rejects(
    f.root.run(diff(firstDigest, "sha256:failed", "corr:diff:failure")),
    (error: Error) => {
      assert.equal(error.message, "root_reconcill_boundary_failed");
      assert.equal(error.message.includes("secret"), false);
      return true;
    },
  );
  const state = await new RootContinuityStore(f.rootHome).load();
  assert.equal(state.accepted_observation_digest, firstDigest);
  assert.equal(state.in_flight_correlation, "corr:diff:failure");
  assert.equal(JSON.stringify(f.logs).includes("provider-secret"), false);

  const invalid = await fixture([{
    turn_id: "turn:invalid",
    status: "completed",
    output: {
      schema_version: 1,
      root_id: rootId,
      runtime_generation: generation,
      correlation_id: "corr:bootstrap:1",
      outcome: "StartCycle",
      next_action: "create_cycle",
    },
  }]);
  await assert.rejects(invalid.root.run(bootstrap()), /root_reconcill_boundary_failed/u);
  const invalidContinuity = await new RootContinuityStore(invalid.rootHome).load();
  assert.equal(invalidContinuity.accepted_observation_digest, firstDigest);
  assert.equal(invalidContinuity.in_flight_correlation, "corr:bootstrap:1");
});

test("tool-call budget exhaustion stops visibly and accepts only the observed input", async () => {
  const f = await fixture([{
    turn_id: "turn:budget",
    status: "budget_exhausted",
  }]);
  const source = bootstrap();
  assert.deepEqual(await f.root.run(source), {
    schema_version: 1,
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: "corr:bootstrap:1",
    outcome: "stopped",
    sanitized_reason: "Root tool-call budget was exhausted",
  });
  assert.equal(
    (await new RootContinuityStore(f.rootHome).load()).accepted_observation_digest,
    rootObservationDigest(source.task, source.git),
  );
});

test("a hard exact-turn denial wins over a synchronous terminal completion", async () => {
  const responses: Array<{ readonly success: boolean; readonly body: unknown }> = [];
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
      return;
    }
    if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-root" } } },
        {
          method: "turn/started",
          params: {
            threadId: "thread-root",
            turn: { id: "turn-root", status: "inProgress", items: [], error: null },
          },
        },
        updateIssueToolCall(
          "tool:hard-denial",
          "turn-root",
          "revision:root:1",
          parseRuntimeGeneration(generation + 1),
        ),
      ]);
      return;
    }
    if (message.id === "tool:hard-denial") {
      responses.push(toolResponse(message));
      completedTurn(server);
    }
    if (message.method === "turn/interrupt") server.send({ id: message.id, result: {} });
  });
  const f = await controlledFixture(appServer, taskManager(async () => {
    throw new Error("stale_generation_effect_must_not_execute");
  }));

  await assert.rejects(f.root.run(bootstrap()), /root_reconcill_boundary_failed/u);
  await tick();
  assert.equal(responses[0]?.success, false);
  assert.equal((responses[0]?.body as { code?: unknown }).code, "stale_generation");
  assert.deepEqual(
    f.toolLogs.map((entry) => (entry as { event: string }).event),
    ["root_tool_call_denied"],
  );
  await f.root.close();
});

test("terminal completion cannot accept a turn while a successful tool effect is in flight", async () => {
  let markEffectStarted: (() => void) | undefined;
  let releaseEffect: (() => void) | undefined;
  const effectStarted = new Promise<void>((resolve) => { markEffectStarted = resolve; });
  const effectPending = new Promise<void>((resolve) => { releaseEffect = resolve; });
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
      return;
    }
    if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-root" } } },
        {
          method: "turn/started",
          params: {
            threadId: "thread-root",
            turn: { id: "turn-root", status: "inProgress", items: [], error: null },
          },
        },
        updateIssueToolCall("tool:pending-success", "turn-root", "revision:root:1"),
      ]);
    }
  });
  const f = await controlledFixture(appServer, taskManager(async (call) => {
    markEffectStarted?.();
    await effectPending;
    return updateResult(call, "applied", "revision:root:2");
  }));

  const running = f.root.run(bootstrap());
  await effectStarted;
  completedTurn(appServer.spawns[0] as ControlledAppServer);
  releaseEffect?.();
  try {
    const result = await running.then(
      () => ({ status: "fulfilled" as const, reason: null }),
      (error: unknown) => ({
        status: "rejected" as const,
        reason: error instanceof Error ? error.message : null,
      }),
    );
    const continuity = await new RootContinuityStore(f.rootHome).loadOptional();
    assert.deepEqual({
      ...result,
      in_flight_correlation: continuity?.in_flight_correlation ?? null,
    }, {
      status: "rejected",
      reason: "root_reconcill_boundary_failed",
      in_flight_correlation: "corr:bootstrap:1",
    });
  } finally {
    releaseEffect?.();
    await f.root.close();
  }
});

test("tool drain rechecks the absolute deadline after a blocked event loop resumes", async () => {
  let markEffectStarted: (() => void) | undefined;
  let releaseEffect: (() => void) | undefined;
  const effectStarted = new Promise<void>((resolve) => { markEffectStarted = resolve; });
  const effectPending = new Promise<void>((resolve) => {
    releaseEffect = () => {
      const blockedUntil = performance.now() + 125;
      while (performance.now() < blockedUntil) { /* keep the deadline timer pending */ }
      resolve();
    };
  });
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
      return;
    }
    if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-root" } } },
        {
          method: "turn/started",
          params: {
            threadId: "thread-root",
            turn: { id: "turn-root", status: "inProgress", items: [], error: null },
          },
        },
        updateIssueToolCall("tool:deadline-drain", "turn-root", "revision:root:1"),
      ]);
    }
    if (message.method === "turn/interrupt") server.send({ id: message.id, result: {} });
  });
  const f = await controlledFixture(appServer, taskManager(async (call) => {
    markEffectStarted?.();
    await effectPending;
    return updateResult(call, "applied", "revision:root:2");
  }), [TASK_MCP_CAPABILITIES.update_issue], 1, 100);

  const running = f.root.run(bootstrap());
  await effectStarted;
  completedTurn(appServer.spawns[0] as ControlledAppServer);
  await tick();
  releaseEffect?.();
  try {
    assert.equal((await running).outcome, "timed_out");
    assert.equal(
      (await new RootContinuityStore(f.rootHome).load()).in_flight_correlation,
      "corr:bootstrap:1",
    );
  } finally {
    releaseEffect?.();
    await f.root.close();
  }
});

test("controlled app-server denies a same-team cross-Root read with zero manager effects", async () => {
  const responses: Array<{ readonly success: boolean; readonly body: unknown }> = [];
  const effects: string[] = [];
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
      return;
    }
    if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-root" } } },
        {
          method: "turn/started",
          params: {
            threadId: "thread-root",
            turn: { id: "turn-root", status: "inProgress", items: [], error: null },
          },
        },
        getIssueToolCall("tool:cross-root", "turn-root", "ROOT-B-ISSUE"),
      ]);
      return;
    }
    if (message.id === "tool:cross-root") {
      responses.push(toolResponse(message));
      completedTurn(server);
    }
  });
  const manager = taskManager(async () => {
    throw new Error("unexpected_update_issue");
  });
  manager.get_issue = async () => {
    effects.push("get_issue");
    throw new Error("cross_root_effect_must_not_execute");
  };
  const f = await controlledFixture(
    appServer,
    manager,
    [TASK_MCP_CAPABILITIES.get_issue],
  );

  await assert.rejects(f.root.run(bootstrap()), /root_reconcill_boundary_failed/u);
  await tick();
  assert.equal(responses[0]?.success, false);
  assert.equal((responses[0]?.body as { code?: unknown }).code, "capability_denied");
  assert.deepEqual(effects, []);
  assert.deepEqual(
    f.toolLogs.map((entry) => (entry as { event: string }).event),
    ["root_tool_call_denied"],
  );
  await f.root.close();
});

test("tool-call budget exhaustion wins over a synchronous terminal completion", async () => {
  const responses: Array<[string, { readonly success: boolean; readonly body: unknown }]> = [];
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
      return;
    }
    if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-root" } } },
        {
          method: "turn/started",
          params: {
            threadId: "thread-root",
            turn: { id: "turn-root", status: "inProgress", items: [], error: null },
          },
        },
        updateIssueToolCall("tool:first", "turn-root", "revision:root:1"),
      ]);
      return;
    }
    if (message.id === "tool:first") {
      responses.push([message.id, toolResponse(message)]);
      server.send(updateIssueToolCall("tool:over-budget", "turn-root", "revision:root:2"));
      return;
    }
    if (message.id === "tool:over-budget") {
      responses.push([message.id, toolResponse(message)]);
      completedTurn(server);
    }
    if (message.method === "turn/interrupt") server.send({ id: message.id, result: {} });
  });
  const f = await controlledFixture(
    appServer,
    taskManager(async (call) => updateResult(call, "applied", "revision:root:2")),
    [TASK_MCP_CAPABILITIES.update_issue],
    1,
  );

  assert.deepEqual(await f.root.run(bootstrap()), {
    schema_version: 1,
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: "corr:bootstrap:1",
    outcome: "stopped",
    sanitized_reason: "Root tool-call budget was exhausted",
  });
  assert.deepEqual(responses.map(([id, response]) => [
    id,
    response.success,
    response.success ? "accepted" : (response.body as { code?: unknown }).code,
  ]), [
    ["tool:first", true, "accepted"],
    ["tool:over-budget", false, "invalid_contract"],
  ]);
  assert.equal(
    f.toolLogs.some((entry) => (entry as { event: string }).event === "root_tool_call_denied"),
    true,
  );
  await f.root.close();
});

test("budget denial response loss overrides the stopped outcome and retains continuity", async () => {
  let markDenialWritePending: (() => void) | undefined;
  const denialWritePending = new Promise<void>((resolve) => { markDenialWritePending = resolve; });
  const responses: Array<{ readonly success: boolean; readonly body: unknown }> = [];
  let effects = 0;
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
      return;
    }
    if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-root" } } },
        {
          method: "turn/started",
          params: {
            threadId: "thread-root",
            turn: { id: "turn-root", status: "inProgress", items: [], error: null },
          },
        },
        updateIssueToolCall("tool:first-before-denial-loss", "turn-root", "revision:root:1"),
      ]);
      return;
    }
    if (message.id === "tool:first-before-denial-loss") {
      responses.push(toolResponse(message));
      server.input.on("error", () => undefined);
      server.input.cork();
      server.send(updateIssueToolCall(
        "tool:over-budget-denial-loss",
        "turn-root",
        "revision:root:2",
      ));
      markDenialWritePending?.();
      return;
    }
    if (message.method === "turn/interrupt") server.send({ id: message.id, result: {} });
  });
  const f = await controlledFixture(
    appServer,
    taskManager(async (call) => {
      effects += 1;
      return updateResult(call, "applied", "revision:root:2");
    }),
    [TASK_MCP_CAPABILITIES.update_issue],
    1,
  );

  const running = f.root.run(bootstrap());
  await denialWritePending;
  appServer.spawns[0]?.input.destroy(new Error("late_tool_response_write_failed"));
  try {
    await assert.rejects(running, /root_reconcill_boundary_failed/u);
    assert.equal(effects, 1);
    assert.equal(responses[0]?.success, true);
    assert.equal(
      (await new RootContinuityStore(f.rootHome).load()).in_flight_correlation,
      "corr:bootstrap:1",
    );
  } finally {
    await f.root.close();
  }
});

test("closing during budget denial delivery cancels without accepting the budget outcome", async () => {
  let markDenialWritePending: (() => void) | undefined;
  const denialWritePending = new Promise<void>((resolve) => { markDenialWritePending = resolve; });
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
      return;
    }
    if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-root" } } },
        {
          method: "turn/started",
          params: {
            threadId: "thread-root",
            turn: { id: "turn-root", status: "inProgress", items: [], error: null },
          },
        },
        updateIssueToolCall("tool:first-before-close", "turn-root", "revision:root:1"),
      ]);
      return;
    }
    if (message.id === "tool:first-before-close") {
      server.input.cork();
      server.send(updateIssueToolCall(
        "tool:over-budget-before-close",
        "turn-root",
        "revision:root:2",
      ));
      markDenialWritePending?.();
    }
  });
  const f = await controlledFixture(
    appServer,
    taskManager(async (call) => updateResult(call, "applied", "revision:root:2")),
    [TASK_MCP_CAPABILITIES.update_issue],
    1,
  );

  const running = f.root.run(bootstrap());
  await denialWritePending;
  const closing = f.root.close();

  assert.deepEqual(await running, {
    schema_version: 1,
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: "corr:bootstrap:1",
    outcome: "canceled",
    sanitized_reason: "Root reasoning turn was canceled",
  });
  await closing;
  assert.equal(
    (await new RootContinuityStore(f.rootHome).load()).in_flight_correlation,
    "corr:bootstrap:1",
  );
});

test("tool-call budget abort cannot accept while an earlier effect is in flight", async () => {
  let markEffectStarted: (() => void) | undefined;
  let releaseEffect: (() => void) | undefined;
  const effectStarted = new Promise<void>((resolve) => { markEffectStarted = resolve; });
  const effectPending = new Promise<void>((resolve) => { releaseEffect = resolve; });
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
      return;
    }
    if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-root" } } },
        {
          method: "turn/started",
          params: {
            threadId: "thread-root",
            turn: { id: "turn-root", status: "inProgress", items: [], error: null },
          },
        },
        updateIssueToolCall("tool:pending-before-budget", "turn-root", "revision:root:1"),
      ]);
    }
    if (message.method === "turn/interrupt") server.send({ id: message.id, result: {} });
  });
  const f = await controlledFixture(appServer, taskManager(async (call) => {
    markEffectStarted?.();
    await effectPending;
    return updateResult(call, "applied", "revision:root:2");
  }), [TASK_MCP_CAPABILITIES.update_issue], 1);

  const running = f.root.run(bootstrap());
  await effectStarted;
  appServer.spawns[0]?.send(
    updateIssueToolCall("tool:over-budget-during-effect", "turn-root", "revision:root:2"),
  );
  releaseEffect?.();
  try {
    await assert.rejects(running, /root_reconcill_boundary_failed/u);
    assert.equal(
      (await new RootContinuityStore(f.rootHome).load()).in_flight_correlation,
      "corr:bootstrap:1",
    );
  } finally {
    releaseEffect?.();
    await f.root.close();
  }
});

test("controlled app-server resumes from complete Root Markdown by creating the Draft directly", async () => {
  const cycleId = parseTaskIssueId("33333333-3333-4333-8333-333333333333");
  const responses: Array<ReturnType<typeof toolResponse>> = [];
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
      return;
    }
    if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-root" } } },
        {
          method: "turn/started",
          params: {
            threadId: "thread-root",
            turn: { id: "turn-root", status: "inProgress", items: [], error: null },
          },
        },
        taskToolCall("tool:create-resumed-draft", "turn-root", "create_issue", {
          issue_id: cycleId,
          parent_issue_id: rootId,
          expected_parent_revision: "revision:root:2",
          desired: {
            title: "Implement the Root runtime",
            description: cycleDraftDescription,
            state_id: workflow.cycle_states.draft,
            label_ids: [workflow.labels.cycle],
            delegate_id: null,
            priority: null,
          },
        }),
      ]);
      return;
    }
    if (message.id === "tool:create-resumed-draft" && message.result !== undefined) {
      responses.push(toolResponse(message));
      completedTurn(server);
    }
  });

  let currentTask = completeRootBootstrap().task;
  const managerCalls: string[] = [];
  const manager = taskManager(async () => {
    managerCalls.push("update");
    throw new Error("unexpected_root_rewrite");
  });
  manager.create_issue = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    const parent = currentTask.issues.find(({ issue_id }) => issue_id === call.input.parent_issue_id);
    assert.ok(parent);
    assert.equal(call.input.expected_parent_revision, parent.revision);
    const fresh = {
      issue_id: call.input.issue_id,
      revision: "revision:cycle:1",
      status: call.input.desired.state_id,
      title: call.input.desired.title,
      description: call.input.desired.description,
      parent_id: call.input.parent_issue_id,
      labels: call.input.desired.label_ids,
      delegate_id: call.input.desired.delegate_id,
      priority: call.input.desired.priority,
    };
    currentTask = parseTaskSnapshot({
      ...currentTask,
      issues: [...currentTask.issues, fresh],
    });
    managerCalls.push(`create:${call.input.parent_issue_id}:${call.input.expected_parent_revision}`);
    return parseTaskMcpResult({
      schema_version: call.schema_version,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome: "applied",
        effect_may_have_occurred: true,
        target: { kind: "issue", issue_id: fresh.issue_id },
        fresh_resource: fresh,
        concrete_diff: [{ kind: "issue_created", issue: fresh }],
        sanitized_reason: null,
      },
    }, call);
  };
  const f = await controlledFixture(
    appServer,
    manager,
    [TASK_MCP_CAPABILITIES.create_issue, TASK_MCP_CAPABILITIES.update_issue],
    1,
    2_000,
    async () => currentTask,
  );

  try {
    assert.equal((await f.root.run(completeRootBootstrap())).outcome, "quiescent");
    assert.deepEqual(managerCalls, [`create:${rootId}:revision:root:2`]);
    assert.equal(responses.length, 1);
    assert.equal(responses[0]?.success, true);
    assert.equal(currentTask.issues.some(({ issue_id }) => issue_id === cycleId), true);
    assert.equal(
      currentTask.issues.find(({ issue_id }) => issue_id === parseTaskIssueId(rootId))?.description,
      reconciledRootDescription,
    );
  } finally {
    await f.root.close();
  }
});

test("controlled app-server completes fresh Define, Draft review, correction, and one-way seal", async () => {
  const rootTaskIssueId = parseTaskIssueId(rootId);
  const identityVersion = "symphony-identity:v1";
  const cycleId = parseTaskIssueId(deriveCycleUuid(
    identityVersion,
    "cycle_issue",
    rootId,
    "first_cycle",
    "first_cycle",
  ));
  const rootRevision = `symphony:v1:${"a".repeat(64)}`;
  const cycleCreatedRevision = `symphony:v1:${"b".repeat(64)}`;
  const cycleCorrectedRevision = `symphony:v1:${"c".repeat(64)}`;
  const cycleApprovedRevision = `symphony:v1:${"d".repeat(64)}`;
  const executionDesign = [
    "### Execution Anchors", "",
    `- Cycle ID: \`${cycleId}\``,
    "- Predecessor Cycle ID: None",
    "- Predecessor Terminal Record ID: `first_cycle`",
    `- Approval Record ID: \`${deriveCycleUuid(identityVersion, "cycle_approval_record", cycleId)}\``,
    `- Plan Issue ID: \`${deriveCycleUuid(identityVersion, "plan_issue", cycleId)}\``,
    `- Plan Completion Record ID: \`${deriveCycleUuid(identityVersion, "plan_completion_record", cycleId)}\``,
    `- Plan Invalidation Record ID: \`${deriveCycleUuid(identityVersion, "plan_invalidation_record", cycleId)}\``,
    `- Cycle Completion Record ID: \`${deriveCycleUuid(identityVersion, "cycle_completion_record", cycleId)}\``,
    `- Cycle Invalidation Record ID: \`${deriveCycleUuid(identityVersion, "cycle_invalidation_record", cycleId)}\``,
    `- Delivery Completion Record ID: \`${deriveCycleUuid(identityVersion, "delivery_completion_record", cycleId)}\``,
    `- Delivery Invalidation Record ID: \`${deriveCycleUuid(identityVersion, "delivery_invalidation_record", cycleId)}\``,
    `- Identity Derivation Version: \`${identityVersion}\``,
    `- Workspace Base Revision: \`${"e".repeat(64)}\``, "",
    "### Execution Directives", "", "#### Directive: `directive:runtime`", "",
    "Implement the approved Root runtime.", "", "##### Dependencies", "", "- None", "",
    "##### Acceptance Criteria", "", "- `acceptance:runtime`", "",
    "### Approved Work Groups", "", "#### Work Group: `group:runtime`", "",
    "##### Directives", "", "- `directive:runtime`", "", "##### Dependencies", "", "- None", "",
    "### Verification Directives", "", "#### Verification Directive: `verify:runtime`", "",
    "Verify the approved Root runtime.", "", "##### Acceptance Criteria", "", "- `acceptance:runtime`",
  ].join("\n");
  const cycleDraftDescription = cycleDraftDescriptionForTest().replace(
    "`revision:root:2`",
    `\`${rootRevision}\``,
  ).replace(
    "## Failure Strategy",
    `${executionDesign}\n\n## Failure Strategy`,
  );
  const correctedCycleDraftDescription = cycleDraftDescription.replace(
    "Validate closed Markdown and exact revisions at the Root boundary.",
    "Validate closed Markdown, copied Root facts, and exact revisions at the Root boundary.",
  );
  const responses = new Map<string, ReturnType<typeof toolResponse>>();
  const reviewedDraftDescriptions: string[] = [];
  const readIssue = (response: ReturnType<typeof toolResponse>) => {
    const issue = (response.body as {
      readonly output?: {
        readonly issue?: {
          readonly issue_id?: unknown;
          readonly revision?: unknown;
          readonly status?: unknown;
          readonly description?: unknown;
        } | null;
      };
    }).output?.issue;
    if (issue === undefined || issue === null) throw new Error("missing_controlled_issue_readback");
    return {
      issue_id: String(issue.issue_id),
      revision: String(issue.revision),
      status: String(issue.status),
      description: typeof issue.description === "string" ? issue.description : null,
    };
  };
  const createdIssue = (response: ReturnType<typeof toolResponse>) => {
    const issue = (response.body as {
      readonly output?: {
        readonly fresh_resource?: {
          readonly issue_id?: unknown;
          readonly revision?: unknown;
        } | null;
      };
    }).output?.fresh_resource;
    if (issue === undefined || issue === null) throw new Error("missing_controlled_create_readback");
    return { issue_id: String(issue.issue_id), revision: String(issue.revision) };
  };
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
      return;
    }
    if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-root" } } },
        {
          method: "turn/started",
          params: {
            threadId: "thread-root",
            turn: { id: "turn-root", status: "inProgress", items: [], error: null },
          },
        },
        updateIssueToolCall("tool:define", "turn-root", "revision:root:1"),
      ]);
      return;
    }
    if (typeof message.id !== "string" || !message.id.startsWith("tool:")) return;
    const response = toolResponse(message);
    responses.set(message.id, response);
    switch (message.id) {
      case "tool:define":
        setImmediate(() => server.send(getIssueToolCall("tool:read-root", "turn-root")));
        return;
      case "tool:read-root": {
        const root = readIssue(response);
        assert.equal(root.description, reconciledRootDescription);
        setImmediate(() => server.send(taskToolCall("tool:create-draft", "turn-root", "create_issue", {
          issue_id: cycleId,
          parent_issue_id: root.issue_id,
          expected_parent_revision: root.revision,
          desired: {
            title: "Implement the Root runtime",
            description: cycleDraftDescription,
            state_id: workflow.cycle_states.draft,
            label_ids: [workflow.labels.cycle],
            delegate_id: null,
            priority: null,
          },
        })));
        return;
      }
      case "tool:create-draft": {
        const created = createdIssue(response);
        setImmediate(() => server.send(getIssueToolCall(
          "tool:read-draft",
          "turn-root",
          created.issue_id,
        )));
        return;
      }
      case "tool:read-draft": {
        const draft = readIssue(response);
        assert.equal(draft.description, cycleDraftDescription);
        assert.ok(draft.description);
        reviewedDraftDescriptions.push(draft.description);
        const correctedDescription = draft.description.replace(
          "Validate closed Markdown and exact revisions at the Root boundary.",
          "Validate closed Markdown, copied Root facts, and exact revisions at the Root boundary.",
        );
        assert.equal(correctedDescription, correctedCycleDraftDescription);
        setImmediate(() => server.send(taskToolCall("tool:correct-draft", "turn-root", "update_issue", {
          issue_id: draft.issue_id,
          expected_revision: draft.revision,
          desired: { description: correctedDescription },
        })));
        return;
      }
      case "tool:correct-draft":
        setImmediate(() => server.send(getIssueToolCall("tool:read-corrected", "turn-root", cycleId)));
        return;
      case "tool:read-corrected": {
        const draft = readIssue(response);
        assert.equal(draft.description, correctedCycleDraftDescription);
        assert.ok(draft.description);
        reviewedDraftDescriptions.push(draft.description);
        setImmediate(() => server.send(taskToolCall("tool:approve", "turn-root", "update_issue", {
          issue_id: draft.issue_id,
          expected_revision: draft.revision,
          desired: { state_id: workflow.cycle_states.in_progress },
        })));
        return;
      }
      case "tool:approve":
        setImmediate(() => server.send(getIssueToolCall("tool:read-sealed", "turn-root", cycleId)));
        return;
      case "tool:read-sealed":
        completedTurn(server);
    }
  });

  let currentTask = bootstrap().task;
  const managerCalls: string[] = [];
  const recordComments: LinearIssueRecordComment[] = [];
  const manager = taskManager(async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    const before = currentTask.issues.find(({ issue_id }) => issue_id === call.input.issue_id);
    assert.ok(before);
    assert.equal(call.input.expected_revision, before.revision);
    const descriptionUpdate = call.input.desired.description !== undefined;
    const statusUpdate = call.input.desired.state_id !== undefined;
    assert.notEqual(descriptionUpdate, statusUpdate);
    const revision = before.issue_id === rootTaskIssueId
      ? rootRevision
      : descriptionUpdate ? cycleCorrectedRevision : cycleApprovedRevision;
    const field = descriptionUpdate ? "description" : "status";
    const beforeValue = descriptionUpdate ? before.description : before.status;
    const afterValue = descriptionUpdate ? call.input.desired.description : call.input.desired.state_id;
    const fresh = {
      ...before,
      revision,
      description: descriptionUpdate ? call.input.desired.description ?? null : before.description,
      status: statusUpdate ? call.input.desired.state_id ?? before.status : before.status,
    };
    currentTask = parseTaskSnapshot({
      ...currentTask,
      issues: currentTask.issues.map((issue) => issue.issue_id === fresh.issue_id ? fresh : issue),
    });
    managerCalls.push(`update:${call.input.issue_id}:${call.input.expected_revision}`);
    return parseTaskMcpResult({
      schema_version: call.schema_version,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome: "applied",
        effect_may_have_occurred: true,
        target: { kind: "issue", issue_id: call.input.issue_id },
        fresh_resource: fresh,
        concrete_diff: [{
          kind: "field_changed",
          issue_id: call.input.issue_id,
          field,
          before: beforeValue,
          after: afterValue,
        }],
        sanitized_reason: null,
      },
    }, call);
  });
  manager.create_issue = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    const parent = currentTask.issues.find(({ issue_id }) => issue_id === call.input.parent_issue_id);
    assert.ok(parent);
    assert.equal(call.input.expected_parent_revision, parent.revision);
    const fresh = {
      issue_id: call.input.issue_id,
      revision: cycleCreatedRevision,
      status: call.input.desired.state_id,
      title: call.input.desired.title,
      description: call.input.desired.description,
      parent_id: call.input.parent_issue_id,
      labels: call.input.desired.label_ids,
      delegate_id: call.input.desired.delegate_id,
      priority: call.input.desired.priority,
    };
    currentTask = parseTaskSnapshot({
      ...currentTask,
      issues: [...currentTask.issues, fresh],
    });
    managerCalls.push(`create:${call.input.parent_issue_id}:${call.input.expected_parent_revision}`);
    return parseTaskMcpResult({
      schema_version: call.schema_version,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome: "applied",
        effect_may_have_occurred: true,
        target: { kind: "issue", issue_id: fresh.issue_id },
        fresh_resource: fresh,
        concrete_diff: [{ kind: "issue_created", issue: fresh }],
        sanitized_reason: null,
      },
    }, call);
  };
  manager.create_issue_comment = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    const timestamp = "2026-08-02T02:00:00.000Z";
    const bodyDigest = createHash("sha256").update(call.input.body_markdown, "utf8").digest("hex");
    recordComments.push({
      comment_id: call.input.comment_id,
      issue_id: call.input.issue_id,
      provider_created_at: timestamp,
      provider_updated_at: timestamp,
      provider_edited_at: null,
      provider_archived_at: null,
      actor_id: "actor:symphony",
      body_digest: bodyDigest,
      body_markdown: call.input.body_markdown,
    });
    managerCalls.push(`comment:${call.input.issue_id}:${call.input.expected_issue_revision}`);
    return parseTaskMcpResult({
      schema_version: call.schema_version,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        outcome: "applied",
        effect_may_have_occurred: true,
        target: { kind: "comment", comment_id: call.input.comment_id, issue_id: call.input.issue_id },
        fresh_comment: {
          comment_id: call.input.comment_id,
          issue_id: call.input.issue_id,
          provider_created_at: timestamp,
          provider_updated_at: timestamp,
          provider_edited_at: null,
          provider_archived_at: null,
          actor_id: "actor:symphony",
          body_digest: bodyDigest,
        },
        sanitized_reason: null,
      },
    }, call);
  };
  manager.get_issue = async (call, providerExecution) => {
    callerAuthority.verifier.assert(providerExecution.caller, call);
    const issue = currentTask.issues.find(({ issue_id }) => issue_id === call.input.issue_id) ?? null;
    managerCalls.push(`get:${call.input.issue_id}`);
    return parseTaskMcpResult({
      schema_version: call.schema_version,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: { issue },
    }, call);
  };
  const f = await controlledFixture(
    appServer,
    manager,
    [
      TASK_MCP_CAPABILITIES.get_issue,
      TASK_MCP_CAPABILITIES.create_issue,
      TASK_MCP_CAPABILITIES.update_issue,
    ],
    8,
    2_000,
    async () => currentTask,
    async (issueId) => recordComments.filter((comment) => comment.issue_id === issueId),
  );

  try {
    assert.equal((await f.root.run(bootstrap())).outcome, "quiescent");
    assert.deepEqual(managerCalls, [
      `update:${rootId}:revision:root:1`,
      `get:${rootId}`,
      `create:${rootId}:${rootRevision}`,
      `get:${cycleId}`,
      `update:${cycleId}:${cycleCreatedRevision}`,
      `get:${cycleId}`,
      `comment:${cycleId}:${cycleCorrectedRevision}`,
      `update:${cycleId}:${cycleCorrectedRevision}`,
      `get:${cycleId}`,
    ]);
    assert.equal([...responses.values()].every(({ success }) => success), true);
    assert.equal((responses.get("tool:define")?.body as { readonly seal_digest?: unknown }).seal_digest, null);
    assert.equal(
      (responses.get("tool:correct-draft")?.body as { readonly seal_digest?: unknown }).seal_digest,
      null,
    );
    assert.match(
      String((responses.get("tool:approve")?.body as { readonly seal_digest?: unknown }).seal_digest),
      /^[0-9a-f]{64}$/u,
    );
    const sealedRead = responses.get("tool:read-sealed");
    assert.ok(sealedRead);
    assert.equal(readIssue(sealedRead).status, workflow.cycle_states.in_progress);
    assert.equal(readIssue(sealedRead).description, correctedCycleDraftDescription);
    assert.deepEqual(reviewedDraftDescriptions, [
      cycleDraftDescription,
      correctedCycleDraftDescription,
    ]);
    const sealed = currentTask.issues.find(({ issue_id }) => issue_id === cycleId);
    assert.equal(sealed?.description, correctedCycleDraftDescription);
    assert.equal(sealed?.revision, cycleApprovedRevision);
    assert.equal(f.toolLogs.length, 8);
  } finally {
    await f.root.close();
  }
});

test("a precondition conflict is re-observed in the same process, thread, and turn", async () => {
  const responses: Array<{ readonly success: boolean; readonly body: unknown }> = [];
  const revisions: string[] = [];
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
      return;
    }
    if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-root" } } },
        {
          method: "turn/started",
          params: {
            threadId: "thread-root",
            turn: { id: "turn-root", status: "inProgress", items: [], error: null },
          },
        },
        updateIssueToolCall("tool:conflict", "turn-root", "revision:root:1"),
      ]);
      return;
    }
    if (message.id === "tool:conflict") {
      const response = toolResponse(message);
      responses.push(response);
      const revision = (response.body as {
        readonly output?: { readonly fresh_resource?: { readonly revision?: unknown } };
      }).output?.fresh_resource?.revision;
      setImmediate(() => {
        server.send(updateIssueToolCall("tool:retry", "turn-root", String(revision)));
      });
      return;
    }
    if (message.id === "tool:retry") {
      responses.push(toolResponse(message));
      completedTurn(server);
    }
  });
  let currentTask = bootstrap().task;
  const manager = taskManager(async (call) => {
    revisions.push(call.input.expected_revision);
    if (revisions.length === 1) {
      currentTask = taskAtRootRevision(
        "revision:root:2",
        concurrentRootDescription,
      );
      return updateResult(call, "stale_before_effect", "revision:root:2");
    }
    return updateResult(call, "applied", "revision:root:3");
  });
  const f = await controlledFixture(
    appServer,
    manager,
    [TASK_MCP_CAPABILITIES.update_issue],
    4,
    2_000,
    async () => currentTask,
  );

  assert.equal((await f.root.run(bootstrap())).outcome, "quiescent");
  assert.deepEqual(revisions, ["revision:root:1", "revision:root:2"]);
  assert.equal(responses.length, 2);
  assert.equal(responses[0]?.success, true);
  assert.equal((responses[0]?.body as { output?: { outcome?: unknown } }).output?.outcome, "stale_before_effect");
  assert.equal(responses[1]?.success, true);
  assert.equal((responses[1]?.body as { output?: { outcome?: unknown } }).output?.outcome, "applied");
  assert.equal(appServer.spawns.length, 1);
  assert.equal(appServer.requests.filter(({ method }) => method === "thread/start").length, 1);
  assert.equal(appServer.requests.filter(({ method }) => method === "turn/start").length, 1);
  assert.deepEqual(
    f.toolLogs.map((entry) => (entry as { event: string }).event),
    ["root_tool_call_accepted", "root_tool_call_accepted"],
  );
  await f.root.close();
});

test("acceptance_unknown denial stays in-turn until an exact read unlocks a retry", async () => {
  const responses: Array<[string, { readonly success: boolean; readonly body: unknown }]> = [];
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
      return;
    }
    if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-root" } } },
        {
          method: "turn/started",
          params: {
            threadId: "thread-root",
            turn: { id: "turn-root", status: "inProgress", items: [], error: null },
          },
        },
        updateIssueToolCall("tool:unknown", "turn-root", "revision:root:1"),
      ]);
      return;
    }
    if (message.id === "tool:unknown") {
      responses.push([message.id, toolResponse(message)]);
      setImmediate(() => server.send(
        updateIssueToolCall("tool:blind-retry", "turn-root", "revision:root:1"),
      ));
      return;
    }
    if (message.id === "tool:blind-retry") {
      responses.push([message.id, toolResponse(message)]);
      setImmediate(() => server.send(getIssueToolCall("tool:fresh-read", "turn-root")));
      return;
    }
    if (message.id === "tool:fresh-read") {
      responses.push([message.id, toolResponse(message)]);
      setImmediate(() => server.send(
        updateIssueToolCall("tool:informed-retry", "turn-root", "revision:root:2"),
      ));
      return;
    }
    if (message.id === "tool:informed-retry") {
      responses.push([message.id, toolResponse(message)]);
      completedTurn(server);
    }
  });
  const managerCalls: string[] = [];
  let updates = 0;
  const manager = taskManager(async (call) => {
    updates += 1;
    managerCalls.push(`update:${call.input.expected_revision}`);
    if (updates === 1) {
      return parseTaskMcpResult({
        schema_version: 1,
        function: call.function,
        root_id: call.root_id,
        runtime_generation: call.runtime_generation,
        correlation_id: call.correlation_id,
        capability: call.capability,
        output: {
          outcome: "conflict_observed",
          effect_may_have_occurred: true,
          target: { kind: "issue", issue_id: call.input.issue_id },
          fresh_resource: null,
          concrete_diff: [],
          sanitized_reason: "Provider acceptance is unknown",
        },
      }, call);
    }
    return updateResult(call, "applied", "revision:root:3");
  });
  manager.get_issue = async (call) => {
    managerCalls.push(`read:${call.input.issue_id}`);
    currentTask = taskAtRootRevision(
      "revision:root:2",
      concurrentRootDescription,
    );
    return parseTaskMcpResult({
      schema_version: 1,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: {
        issue: {
          issue_id: call.input.issue_id,
          revision: "revision:root:2",
          status: "Todo",
          title: "Build the Root runtime",
          description: concurrentRootDescription,
          parent_id: null,
          labels: ["label:root"],
          delegate_id: "actor:agent",
          priority: 1,
        },
      },
    }, call);
  };
  let currentTask = bootstrap().task;
  const f = await controlledFixture(
    appServer,
    manager,
    [TASK_MCP_CAPABILITIES.get_issue, TASK_MCP_CAPABILITIES.update_issue],
    4,
    2_000,
    async () => currentTask,
  );

  assert.equal((await f.root.run(bootstrap())).outcome, "quiescent");
  assert.deepEqual(managerCalls, [
    "update:revision:root:1",
    `read:${rootId}`,
    "update:revision:root:2",
  ]);
  assert.deepEqual(responses.map(([id, response]) => [
    id,
    response.success,
    response.success
      ? (response.body as { output?: { outcome?: unknown } }).output?.outcome ?? "read"
      : (response.body as { code?: unknown }).code,
  ]), [
    ["tool:unknown", true, "conflict_observed"],
    ["tool:blind-retry", false, "acceptance_unknown"],
    ["tool:fresh-read", true, "read"],
    ["tool:informed-retry", true, "applied"],
  ]);
  assert.equal(appServer.spawns.length, 1);
  assert.equal(appServer.requests.filter(({ method }) => method === "thread/start").length, 1);
  assert.equal(appServer.requests.filter(({ method }) => method === "turn/start").length, 1);
  await f.root.close();
});

test("unresolved acceptance replaces model quiescence with a visible stopped outcome", async () => {
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
      return;
    }
    if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-root" } } },
        {
          method: "turn/started",
          params: {
            threadId: "thread-root",
            turn: { id: "turn-root", status: "inProgress", items: [], error: null },
          },
        },
        updateIssueToolCall("tool:unknown", "turn-root", "revision:root:1"),
      ]);
      return;
    }
    if (message.id === "tool:unknown") {
      server.send({
        method: "turn/completed",
        params: {
          threadId: "thread-root",
          turn: {
            id: "turn-root",
            status: "completed",
            error: null,
            items: [{
              id: "answer",
              type: "agentMessage",
              text: JSON.stringify({
                schema_version: 1,
                root_id: rootId,
                runtime_generation: generation,
                correlation_id: "corr:bootstrap:1",
                outcome: "quiescent",
                sanitized_reason: null,
              }),
            }],
          },
        },
      });
    }
  });
  const manager = taskManager(async (call) => parseTaskMcpResult({
    schema_version: 1,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
    output: {
      outcome: "conflict_observed",
      effect_may_have_occurred: true,
      target: { kind: "issue", issue_id: call.input.issue_id },
      fresh_resource: null,
      concrete_diff: [],
      sanitized_reason: "Provider acceptance is unknown",
    },
  }, call));
  const f = await controlledFixture(appServer, manager);

  assert.deepEqual(await f.root.run(bootstrap()), {
    schema_version: 1,
    root_id: rootId,
    runtime_generation: generation,
    correlation_id: "corr:bootstrap:1",
    outcome: "stopped",
    sanitized_reason: "Root tool effect acceptance remains unresolved",
  });
  await f.root.close();
});

test("explicit model stop remains authoritative while acceptance is unresolved", async () => {
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
      return;
    }
    if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-root" } } },
        {
          method: "turn/started",
          params: {
            threadId: "thread-root",
            turn: { id: "turn-root", status: "inProgress", items: [], error: null },
          },
        },
        updateIssueToolCall("tool:unknown", "turn-root", "revision:root:1"),
      ]);
      return;
    }
    if (message.id === "tool:unknown") {
      server.send({
        method: "turn/completed",
        params: {
          threadId: "thread-root",
          turn: {
            id: "turn-root",
            status: "completed",
            error: null,
            items: [{
              id: "answer",
              type: "agentMessage",
              text: JSON.stringify({
                schema_version: 1,
                root_id: rootId,
                runtime_generation: generation,
                correlation_id: "corr:bootstrap:1",
                outcome: "stopped",
                sanitized_reason: "Fresh acceptance read is still required",
              }),
            }],
          },
        },
      });
    }
  });
  const manager = taskManager(async (call) => parseTaskMcpResult({
    schema_version: 1,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
    output: {
      outcome: "conflict_observed",
      effect_may_have_occurred: true,
      target: { kind: "issue", issue_id: call.input.issue_id },
      fresh_resource: null,
      concrete_diff: [],
      sanitized_reason: "Provider acceptance is unknown",
    },
  }, call));
  const f = await controlledFixture(appServer, manager);

  const outcome = await f.root.run(bootstrap());
  assert.equal(outcome.outcome, "stopped");
  assert.equal(
    "sanitized_reason" in outcome ? outcome.sanitized_reason : null,
    "Fresh acceptance read is still required",
  );
  await f.root.close();
});

test("stale-generation, old-turn, and late-output tool calls are fenced before effects", async () => {
  let staleEffects = 0;
  const staleResponses: Array<{ readonly success: boolean; readonly body: unknown }> = [];
  const staleServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
      return;
    }
    if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-root" } } },
        {
          method: "turn/started",
          params: {
            threadId: "thread-root",
            turn: { id: "turn-root", status: "inProgress", items: [], error: null },
          },
        },
        updateIssueToolCall(
          "tool:stale-generation",
          "turn-root",
          "revision:root:1",
          parseRuntimeGeneration(generation + 1),
        ),
      ]);
      return;
    }
    if (message.id === "tool:stale-generation") staleResponses.push(toolResponse(message));
    if (message.method === "turn/interrupt") server.send({ id: message.id, result: {} });
  });
  const stale = await controlledFixture(staleServer, taskManager(async (call) => {
    staleEffects += 1;
    return updateResult(call, "applied", "revision:root:2");
  }));

  await assert.rejects(stale.root.run(bootstrap()), /root_reconcill_boundary_failed/u);
  await tick();
  assert.equal(staleEffects, 0);
  assert.equal(staleResponses[0]?.success, false);
  assert.equal((staleResponses[0]?.body as { code?: unknown }).code, "stale_generation");
  await stale.root.close();

  let fencedEffects = 0;
  const fencedResponses: Array<[string, { readonly success: boolean; readonly body: unknown }]> = [];
  const fencedServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
      return;
    }
    if (message.method === "turn/start") {
      server.sendMany([
        { id: message.id as string, result: { turn: { id: "turn-root" } } },
        {
          method: "turn/started",
          params: {
            threadId: "thread-root",
            turn: { id: "turn-root", status: "inProgress", items: [], error: null },
          },
        },
        updateIssueToolCall("tool:old-turn", "turn-old", "revision:root:1"),
      ]);
      return;
    }
    if (message.id === "tool:old-turn") {
      fencedResponses.push([message.id, toolResponse(message)]);
      completedTurn(server);
      setImmediate(() => {
        server.send(updateIssueToolCall("tool:late-output", "turn-root", "revision:root:1"));
      });
      return;
    }
    if (message.id === "tool:late-output") fencedResponses.push([message.id, toolResponse(message)]);
  });
  const fenced = await controlledFixture(fencedServer, taskManager(async (call) => {
    fencedEffects += 1;
    return updateResult(call, "applied", "revision:root:2");
  }));

  assert.equal((await fenced.root.run(bootstrap())).outcome, "quiescent");
  await tick();
  await tick();
  assert.equal(fencedEffects, 0);
  assert.deepEqual(fencedResponses.map(([id, response]) => [
    id,
    response.success,
    (response.body as { code?: unknown }).code,
  ]), [["tool:old-turn", false, "canceled"]]);
  await fenced.root.close();
});

test("factory restart requires exactly the next generation and a fresh bootstrap", async () => {
  const rootHome = await mkdtemp(path.join(os.tmpdir(), "symphony-r52-restart-"));
  await mkdir(path.join(rootHome, "symphony"));
  const nextGeneration = parseRuntimeGeneration(generation + 1);
  const transports = new FakeTransportFactory();
  transports.scripts.push(
    [completed("corr:bootstrap:1")],
    [completed("corr:bootstrap:2", "quiescent", nextGeneration)],
  );
  const factory = new RootReconcillFactory(transports, {
    create: (target) => Object.freeze({
      target,
      specs: Object.freeze([]) as readonly RootToolSpec[],
      hasPendingAcceptance: () => false,
      bindings: () => Object.freeze([]) as readonly RootToolBinding[],
    }),
  }, {
    max_tool_calls: 3,
    turn_timeout_ms: 2_000,
    log: () => undefined,
  });
  const first = await factory.create({ root_id: rootId, runtime_generation: generation, root_home: rootHome });
  const source = bootstrap();
  const previousDigest = rootObservationDigest(source.task, source.git);
  await first.run(source);
  await first.close();

  await assert.rejects(
    factory.create({ root_id: rootId, runtime_generation: generation, root_home: rootHome }),
    /invalid_restart_generation/u,
  );
  await assert.rejects(
    factory.create({
      root_id: rootId,
      runtime_generation: parseRuntimeGeneration(nextGeneration + 1),
      root_home: rootHome,
    }),
    /invalid_restart_generation/u,
  );
  assert.equal(transports.created.length, 1);

  const restarted = await factory.create({
    root_id: rootId,
    runtime_generation: nextGeneration,
    root_home: rootHome,
  });
  await assert.rejects(
    restarted.run(diff(
      previousDigest,
      "sha256:restart-diff",
      "corr:restart:diff",
      nextGeneration,
    )),
    /root_bootstrap_required/u,
  );
  assert.equal(transports.created[1]?.requests.length, 0);

  assert.equal((await restarted.run(bootstrap("corr:bootstrap:2", nextGeneration))).outcome, "quiescent");
  assert.equal(transports.created.length, 2);
  assert.notEqual(transports.created[0]?.threadId, transports.created[1]?.threadId);
  assert.equal(transports.created[1]?.requests.length, 1);
  assert.equal(
    JSON.parse(transports.created[1]?.requests[0]?.input ?? "{}").input_kind,
    "bootstrap",
  );
  assert.equal((await new RootContinuityStore(rootHome).load()).runtime_generation, nextGeneration);
  await restarted.close();
});

test("factory does not treat an unreadable continuity entry as a fresh generation", async () => {
  const rootHome = await mkdtemp(path.join(os.tmpdir(), "symphony-r52-invalid-state-"));
  await mkdir(path.join(rootHome, "symphony"));
  await mkdir(new RootContinuityStore(rootHome).statePath);
  const transports = new FakeTransportFactory();
  const factory = new RootReconcillFactory(transports, {
    create: (target) => Object.freeze({
      target,
      specs: Object.freeze([]) as readonly RootToolSpec[],
      hasPendingAcceptance: () => false,
      bindings: () => Object.freeze([]) as readonly RootToolBinding[],
    }),
  }, {
    max_tool_calls: 3,
    turn_timeout_ms: 2_000,
    log: () => undefined,
  });

  await assert.rejects(
    factory.create({ root_id: rootId, runtime_generation: generation, root_home: rootHome }),
    /root_continuity_invalid/u,
  );
  assert.equal(transports.created.length, 0);
});

test("factory validates continuity infrastructure before allocating a transport", async () => {
  const missingHome = await mkdtemp(path.join(os.tmpdir(), "symphony-r52-missing-state-dir-"));
  const unwritableHome = await mkdtemp(path.join(os.tmpdir(), "symphony-r52-unwritable-state-dir-"));
  const unwritableDirectory = path.join(unwritableHome, "symphony");
  await mkdir(unwritableDirectory);
  await chmod(unwritableDirectory, 0o500);
  const transports = new FakeTransportFactory();
  const factory = new RootReconcillFactory(transports, toolFactory, {
    max_tool_calls: 3,
    turn_timeout_ms: 2_000,
    log: () => undefined,
  });

  try {
    await assert.rejects(
      factory.create({ root_id: rootId, runtime_generation: generation, root_home: missingHome }),
      /root_continuity_invalid/u,
    );
    await assert.rejects(
      factory.create({ root_id: rootId, runtime_generation: generation, root_home: unwritableHome }),
      /root_continuity_invalid/u,
    );
  } finally {
    await chmod(unwritableDirectory, 0o700);
  }
  assert.equal(transports.created.length, 0);
});

test("factory rejects concurrent Root Home aliasing before transport allocation", async () => {
  const rootHome = await mkdtemp(path.join(os.tmpdir(), "symphony-r52-home-alias-"));
  await mkdir(path.join(rootHome, "symphony"));
  const transports = new FakeTransportFactory();
  transports.scripts.push([], []);
  const factory = new RootReconcillFactory(transports, {
    create: (target) => Object.freeze({
      target,
      specs: Object.freeze([]) as readonly RootToolSpec[],
      hasPendingAcceptance: () => false,
      bindings: () => Object.freeze([]) as readonly RootToolBinding[],
    }),
  }, {
    max_tool_calls: 3,
    turn_timeout_ms: 2_000,
    log: () => undefined,
  });
  const first = await factory.create({ root_id: rootId, runtime_generation: generation, root_home: rootHome });

  await assert.rejects(
    factory.create({
      root_id: parseRootIssueId("LIN-2"),
      runtime_generation: generation,
      root_home: rootHome,
    }),
    /root_reconcill_resource_alias/u,
  );
  assert.equal(transports.created.length, 1);

  await first.close();
  const replacement = await factory.create({
    root_id: rootId,
    runtime_generation: generation,
    root_home: rootHome,
  });
  assert.equal(transports.created.length, 2);
  await replacement.close();
});

test("close waits for an active turn and its continuity cleanup to settle", async () => {
  let turnSequence = 0;
  let releaseActiveTurn: (() => void) | null = null;
  const activeTurnStarted = new Promise<void>((resolve) => { releaseActiveTurn = resolve; });
  const appServer = controlledAppServer((message, server) => {
    if (initializeResponse(message, server) || message.method === "initialized") return;
    if (message.method === "thread/start") {
      server.send({ id: message.id, result: { thread: { id: "thread-root" } } });
      return;
    }
    if (message.method === "turn/start") {
      turnSequence += 1;
      const turnId = `turn:${turnSequence}`;
      server.sendMany([
        { id: message.id as string, result: { turn: { id: turnId } } },
        {
          method: "turn/started",
          params: {
            threadId: "thread-root",
            turn: { id: turnId, status: "inProgress", items: [], error: null },
          },
        },
      ]);
      if (turnSequence === 1) completedTurn(server, turnId);
      else (releaseActiveTurn as (() => void) | null)?.();
    }
  });
  const f = await controlledFixture(appServer, taskManager(() => {
    return Promise.reject(new Error("unexpected_update_issue"));
  }));
  const source = bootstrap();
  const firstDigest = rootObservationDigest(source.task, source.git);
  await f.root.run(source);

  let runSettled = false;
  const running = f.root.run(diff(firstDigest, "sha256:close", "corr:diff:close"))
    .finally(() => { runSettled = true; });
  await activeTurnStarted;
  const runWasSettledWhenCloseResolved = await f.root.close().then(() => runSettled);
  const outcome = await running;

  assert.equal(runWasSettledWhenCloseResolved, true);
  assert.equal(outcome.outcome, "canceled");
  const continuity = await new RootContinuityStore(f.rootHome).load();
  assert.equal(continuity.accepted_observation_digest, firstDigest);
  assert.equal(continuity.in_flight_correlation, "corr:diff:close");
});
