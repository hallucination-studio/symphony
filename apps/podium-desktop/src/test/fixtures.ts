import type { ConductorDetailView, DesktopOverviewView } from "../ui/types";

export const connectedOverview: DesktopOverviewView = {
  linearConnection: {
    status: "connected",
    workspaceName: "Acme",
    observedAt: "2026-07-16T09:45:00+08:00",
  },
  projects: [{
    projectId: "project-1",
    name: "Symphony",
    observedAt: "2026-07-16T09:45:00+08:00",
  }],
  conductors: [{
    conductorId: "conductor-1",
    displayName: "Studio conductor",
    status: "online",
    projectName: "Symphony",
    repositoryDisplayName: "acme/symphony",
    baseBranch: "main",
    observedAt: "2026-07-16T09:44:00+08:00",
  }],
  recentLogs: [{
    eventKind: "runtime_info",
    summary: "A bounded runtime message",
    occurredAt: "2026-07-16T09:43:00+08:00",
  }],
  observedAt: "2026-07-16T09:45:00+08:00",
};

export const conductorDetail: ConductorDetailView = {
  summary: connectedOverview.conductors[0]!,
  profiles: [{
    profileId: "profile-1",
    displayName: "Personal ChatGPT",
    authenticationMethod: "chatgpt",
    codexTurnSettings: {
      model: "gpt-5",
      reasoningEffort: "high",
      isFastModeEnabled: true,
    },
    executionPolicy: {
      sandboxMode: "workspace_write",
      commandAllowlist: [],
      commandDenylist: [],
    },
    readiness: "ready",
    isActive: true,
    sanitizedAccountLabel: "murphy@example.com",
    observedAt: "2026-07-16T09:42:00+08:00",
  }],
  logs: [],
};
