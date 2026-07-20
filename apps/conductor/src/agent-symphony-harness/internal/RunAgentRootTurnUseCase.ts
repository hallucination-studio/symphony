import type { JsonValue } from "@symphony/contracts";

import type { PerformerCommandBroker } from "../../performer-turns/api/PerformerProcessInterface.js";
import type { V3RootRunView } from "../../root-workflow/api/Models.js";
import { assessRootDispatch } from "../../root-scheduling/internal/RootDispatchAssessmentPolicy.js";

interface RootTurnProfile {
  profileId: string;
  codexTurnSettings: {
    model: string;
    reasoningEffort: string;
    isFastModeEnabled: boolean;
  };
  executionPolicy: {
    sandboxMode: string;
    commandAllowlist: Array<{ executable: string; argvPrefix: string[] }>;
    commandDenylist: Array<{ executable: string; argvPrefix: string[] }>;
  };
}

interface RootTurnDependencies {
  reconstruct(rootIssueId: string): Promise<V3RootRunView>;
  context: {
    build(input: { rootIssueId: string; view: V3RootRunView; git: {
      items: JsonValue[]; cap: number; hasMore: boolean;
      includeErrors: Array<{ code: string; sanitized_reason: string }>;
    } }): Promise<{
      json: string; markdown: string; contextBytes: number; contextDigest: string;
    }>;
  };
  profiles: { get(profileId: string): Promise<RootTurnProfile | undefined> };
  broker(input: {
    turnId: string;
    view: V3RootRunView;
    performerId: string;
  }): PerformerCommandBroker;
  performer: {
    runRootTurn(input: {
      profileId: string;
      workspaceRoot: string;
      command: JsonValue;
      broker: PerformerCommandBroker;
    }): Promise<{ result: JsonValue }>;
  };
  observe(input: {
    turnId: string;
    rootIssueId: string;
    freshView: V3RootRunView;
    result?: JsonValue;
    sanitizedFailure?: string;
  }): Promise<void>;
  turnId(): string;
  now(): string;
  limits: {
    maxWallTimeMs: number;
    maxContextBytes: number;
    maxBrokerCalls: number;
    maxMutations: number;
  };
}

export type RunAgentRootTurnResult =
  | { kind: "not_started"; readiness: "waiting_human" | "needs_attention" | "terminal" }
  | { kind: "completed"; result: JsonValue }
  | { kind: "failed"; sanitizedFailure: string };

export class RunAgentRootTurnUseCase {
  constructor(private readonly dependencies: RootTurnDependencies) {}

  async run(rootIssueId: string): Promise<RunAgentRootTurnResult> {
    const view = await this.dependencies.reconstruct(rootIssueId);
    const assessment = assessRootDispatch(view);
    if (assessment.readiness !== "runnable") {
      return { kind: "not_started", readiness: assessment.readiness };
    }
    const managed = view.managedComment;
    const workspace = view.gitWorkspace;
    if (!managed?.performerId || !workspace || !view.profile) {
      return { kind: "not_started", readiness: "needs_attention" };
    }
    const profile = await this.dependencies.profiles.get(
      managed.performerProfileId,
    );
    if (!profile || profile.profileId !== managed.performerProfileId) {
      return { kind: "not_started", readiness: "needs_attention" };
    }
    const context = await this.dependencies.context.build({
      rootIssueId,
      view,
      git: {
        items: [{
          branch: workspace.branch,
          head: workspace.head,
          status: workspace.status,
        }],
        cap: 1,
        hasMore: false,
        includeErrors: [],
      },
    });
    if (context.contextBytes > this.dependencies.limits.maxContextBytes) {
      return { kind: "not_started", readiness: "needs_attention" };
    }
    const turnId = this.dependencies.turnId();
    const command = rootTurnCommand(
      turnId,
      view,
      profile,
      context,
      this.dependencies.now(),
      this.dependencies.limits,
    );
    const broker = this.dependencies.broker({
      turnId,
      view,
      performerId: managed.performerId,
    });
    let result: JsonValue | undefined;
    let sanitizedFailure: string | undefined;
    try {
      result = (await this.dependencies.performer.runRootTurn({
        profileId: profile.profileId,
        workspaceRoot: workspace.worktreePath,
        command,
        broker,
      })).result;
    } catch {
      sanitizedFailure = "root_turn_process_failed";
    }
    const freshView = await this.dependencies.reconstruct(rootIssueId);
    await this.dependencies.observe({
      turnId,
      rootIssueId,
      freshView,
      ...(result === undefined ? {} : { result }),
      ...(sanitizedFailure === undefined ? {} : { sanitizedFailure }),
    });
    return result === undefined
      ? { kind: "failed", sanitizedFailure: sanitizedFailure! }
      : { kind: "completed", result };
  }
}

function rootTurnCommand(
  turnId: string,
  view: V3RootRunView,
  profile: RootTurnProfile,
  context: { json: string; markdown: string; contextDigest: string },
  startedAt: string,
  limits: RootTurnDependencies["limits"],
): JsonValue {
  return {
    protocol_version: "1",
    turn_id: turnId,
    root_issue_id: view.root.issueId,
    performer_profile_id: profile.profileId,
    performer_id: view.managedComment!.performerId!,
    codex_turn_settings: {
      model: profile.codexTurnSettings.model,
      reasoning_effort: profile.codexTurnSettings.reasoningEffort,
      is_fast_mode_enabled: profile.codexTurnSettings.isFastModeEnabled,
    },
    execution_policy: {
      sandbox_mode: profile.executionPolicy.sandboxMode,
      command_allowlist: profile.executionPolicy.commandAllowlist.map(rule),
      command_denylist: profile.executionPolicy.commandDenylist.map(rule),
    },
    root_context: { json: context.json, markdown: context.markdown },
    context_digest: context.contextDigest,
    command_channel: {
      kind: "inherited_framed_channel", request_fd: 3, response_fd: 4,
    },
    workspace_root: view.gitWorkspace!.worktreePath,
    started_at: startedAt,
    turn_limits: {
      max_wall_time_ms: limits.maxWallTimeMs,
      max_context_bytes: limits.maxContextBytes,
      max_broker_calls: limits.maxBrokerCalls,
      max_mutations: limits.maxMutations,
    },
  };
}

function rule(value: { executable: string; argvPrefix: string[] }) {
  return { executable: value.executable, argv_prefix: value.argvPrefix };
}
