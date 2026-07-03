import type {
  AuthUser,
  Bootstrap,
  EnrollmentStatus,
  EnrollmentToken,
  LinearAppConfig,
  LinearScope,
  OnboardingProgress,
  RepositoryMapping,
  RepositoryMode,
  RunSummary,
  RuntimeRecord,
  SmokeCheckResult,
} from "./types";

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
    // Send/receive the podium_session cookie on every request.
    credentials: "include",
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

// Typed client covering every Podium BFF endpoint. The backend now derives the
// workspace from the session cookie, so requests never carry a workspace_id.
export const api = {
  // ===== Auth =====
  register(
    email: string,
    password: string,
    turnstileToken = "dev",
  ): Promise<{ user: AuthUser }> {
    return request("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, turnstile_token: turnstileToken }),
    });
  },

  login(
    email: string,
    password: string,
    turnstileToken = "dev",
  ): Promise<{ user: AuthUser }> {
    return request("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, turnstile_token: turnstileToken }),
    });
  },

  logout(): Promise<{ ok: boolean }> {
    return request("/api/v1/auth/logout", { method: "POST" });
  },

  me(): Promise<{ user: AuthUser }> {
    return request("/api/v1/auth/me");
  },

  // ===== Account / Linear application =====
  setLinearApp(input: {
    client_id: string;
    client_secret: string;
    redirect_uri?: string;
  }): Promise<{ linear_app: LinearAppConfig }> {
    return request("/api/v1/account/linear-app", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  clearLinearApp(): Promise<{ ok: boolean; linear_app: null }> {
    return request("/api/v1/account/linear-app", { method: "DELETE" });
  },

  // ===== Onboarding / workspace =====
  bootstrap(): Promise<Bootstrap> {
    return request<Bootstrap>("/api/v1/bootstrap");
  },

  onboardingStatus(): Promise<OnboardingProgress> {
    return request<OnboardingProgress>("/api/v1/onboarding/status");
  },

  startLinear(): Promise<{ authorization_url: string; workspace_id: string }> {
    return request("/api/v1/onboarding/linear/start", { method: "POST" });
  },

  linearScope(): Promise<LinearScope> {
    return request<LinearScope>("/api/v1/onboarding/linear/scope");
  },

  saveScope(
    teams: string[],
    projects: string[],
  ): Promise<{ onboarding: OnboardingProgress }> {
    return request("/api/v1/onboarding/scope", {
      method: "POST",
      body: JSON.stringify({ teams, projects }),
    });
  },

  saveRepository(
    mode: RepositoryMode,
    value: string,
  ): Promise<{ repository: RepositoryMapping; onboarding: OnboardingProgress }> {
    return request("/api/v1/onboarding/repository", {
      method: "POST",
      body: JSON.stringify({ mode, value }),
    });
  },

  enrollmentToken(): Promise<EnrollmentToken> {
    return request<EnrollmentToken>("/api/v1/onboarding/runtime/enrollment-token", {
      method: "POST",
    });
  },

  runtimeStatus(): Promise<EnrollmentStatus> {
    return request<EnrollmentStatus>("/api/v1/onboarding/runtime/status");
  },

  runSmokeCheck(): Promise<SmokeCheckResult> {
    return request("/api/v1/onboarding/smoke-check", { method: "POST" });
  },

  smokeCheckResult(): Promise<SmokeCheckResult> {
    return request<SmokeCheckResult>("/api/v1/onboarding/smoke-check/result");
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
