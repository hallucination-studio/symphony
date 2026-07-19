import type {
  ConductorDetailView,
  DesktopOverviewView,
  RootDetailView,
} from "../ui/types";

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
  nextAction: {
    kind: "approve_plan",
    summary: "Approve the current plan",
    impact: "SYM-42 will wait before any Work leaf starts.",
    actionLabel: "Open in Linear",
    linearUrl: "https://linear.app/acme/issue/SYM-42",
  },
  conductors: [
    {
      conductorId: "conductor-1",
      displayName: "Studio conductor",
      status: "ready",
      projectName: "Symphony",
      repositoryDisplayName: "acme/symphony",
      baseBranch: "main",
      observedAt: "2026-07-16T09:44:00+08:00",
    },
  ],
  activeRoots: [
    {
      rootIssueId: "root-42",
      identifier: "SYM-42",
      title: "Ship the V1 desktop",
      status: "Needs your attention",
      currentNodeSummary: "Plan approval",
      linearUrl: "https://linear.app/acme/issue/SYM-42",
      observedAt: "2026-07-16T09:43:00+08:00",
    },
  ],
  reviewRoots: [],
  recentProblems: [],
  usage: {
    inputTokens: 8000,
    cachedInputTokens: 2400,
    outputTokens: 1600,
    reasoningOutputTokens: 480,
    totalTokens: 12480,
    completedRootCount: 3,
    observedAt: "2026-07-16T09:40:00+08:00",
    isStale: true,
  },
  observedAt: "2026-07-16T09:45:00+08:00",
};

export const rootDetail: RootDetailView = {
  summary: connectedOverview.activeRoots[0]!,
  workflowNodes: [
    {
      issueId: "plan-approval",
      kind: "plan_approval",
      state: "In Progress",
      order: 0,
      depth: 0,
      title: "[Human Action] Approve Plan",
      isCanceled: false,
      isCurrent: true,
      waitingReason: "Approval happens in Linear.",
    },
    {
      issueId: "work-1",
      kind: "work_leaf",
      state: "Todo",
      order: 1,
      depth: 0,
      title: "Implement Desktop experience",
      isCanceled: false,
    },
  ],
  usage: connectedOverview.usage,
  events: [
    {
      eventKind: "waiting_provider",
      summary: "Waiting for plan approval",
      occurredAt: "2026-07-16T09:43:00+08:00",
    },
  ],
  nextAction: connectedOverview.nextAction!,
};

export const conductorDetail: ConductorDetailView = {
  summary: connectedOverview.conductors[0]!,
  profiles: [
    {
      profileId: "profile-1",
      displayName: "Personal ChatGPT",
      authenticationMethod: "chatgpt",
      codexTurnSettings: {
        model: "gpt-5",
        reasoningEffort: "high",
        isFastModeEnabled: true,
      },
      readiness: "ready",
      isActive: true,
      sanitizedAccountLabel: "murphy@example.com",
      observedAt: "2026-07-16T09:42:00+08:00",
    },
    {
      profileId: "profile-2",
      displayName: "API automation",
      authenticationMethod: "api_key",
      codexTurnSettings: {
        model: "gpt-5",
        reasoningEffort: "high",
        isFastModeEnabled: false,
      },
      readiness: "login-required",
      isActive: false,
      observedAt: "2026-07-16T09:42:00+08:00",
    },
  ],
  events: [],
};
