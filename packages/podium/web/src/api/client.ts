import type {
  AuthUser,
  Bootstrap,
  ConductorRecord,
  EnrollmentStatus,
  EnrollmentToken,
  InstanceLogs,
  LinearAppConfig,
  LinearScope,
  OnboardingProgress,
  ManagedRunsReport,
  PodiumConfig,
  RepositoryMapping,
  RepositoryMode,
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
  // ===== Public runtime config =====
  config(): Promise<PodiumConfig> {
    return request<PodiumConfig>("/api/v1/config");
  },

  // ===== Auth =====
  register(
    email: string,
    password: string,
    turnstileToken: string,
  ): Promise<{ user: AuthUser }> {
    return request("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, turnstile_token: turnstileToken }),
    });
  },

  login(
    email: string,
    password: string,
    turnstileToken: string,
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

  startLinear(): Promise<{ authorization_url: string }> {
    return request("/api/v1/linear/installations/oauth", { method: "POST" });
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

  runtimes(): Promise<{ runtimes: RuntimeRecord[]; conductors?: ConductorRecord[] }> {
    return request("/api/v1/runtimes");
  },

  runtime(id: string): Promise<RuntimeRecord> {
    return request<RuntimeRecord>(
      `/api/v1/runtimes/${encodeURIComponent(id)}`,
    );
  },

  // Tail of a Performer's log, as reported by its Conductor. `order=desc`
  // returns newest-first; the backend serves the cached tail synchronously.
  instanceLogs(
    conductorId: string,
    instanceId: string,
    opts: { tail?: number; order?: "asc" | "desc" } = {},
  ): Promise<{ logs: InstanceLogs }> {
    const params = new URLSearchParams();
    if (opts.tail != null) params.set("tail", String(opts.tail));
    if (opts.order) params.set("order", opts.order);
    const query = params.toString();
    return request(
      `/api/v1/runtimes/${encodeURIComponent(conductorId)}/instances/${encodeURIComponent(
        instanceId,
      )}/logs${query ? `?${query}` : ""}`,
    );
  },

  managedRuns(): Promise<ManagedRunsReport> {
    return request<ManagedRunsReport>("/api/v1/managed-runs");
  },
};
