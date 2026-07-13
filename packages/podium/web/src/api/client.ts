import type {
  AuthUser,
  Bootstrap,
  ConductorRecord,
  EnrollmentStatus,
  EnrollmentToken,
  InstanceLogs,
  LinearApplication,
  LinearInstallations,
  LinearScope,
  OnboardingProgress,
  ManagedRunsReport,
  PerformerAccountState,
  PerformerCapabilities,
  PerformerCheckState,
  PerformerConfigurationSnapshot,
  PerformerControlError,
  PerformerControlEnvelope,
  PerformerControlEvent,
  PerformerControlOperation,
  PerformerControlResult,
  PerformerDeviceLoginRequest,
  PerformerLoginState,
  PerformerReadinessState,
  PerformerStatus,
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

  // ===== Linear application and installation =====
  linearApplication(): Promise<{ application: LinearApplication }> {
    return request("/api/v1/linear/application");
  },

  saveLinearApplication(input: {
    client_id: string;
    client_secret: string;
  }): Promise<{ application: LinearApplication }> {
    return request("/api/v1/linear/application", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  selectDefaultLinearApplication(): Promise<{ application: LinearApplication }> {
    return request("/api/v1/linear/application/default", { method: "POST" });
  },

  linearInstallations(): Promise<LinearInstallations> {
    return request("/api/v1/linear/installations");
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

  // ===== Provider-neutral Performer live control =====
  async performerStatus(conductorId: string): Promise<PerformerStatus> {
    const { control_result: result } = await performerRequest(
      performerPath(conductorId),
      "performer.status",
    );
    if (result.status === "failed") throw performerFailure(result);
    return {
      capabilities: required(result.capabilities, "capabilities"),
      readiness: required(result.readiness, "readiness"),
      account: required(result.account, "account"),
      login: required(result.login, "login"),
    };
  },

  performerLogin(
    conductorId: string,
    input: PerformerDeviceLoginRequest,
  ): Promise<PerformerControlEnvelope> {
    return performerRequest(
      `${performerPath(conductorId)}/login`,
      "performer.login",
      { method: "POST", body: JSON.stringify({ method: input.method }) },
    );
  },

  performerApiKeyLogin(
    conductorId: string,
    takeApiKey: () => string,
  ): Promise<PerformerControlEnvelope> {
    let apiKey = takeApiKey();
    let body = JSON.stringify({ method: "api_key", api_key: apiKey });
    const request = new Request(
      new URL(`${performerPath(conductorId)}/login`, window.location.origin),
      {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body,
      },
    );
    apiKey = "";
    body = "";
    return parseDispatchedPerformerResponse(
      fetch(request),
      "performer.login",
    );
  },

  deletePerformerSession(
    conductorId: string,
    action: "cancel_login" | "logout",
  ): Promise<PerformerControlEnvelope> {
    return performerRequest(
      `${performerPath(conductorId)}/session`,
      "performer.session.delete",
      { method: "DELETE", body: JSON.stringify({ action }) },
    );
  },

  performerConfiguration(conductorId: string): Promise<PerformerControlEnvelope> {
    return performerRequest(
      `${performerPath(conductorId)}/config`,
      "performer.config.read",
    );
  },

  updatePerformerConfiguration(
    conductorId: string,
    input: { setting: "api_base_url"; value: string },
  ): Promise<PerformerControlEnvelope> {
    return performerRequest(
      `${performerPath(conductorId)}/config`,
      "performer.config.write",
      { method: "PATCH", body: JSON.stringify(input) },
    );
  },

  checkPerformer(conductorId: string): Promise<PerformerControlEnvelope> {
    return performerRequest(
      `${performerPath(conductorId)}/check`,
      "performer.check",
      { method: "POST" },
    );
  },
};

async function performerRequest(
  path: string,
  expectedOperation: PerformerControlOperation,
  init?: RequestInit,
): Promise<PerformerControlEnvelope> {
  try {
    const envelope = parsePerformerControlEnvelope(await request<unknown>(path, init));
    if (envelope.control_result.operation !== expectedOperation) throw new Error("operation mismatch");
    return envelope;
  } catch (error) {
    if (error instanceof ApiError) {
      throw new ApiError(
        error.status,
        "Performer control request failed",
        "performer_control_failed",
      );
    }
    throw new ApiError(
      502,
      "Performer returned an invalid control response",
      "performer_control_protocol_invalid",
    );
  }
}

function parseDispatchedPerformerResponse(
  response: Promise<Response>,
  expectedOperation: PerformerControlOperation,
): Promise<PerformerControlEnvelope> {
  return response
    .then(readDispatchedPerformerResponse)
    .then((value) => {
      const envelope = parsePerformerControlEnvelope(value);
      if (envelope.control_result.operation !== expectedOperation) {
        throw new Error("operation mismatch");
      }
      return envelope;
    })
    .catch(normalizePerformerResponseError);
}

function readDispatchedPerformerResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new ApiError(
      response.status,
      "Performer control request failed",
      "performer_control_failed",
    );
  }
  return response.text().then((text) => text ? JSON.parse(text) : {});
}

function normalizePerformerResponseError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  throw new ApiError(
    502,
    "Performer returned an invalid control response",
    "performer_control_protocol_invalid",
  );
}

function performerPath(conductorId: string): string {
  return `/api/v1/conductors/${encodeURIComponent(conductorId)}/performer`;
}

function performerFailure(result: PerformerControlResult): ApiError {
  if (result.status !== "failed") {
    return new ApiError(502, "Performer control operation failed", "performer_control_failed");
  }
  return new ApiError(409, result.error.sanitized_reason, result.error.error_code);
}

function required<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`missing ${label}`);
  return value;
}

export function parsePerformerControlResult(value: unknown): PerformerControlResult {
  const input = exactObject(value, [
    "protocol_version", "request_id", "operation", "status", "capabilities",
    "readiness", "account", "login", "configuration", "check", "error",
  ]);
  const protocolVersion = one(input.protocol_version, "protocol_version");
  const requestId = identifier(input.request_id, "request_id");
  const operation = closedString(input.operation, [
    "performer.status", "performer.login", "performer.session.delete",
    "performer.config.read", "performer.config.write", "performer.check",
  ] as const, "operation");
  const status = closedString(input.status, ["succeeded", "failed"] as const, "status");
  const common = {
    protocol_version: protocolVersion,
    request_id: requestId,
    operation,
    capabilities: nullable(input.capabilities, parseCapabilities),
    readiness: nullable(input.readiness, parseReadiness),
    account: nullable(input.account, parseAccount),
    login: nullable(input.login, parseLogin),
    configuration: nullable(input.configuration, parseConfiguration),
    check: nullable(input.check, parseCheck),
  };
  const error = nullable(input.error, parseControlError);
  if (status === "failed") {
    if (error === null) throw new Error("failed result requires error");
    validateFailureFields(common);
    return { ...common, status, error } as PerformerControlResult;
  }
  if (error !== null) throw new Error("successful result rejects error");
  validateSuccessFields(operation, common);
  return { ...common, status, error: null } as PerformerControlResult;
}

export function parsePerformerControlEnvelope(value: unknown): PerformerControlEnvelope {
  const input = exactObject(value, ["control_result", "events"]);
  const controlResult = parsePerformerControlResult(input.control_result);
  const events = parseEvents(input.events);
  for (const event of events) {
    if (
      event.protocol_version !== controlResult.protocol_version
      || event.request_id !== controlResult.request_id
      || event.operation !== controlResult.operation
    ) {
      throw new Error("control event does not correlate to result");
    }
    const isLoginEvent = event.event_kind.startsWith("login.");
    if (isLoginEvent && event.operation !== "performer.login") {
      throw new Error("login event requires login operation");
    }
  }
  return { control_result: controlResult, events };
}

function parseEvents(value: unknown): PerformerControlEvent[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("invalid control events");
  let sequence = 0;
  return value.map((item) => {
    const input = exactObject(item, [
      "protocol_version", "request_id", "operation", "sequence", "event_kind",
      "message", "verification_url", "user_code", "expires_at",
    ]);
    const parsed = {
      protocol_version: one(input.protocol_version, "event protocol_version"),
      request_id: identifier(input.request_id, "event request_id"),
      operation: closedString(input.operation, [
        "performer.status", "performer.login", "performer.session.delete",
        "performer.config.read", "performer.config.write", "performer.check",
      ] as const, "event operation"),
      sequence: positiveInteger(input.sequence, "event sequence"),
      event_kind: closedString(input.event_kind, ["login.pending", "login.succeeded", "login.failed", "control.heartbeat"] as const, "event kind"),
      message: safeString(input.message, "event message", 500),
      verification_url: input.verification_url === null ? null : httpsUrl(input.verification_url, "verification_url"),
      user_code: input.user_code === null ? null : safeString(input.user_code, "user_code", 100),
      expires_at: input.expires_at === null ? null : safeString(input.expires_at, "expires_at", 100),
    } satisfies PerformerControlEvent;
    if (parsed.sequence <= sequence) throw new Error("event sequence is not increasing");
    sequence = parsed.sequence;
    if (parsed.event_kind === "login.pending" && (parsed.verification_url === null || parsed.user_code === null)) {
      throw new Error("pending event requires verification data");
    }
    if (
      parsed.event_kind !== "login.pending"
      && (parsed.verification_url !== null || parsed.user_code !== null || parsed.expires_at !== null)
    ) {
      throw new Error("terminal event rejects verification data");
    }
    return parsed;
  });
}

function parseCapabilities(value: unknown): PerformerCapabilities {
  const input = exactObject(value, [
    "protocol_version", "capability_version", "performer_kind", "display_name",
    "turn_kinds", "login_methods", "supports_session_delete", "editable_settings",
    "config_source_visible", "check_supported",
  ]);
  return {
    protocol_version: one(input.protocol_version, "protocol_version"),
    capability_version: positiveInteger(input.capability_version, "capability_version"),
    performer_kind: identifier(input.performer_kind, "performer_kind"),
    display_name: safeString(input.display_name, "display_name", 100),
    turn_kinds: closedArray(input.turn_kinds, ["plan", "execute", "gate"] as const, "turn_kinds"),
    login_methods: closedArray(input.login_methods, ["device_code", "api_key"] as const, "login_methods"),
    supports_session_delete: boolean(input.supports_session_delete, "supports_session_delete"),
    editable_settings: closedArray(input.editable_settings, ["api_base_url"] as const, "editable_settings"),
    config_source_visible: boolean(input.config_source_visible, "config_source_visible"),
    check_supported: boolean(input.check_supported, "check_supported"),
  };
}

function parseControlError(value: unknown): PerformerControlError {
  const input = exactObject(value, [
    "error_code", "sanitized_reason", "action_required", "retryable",
    "attempt_number", "next_action",
  ]);
  return {
    error_code: identifier(input.error_code, "error_code"),
    sanitized_reason: safeString(input.sanitized_reason, "sanitized_reason", 500),
    action_required: boolean(input.action_required, "action_required"),
    retryable: boolean(input.retryable, "retryable"),
    attempt_number: input.attempt_number === null
      ? null
      : positiveInteger(input.attempt_number, "attempt_number"),
    next_action: safeString(input.next_action, "next_action", 500),
  };
}

function parseReadiness(value: unknown): PerformerReadinessState {
  const input = exactObject(value, [
    "performer_kind", "binding_generation", "capability_version",
    "execution_policy_sha256", "status", "last_check_status", "error",
  ]);
  return {
    performer_kind: identifier(input.performer_kind, "performer_kind"),
    binding_generation: positiveInteger(input.binding_generation, "binding_generation"),
    capability_version: positiveInteger(input.capability_version, "capability_version"),
    execution_policy_sha256: sha256(input.execution_policy_sha256),
    status: closedString(input.status, ["unchecked", "checking", "ready", "failed"] as const, "readiness status"),
    last_check_status: closedString(input.last_check_status, ["none", "passed", "failed"] as const, "last_check_status"),
    error: nullable(input.error, parseControlError),
  };
}

function parseAccount(value: unknown): PerformerAccountState {
  const input = exactObject(value, ["status", "display_label"]);
  return {
    status: closedString(input.status, ["authenticated", "logged_out", "unknown"] as const, "account status"),
    display_label: input.display_label === null ? null : safeString(input.display_label, "display_label", 200),
  };
}

function parseLogin(value: unknown): PerformerLoginState {
  const input = exactObject(value, ["status", "method"]);
  return {
    status: closedString(input.status, ["idle", "pending", "succeeded", "failed", "lost"] as const, "login status"),
    method: input.method === null
      ? null
      : closedString(input.method, ["device_code", "api_key"] as const, "login method"),
  };
}

function parseConfiguration(value: unknown): PerformerConfigurationSnapshot {
  const input = exactObject(value, ["settings", "source_format", "source_text"]);
  const settings = exactObject(input.settings, ["api_base_url"], true);
  const apiBaseUrl = settings.api_base_url === undefined || settings.api_base_url === null
    ? settings.api_base_url
    : httpOrHttpsUrl(settings.api_base_url, "api_base_url");
  const sourceFormat = input.source_format === null
    ? null
    : closedString(input.source_format, ["text"] as const, "source_format");
  const sourceText = input.source_text === null
    ? null
    : safeSourceText(input.source_text);
  if (sourceText !== null && sourceFormat === null) throw new Error("source text requires format");
  return {
    settings: apiBaseUrl === undefined ? {} : { api_base_url: apiBaseUrl },
    source_format: sourceFormat,
    source_text: sourceText,
  };
}

function parseCheck(value: unknown): PerformerCheckState {
  const input = exactObject(value, ["status", "started_at", "finished_at", "summary"]);
  return {
    status: closedString(input.status, ["passed", "failed"] as const, "Check status"),
    started_at: safeString(input.started_at, "started_at", 100),
    finished_at: safeString(input.finished_at, "finished_at", 100),
    summary: safeString(input.summary, "summary", 500),
  };
}

function validateSuccessFields(
  operation: PerformerControlOperation,
  value: Omit<PerformerControlResult, "status" | "error">,
): void {
  const requiredFields: Record<PerformerControlOperation, (keyof typeof value)[]> = {
    "performer.status": ["capabilities", "readiness", "account", "login"],
    "performer.login": ["readiness", "login"],
    "performer.session.delete": ["readiness", "account", "login"],
    "performer.config.read": ["configuration"],
    "performer.config.write": ["readiness", "configuration"],
    "performer.check": ["readiness", "check"],
  };
  for (const field of requiredFields[operation]) {
    if (value[field] === null) throw new Error(`missing ${field}`);
  }
  const allowedFields: Record<PerformerControlOperation, (keyof typeof value)[]> = {
    "performer.status": ["protocol_version", "request_id", "operation", "capabilities", "readiness", "account", "login"],
    "performer.login": ["protocol_version", "request_id", "operation", "readiness", "account", "login"],
    "performer.session.delete": ["protocol_version", "request_id", "operation", "readiness", "account", "login"],
    "performer.config.read": ["protocol_version", "request_id", "operation", "configuration"],
    "performer.config.write": ["protocol_version", "request_id", "operation", "readiness", "configuration"],
    "performer.check": ["protocol_version", "request_id", "operation", "readiness", "check"],
  };
  const allowed = new Set(allowedFields[operation]);
  for (const [field, fieldValue] of Object.entries(value)) {
    if (fieldValue !== null && !allowed.has(field as keyof typeof value)) {
      throw new Error(`unexpected ${field}`);
    }
  }
}

function validateFailureFields(
  value: Omit<PerformerControlResult, "status" | "error">,
): void {
  for (const field of ["capabilities", "account", "login", "configuration", "check"] as const) {
    if (value[field] !== null) throw new Error(`failed result rejects ${field}`);
  }
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  allowMissing = false,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  const input = value as Record<string, unknown>;
  const expected = new Set(keys);
  if (Object.keys(input).some((key) => !expected.has(key))) throw new Error("unknown field");
  if (!allowMissing && keys.some((key) => !(key in input))) throw new Error("missing field");
  return input;
}

function nullable<T>(value: unknown, parser: (item: unknown) => T): T | null {
  return value === null ? null : parser(value);
}

function safeString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).length > maxBytes) {
    throw new Error(`invalid ${label}`);
  }
  if (/\0|(?:^|[\s"'=])(?:\/~|\/Users\/|\/home\/|\/var\/|[A-Za-z]:\\)/.test(value)) {
    throw new Error(`unsafe ${label}`);
  }
  return value;
}

function safeSourceText(value: unknown): string {
  const text = safeString(value, "source_text", 64 * 1024);
  if (/(?:\/Users|\/home|\/var|\/tmp)\/|~\/|[A-Za-z]:\\/i.test(text)) {
    throw new Error("unsafe source_text path");
  }
  if (/\b[A-Za-z0-9+/_-]{128,}={0,2}\b/.test(text)) {
    throw new Error("unsafe source_text base64");
  }
  const assignment = /(?:^|[^A-Za-z0-9_-])["']?(?:(?:[A-Za-z][A-Za-z0-9]*[_-])*)(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|authorization|private[_-]?key)["']?(?![A-Za-z0-9_-])\s*[:=]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\r\n;}]+)/gim;
  for (const match of text.matchAll(assignment)) {
    const rawValue = match[1].trim();
    const unquoted = (
      (rawValue.startsWith('"') && rawValue.endsWith('"'))
      || (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) ? rawValue.slice(1, -1).trim() : rawValue;
    if (unquoted !== "[REDACTED]") throw new Error("unsafe source_text secret");
  }
  return text;
}

function identifier(value: unknown, label: string): string {
  const text = safeString(value, label, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) throw new Error(`invalid ${label}`);
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`invalid ${label}`);
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`invalid ${label}`);
  return value;
}

function one(value: unknown, label: string): 1 {
  if (value !== 1) throw new Error(`invalid ${label}`);
  return 1;
}

function closedString<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`invalid ${label}`);
  return value as T[number];
}

function closedArray<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number][] {
  if (!Array.isArray(value)) throw new Error(`invalid ${label}`);
  const parsed = value.map((item) => closedString(item, allowed, label));
  if (new Set(parsed).size !== parsed.length) throw new Error(`duplicate ${label}`);
  return parsed;
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid sha256");
  return value;
}

function httpsUrl(value: unknown, label: string): string {
  const text = safeString(value, label, 2_000);
  const parsed = new URL(text);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error(`invalid ${label}`);
  return text;
}

function httpOrHttpsUrl(value: unknown, label: string): string {
  const text = safeString(value, label, 2_000);
  const parsed = new URL(text);
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.hash
  ) {
    throw new Error(`invalid ${label}`);
  }
  return text;
}
