import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import {
  decodePodiumClientPodiumClientMessage,
  type JsonValue,
} from "@symphony/contracts";

import { App } from "./App";
import {
  decodeConductorDetailView,
  decodeDesktopOverviewView,
  decodeRootDetailView,
} from "./client/GeneratedPodiumClient";
import type {
  DesktopCommand,
  DesktopCommandResult,
  DesktopState,
  RepositorySelection,
} from "./ui/types";

let requestSequence = 0;

export function DesktopRuntime() {
  const [state, setState] = useState<DesktopState>({
    kind: "loading",
    objectLabel: "Desktop state",
  });

  const refresh = useCallback(async () => {
    try {
      const overview = await decodeDesktopOverviewView(
        await request({ kind: "get_desktop_overview" }),
      );
      if (overview.linearConnection.status === "disconnected") {
        setState({ kind: "linear-setup" });
        return;
      }
      if (overview.conductors.length === 0) {
        setState({
          kind: "conductor-setup",
          projects: overview.projects.map(({ projectId, name }) => ({
            id: projectId,
            name,
          })),
        });
        return;
      }
      const conductorDetail = await decodeConductorDetailView(
        await request({
          kind: "get_conductor_detail",
          conductor_id: overview.conductors[0]!.conductorId,
        }),
      );
      if (!conductorDetail.profiles.some((profile) => profile.isActive)) {
        setState({ kind: "profile-setup", conductorDetail });
        return;
      }
      setState((current) => ({
        kind: "ready",
        overview,
        conductorDetail,
        ...(current.kind === "ready" && current.rootDetail
          ? { rootDetail: current.rootDetail }
          : {}),
      }));
    } catch (error) {
      setState({
        kind: "unavailable",
        summary: "Symphony Desktop is unavailable",
        nextAction: sanitize(error),
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const onCommand = async (
    command: DesktopCommand,
  ): Promise<DesktopCommandResult> => {
    try {
      await request(commandBody(command));
      await refresh();
      return { kind: "confirmed" };
    } catch (error) {
      return { kind: "rejected", sanitizedReason: sanitize(error) };
    }
  };

  return (
    <App
      initialState={state}
      onCommand={onCommand}
      onSecret={async (conductorId, profileId, secret) => {
        const bytes = new TextEncoder().encode(secret);
        try {
          await request(
            {
              kind: "set_codex_api_key",
              conductor_id: conductorId,
              profile_id: profileId,
              secret_frame_length: bytes.byteLength,
            },
            bytes,
          );
          await refresh();
          return { kind: "confirmed" };
        } catch (error) {
          return { kind: "rejected", sanitizedReason: sanitize(error) };
        } finally {
          bytes.fill(0);
        }
      }}
      onChooseRepository={chooseRepository}
      onBeginCreateConductor={() => {
        void refresh();
      }}
      onOpenExternal={(url) => {
        void invoke("open_external_url", { url });
      }}
      onSelectRoot={async (rootId) => {
        const detail = await decodeRootDetailView(
          await request({ kind: "get_root_detail", root_issue_id: rootId }),
        );
        setState((current) =>
          current.kind === "ready" ? { ...current, rootDetail: detail } : current,
        );
      }}
      onSelectConductor={async (conductorId) => {
        const detail = await decodeConductorDetailView(
          await request({
            kind: "get_conductor_detail",
            conductor_id: conductorId,
          }),
        );
        setState((current) =>
          current.kind === "ready"
            ? { ...current, conductorDetail: detail }
            : current,
        );
      }}
    />
  );
}

async function request(body: JsonValue, secret?: Uint8Array): Promise<JsonValue> {
  const requestId = `desktop-${Date.now()}-${++requestSequence}`;
  const metadata = new TextEncoder().encode(
    `${JSON.stringify({
      protocol_version: "1",
      request_id: requestId,
      body,
    })}\n`,
  );
  const frame = new Uint8Array(metadata.byteLength + (secret?.byteLength ?? 0));
  frame.set(metadata);
  if (secret) frame.set(secret, metadata.byteLength);
  try {
    const responseBytes = await invoke<number[]>("podium_client_request", {
      frame: [...frame],
    });
    const response = decodePodiumClientPodiumClientMessage(
      JSON.parse(new TextDecoder().decode(new Uint8Array(responseBytes))),
    ) as unknown as { request_id: string; body: JsonValue };
    if (response.request_id !== requestId) {
      throw new Error("podium_client_correlation_mismatch");
    }
    if (isProtocolError(response.body)) {
      throw new Error(response.body.sanitized_reason);
    }
    return response.body;
  } finally {
    frame.fill(0);
  }
}

async function chooseRepository(): Promise<RepositorySelection | undefined> {
  const result = await invoke<{
    repository_handle: string;
    display_name: string;
    base_branches: string[];
  } | null>("select_repository_context");
  if (!result || result.base_branches.length === 0) return undefined;
  return {
    repositoryHandle: result.repository_handle,
    displayName: result.display_name,
    baseBranch: result.base_branches[0]!,
    baseBranches: result.base_branches,
  };
}

function commandBody(command: DesktopCommand): JsonValue {
  switch (command.kind) {
    case "connect_linear":
    case "reconnect_linear":
      return { kind: command.kind };
    case "create_conductor":
      return {
        kind: command.kind,
        project_id: command.projectId,
        repository: {
          repository_handle: command.repository.repositoryHandle,
          display_name: command.repository.displayName,
          base_branch: command.repository.baseBranch,
        },
      };
    case "create_root":
      return {
        kind: command.kind,
        project_id: command.projectId,
        ...(command.conductorId === undefined ? {} : { conductor_id: command.conductorId }),
        title: command.title,
        description: command.description,
      };
    case "start_conductor":
    case "stop_conductor":
    case "restart_conductor":
      return { kind: command.kind, conductor_id: command.conductorId };
    case "create_performer_profile":
      return {
        kind: command.kind,
        conductor_id: command.conductorId,
        display_name: command.displayName,
        authentication_method: command.authenticationMethod,
        codex_turn_settings: settings(command.codexTurnSettings),
        execution_policy: executionPolicy(command.executionPolicy),
      };
    case "update_performer_profile":
      return {
        kind: command.kind,
        conductor_id: command.conductorId,
        profile_id: command.profileId,
        display_name: command.displayName,
        codex_turn_settings: settings(command.codexTurnSettings),
        execution_policy: executionPolicy(command.executionPolicy),
      };
    case "start_codex_chatgpt_login":
    case "activate_performer_profile":
      return {
        kind: command.kind,
        conductor_id: command.conductorId,
        profile_id: command.profileId,
      };
    case "acknowledge_root_retry_block":
      return {
        kind: command.kind,
        root_issue_id: command.rootIssueId,
        retry_observed_at: command.retryObservedAt,
      };
  }
}

function settings(value: {
  model: string;
  reasoningEffort: string;
  isFastModeEnabled: boolean;
}) {
  return {
    model: value.model,
    reasoning_effort: value.reasoningEffort,
    is_fast_mode_enabled: value.isFastModeEnabled,
  };
}

function executionPolicy(value: {
  sandboxMode: string;
  commandAllowlist: { executable: string; argvPrefix: string[] }[];
  commandDenylist: { executable: string; argvPrefix: string[] }[];
}) {
  const rules = (items: typeof value.commandAllowlist) => items.map((rule) => ({
    executable: rule.executable,
    argv_prefix: rule.argvPrefix,
  }));
  return {
    sandbox_mode: value.sandboxMode,
    command_allowlist: rules(value.commandAllowlist),
    command_denylist: rules(value.commandDenylist),
  };
}

function isProtocolError(
  value: JsonValue,
): value is { [key: string]: JsonValue } & { sanitized_reason: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.sanitized_reason === "string" &&
    typeof value.code === "string"
  );
}

function sanitize(error: unknown): string {
  const value = error instanceof Error ? error.message : "desktop_request_failed";
  return value.replace(/\s+/g, " ").slice(0, 512);
}
