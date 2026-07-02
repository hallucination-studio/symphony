import type {
  Bootstrap,
  EnrollmentStatus,
  LinearScope,
  OnboardingProgress,
  RepositoryMapping,
  RepositoryMode,
  RunSummary,
  RuntimeRecord,
  SmokeCheckResult,
} from "./types";

export const DEFAULT_WORKSPACE_ID = "default";

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    ...init,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const err = (data as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(
      response.status,
      err?.message ?? `Request failed: ${response.status}`,
      err?.code,
    );
  }

  return data as T;
}

function withWorkspace(path: string, workspaceId: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}workspace_id=${encodeURIComponent(workspaceId)}`;
}

// Typed client covering every Podium BFF endpoint.
export const api = {
  bootstrap(workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<Bootstrap> {
    return request<Bootstrap>(withWorkspace("/api/v1/bootstrap", workspaceId));
  },

  onboardingStatus(
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<OnboardingProgress> {
    return request<OnboardingProgress>(
      withWorkspace("/api/v1/onboarding/status", workspaceId),
    );
  },

  startLinear(
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<{ authorization_url: string; workspace_id: string }> {
    return request("/api/v1/onboarding/linear/start", {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
  },

  linearScope(workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<LinearScope> {
    return request<LinearScope>(
      withWorkspace("/api/v1/onboarding/linear/scope", workspaceId),
    );
  },

  saveScope(
    workspaceId: string,
    teams: string[],
    projects: string[],
  ): Promise<{ onboarding: OnboardingProgress }> {
    return request("/api/v1/onboarding/scope", {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId, teams, projects }),
    });
  },

  saveRepository(
    workspaceId: string,
    mode: RepositoryMode,
    value: string,
  ): Promise<{ repository: RepositoryMapping; onboarding: OnboardingProgress }> {
    return request("/api/v1/onboarding/repository", {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId, mode, value }),
    });
  },

  enrollmentToken(
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<{ enrollment_token: string; workspace_id: string }> {
    return request("/api/v1/onboarding/runtime/enrollment-token", {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
  },

  runtimeStatus(
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<EnrollmentStatus> {
    return request<EnrollmentStatus>(
      withWorkspace("/api/v1/onboarding/runtime/status", workspaceId),
    );
  },

  runSmokeCheck(
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<SmokeCheckResult> {
    return request("/api/v1/onboarding/smoke-check", {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
  },

  smokeCheckResult(
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<SmokeCheckResult> {
    return request<SmokeCheckResult>(
      withWorkspace("/api/v1/onboarding/smoke-check/result", workspaceId),
    );
  },

  runtimes(): Promise<{ runtimes: RuntimeRecord[] }> {
    return request("/api/v1/runtimes");
  },

  runtime(id: string): Promise<RuntimeRecord> {
    return request<RuntimeRecord>(
      `/api/v1/runtimes/${encodeURIComponent(id)}`,
    );
  },

  recentRuns(limit = 10): Promise<{ runs: RunSummary[] }> {
    return request(`/api/v1/runs/recent?limit=${encodeURIComponent(limit)}`);
  },

  run(id: string): Promise<RunSummary> {
    return request<RunSummary>(`/api/v1/runs/${encodeURIComponent(id)}`);
  },
};
