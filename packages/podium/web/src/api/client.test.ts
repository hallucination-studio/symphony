import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./client";

const originalFetch = global.fetch;

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response);
}

describe("api client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("bootstrap requests without a workspace_id and includes credentials", async () => {
    const fetchMock = mockFetch(200, {
      session: { workspace_id: "ws_abc" },
      onboarding: { current_step: "linear_connect", steps: [] },
      linear: { state: "not_connected", workspace_id: "ws_abc" },
    });
    global.fetch = fetchMock;

    const result = await api.bootstrap();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/bootstrap",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(result.session.workspace_id).toBe("ws_abc");
  });

  it("config requests public runtime config with credentials", async () => {
    const fetchMock = mockFetch(200, {
      turnstile: { enabled: false, site_key: "" },
    });
    global.fetch = fetchMock;

    const result = await api.config();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/config",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(result.turnstile.enabled).toBe(false);
  });

  it("starts Linear OAuth through the installation lifecycle endpoint", async () => {
    const fetchMock = mockFetch(200, {
      authorization_url: "https://linear.app/oauth/authorize",
    });
    global.fetch = fetchMock;

    await api.startLinear();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/linear/installations/oauth",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("advances Linear cutover through the exact lifecycle endpoint", async () => {
    const body = {
      cutover_state: "waiting_for_drain",
      active: null,
      candidate: null,
      retirement_error: false,
    };
    const fetchMock = mockFetch(200, body);
    global.fetch = fetchMock;

    const result = await api.advanceLinearCutover();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/linear/installations/cutover",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(result).toEqual(body);
  });

  it("disconnects the current Linear installation with DELETE", async () => {
    const fetchMock = mockFetch(200, { state: "disconnected" });
    global.fetch = fetchMock;

    await api.disconnectLinear();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/linear/installations/current",
      expect.objectContaining({ method: "DELETE", credentials: "include" }),
    );
  });

  it("retries revocation for the exact installation id", async () => {
    const fetchMock = mockFetch(200, { state: "disconnected" });
    global.fetch = fetchMock;

    await api.retryLinearRevocation("installation 1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/linear/installations/installation%201/revoke",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("keeps a sanitized Linear next action on API errors", async () => {
    global.fetch = mockFetch(409, {
      error: {
        code: "linear_disconnect_in_use",
        message: "Unbind active projects before disconnecting Linear",
        next_action: "unbind_projects",
      },
    });

    await expect(api.disconnectLinear()).rejects.toMatchObject({
      code: "linear_disconnect_in_use",
      nextAction: "unbind_projects",
    });
  });

  it("lists Linear projects through the closed canonical projects endpoint", async () => {
    const fetchMock = mockFetch(200, {
      projects: [
        {
          id: "project-1",
          name: "Platform",
          slug_id: "platform",
          selected: true,
          access_state: "ready",
          bound: true,
        },
      ],
    });
    global.fetch = fetchMock;

    const result = await api.linearProjects();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/linear/projects",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(result.projects[0]).toEqual({
      id: "project-1",
      name: "Platform",
      slug_id: "platform",
      selected: true,
      access_state: "ready",
      bound: true,
    });
  });

  it("selects Linear projects with the exact project_ids request body", async () => {
    const fetchMock = mockFetch(200, { projects: [] });
    global.fetch = fetchMock;

    await api.selectLinearProjects(["project-1", "project-2"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/linear/projects",
      expect.objectContaining({
        method: "PUT",
        credentials: "include",
        body: JSON.stringify({ project_ids: ["project-1", "project-2"] }),
      }),
    );
  });

  it("rejects Linear project responses with undeclared fields", async () => {
    global.fetch = mockFetch(200, {
      projects: [
        {
          id: "project-1",
          name: "Platform",
          slug_id: "platform",
          selected: true,
          access_state: "ready",
          bound: false,
          token: "must-not-pass",
        },
      ],
    });

    await expect(api.linearProjects()).rejects.toThrow("unknown field");
  });

  it("managedRuns requests every project Conductor managed runs view", async () => {
    const fetchMock = mockFetch(200, {
      conductors: [
        {
          conductor: { id: "conductor-1", name: "Bach", public_id: "k7m3p2", online: true },
          project: { id: "project-1", slug: "LIN", name: "Linear Platform" },
          binding: { id: "binding-1", instance_id: "inst-1", state: "ready", error_code: "", sanitized_reason: "" },
          runtime_group_id: "group-1",
          policy_revision: 2,
          profiles: {},
          managed_runs: { runs: [{ run_id: "run-1", work_items: [] }] },
        },
      ],
    });
    global.fetch = fetchMock;

    const result = await api.managedRuns();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/managed-runs",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(result.conductors[0].managed_runs.runs?.[0]?.run_id).toBe("run-1");
  });

  it("bindConductor PUTs the exact project and repository body", async () => {
    const fetchMock = mockFetch(202, {
      binding: {
        id: "binding-1",
        conductor_id: "conductor-1",
        linear_project_id: "project-1",
        project_name: "Platform",
        project_slug: "platform",
        state: "pending_ack",
        config_version: 1,
        acknowledged_config_version: 0,
        error_code: "",
        sanitized_reason: "",
        next_action: "wait_for_conductor_ack",
        repository: { mode: "git_url", value: "https://example.com/repo.git" },
      },
    });
    global.fetch = fetchMock;

    await api.bindConductor("conductor-1", {
      linear_project_id: "project-1",
      repository: {
        mode: "git_url",
        value: "https://example.com/repo.git",
      },
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/v1/conductors/conductor-1/binding",
    );
    expect(init.method).toBe("PUT");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body)).toEqual({
      linear_project_id: "project-1",
      repository: {
        mode: "git_url",
        value: "https://example.com/repo.git",
      },
    });
  });

  it("reserves a named Conductor with the exact enrollment request body", async () => {
    const fetchMock = mockFetch(200, {
      enrollment_token: "transient-token",
      install_command: "install transient-token",
      expires_at: "2026-07-14T12:00:00Z",
      conductor: {
        id: "conductor-1",
        name: "Bach",
        public_id: "k7m3p2",
        enrollment_state: "pending",
        hostname: "",
        version: "",
        service_identity: "symphony-conductor-k7m3p2",
        data_root: "",
        online: false,
        last_report_at: null,
        binding: null,
      },
    });
    global.fetch = fetchMock;

    await api.enrollmentToken({ name: "Bach" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/onboarding/runtime/enrollment-token",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ name: "Bach" }),
      }),
    );
  });

  it("regenerates a command for the exact reserved Conductor", async () => {
    const fetchMock = mockFetch(200, {
      enrollment_token: "replacement-token",
      install_command: "install replacement-token",
      conductor: {
        id: "conductor-1",
        name: "Bach",
        public_id: "k7m3p2",
        enrollment_state: "pending",
        hostname: "",
        version: "",
        service_identity: "symphony-conductor-k7m3p2",
        data_root: "",
        online: false,
        last_report_at: null,
        binding: null,
      },
    });
    global.fetch = fetchMock;

    await api.enrollmentToken({ conductor_id: "conductor-1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/onboarding/runtime/enrollment-token",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ conductor_id: "conductor-1" }),
      }),
    );
  });

  it("login POSTs email + password + injected turnstile_token", async () => {
    const fetchMock = mockFetch(200, {
      user: { id: "user_1", email: "a@b.com" },
    });
    global.fetch = fetchMock;

    await api.login("a@b.com", "password123", "token-login");

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/v1/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      email: "a@b.com",
      password: "password123",
      turnstile_token: "token-login",
    });
  });

  it("register POSTs email + password + injected turnstile_token", async () => {
    const fetchMock = mockFetch(200, {
      user: { id: "user_1", email: "a@b.com" },
    });
    global.fetch = fetchMock;

    await api.register("a@b.com", "password123", "token-register");

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/v1/auth/register");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      email: "a@b.com",
      password: "password123",
      turnstile_token: "token-register",
    });
  });

  it("saveLinearApplication PUTs only customer credentials", async () => {
    const fetchMock = mockFetch(200, {
      application: {
        id: "app-custom",
        source: "custom",
        version: 1,
        client_id: "cid",
        callback_url: "https://podium.example/api/v1/linear/oauth/callback",
      },
    });
    global.fetch = fetchMock;

    await api.saveLinearApplication({ client_id: "cid", client_secret: "sec" });

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/v1/linear/application");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({
      client_id: "cid",
      client_secret: "sec",
    });
  });

  it("selectDefaultLinearApplication uses the dedicated selection endpoint", async () => {
    const fetchMock = mockFetch(200, {
      application: { id: "app-default", source: "default", version: 1 },
    });
    global.fetch = fetchMock;

    await api.selectDefaultLinearApplication();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/linear/application/default",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("throws ApiError with the backend error code on failure", async () => {
    global.fetch = mockFetch(400, {
      error: { code: "invalid_repository", message: "bad repository" },
    });

    await expect(api.bindConductor("conductor-1", {
      linear_project_id: "project-1",
      repository: { mode: "git_url", value: "x" },
    })).rejects.toMatchObject({
      status: 400,
      code: "invalid_repository",
    });
    await expect(
      api.bindConductor("conductor-1", {
        linear_project_id: "project-1",
        repository: { mode: "git_url", value: "x" },
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("parses a closed provider-neutral Performer status response", async () => {
    global.fetch = mockFetch(200, {
      control_result: performerResult("performer.status", {
        capabilities: {
        protocol_version: 1,
        capability_version: 1,
        performer_kind: "codex",
        display_name: "Codex",
        turn_kinds: ["plan", "execute", "gate"],
        login_methods: ["device_code", "api_key"],
        supports_session_delete: true,
        editable_settings: ["api_base_url"],
        config_source_visible: true,
        check_supported: true,
      },
        readiness: readiness(),
        account: { status: "authenticated", display_label: "Developer" },
        login: { status: "idle", method: null },
      }),
      events: [],
    });

    const status = await api.performerStatus("conductor-1");

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/v1/conductors/conductor-1/performer",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(status.capabilities.performer_kind).toBe("codex");
    expect(status.capabilities.login_methods).toEqual(["device_code", "api_key"]);
  });

  it("does not narrow a declared Performer backend identity in the browser", async () => {
    global.fetch = mockFetch(200, {
      control_result: performerResult("performer.status", {
        capabilities: {
          protocol_version: 1,
          capability_version: 1,
          performer_kind: "backend_alpha",
          display_name: "Backend Alpha",
          turn_kinds: ["plan", "execute", "gate"],
          login_methods: ["device_code"],
          supports_session_delete: true,
          editable_settings: [],
          config_source_visible: false,
          check_supported: true,
        },
        readiness: { ...readiness(), performer_kind: "backend_alpha" },
        account: { status: "logged_out", display_label: null },
        login: { status: "idle", method: null },
      }),
      events: [],
    });

    const status = await api.performerStatus("conductor-1");

    expect(status.capabilities.performer_kind).toBe("backend_alpha");
    expect(status.capabilities.display_name).toBe("Backend Alpha");
  });

  it("unwraps the no-store control envelope and validates a device challenge event", async () => {
    const result = performerResult("performer.login", {
      readiness: readiness(),
      login: { status: "pending", method: "device_code" },
    });
    global.fetch = mockFetch(200, {
      control_result: result,
      events: [{
        protocol_version: 1,
        request_id: result.request_id,
        operation: "performer.login",
        sequence: 1,
        event_kind: "login.pending",
        message: "Open the verification URL",
        verification_url: "https://example.test/device",
        user_code: "ABCD-EFGH",
        expires_at: null,
      }],
    });

    const envelope = await api.performerLogin("conductor-1", { method: "device_code" });

    expect(envelope.events[0].user_code).toBe("ABCD-EFGH");
    expect(envelope.control_result.login?.status).toBe("pending");
  });

  it("rejects unknown Performer response fields instead of trusting JSON", async () => {
    global.fetch = mockFetch(200, {
      control_result: {
        ...performerResult("performer.status", {
        capabilities: {
          protocol_version: 1,
          capability_version: 1,
          performer_kind: "codex",
          display_name: "Codex",
          turn_kinds: ["plan", "execute", "gate"],
          login_methods: ["device_code"],
          supports_session_delete: true,
          editable_settings: ["api_base_url"],
          config_source_visible: true,
          check_supported: true,
        },
        readiness: readiness(),
        account: { status: "logged_out", display_label: null },
        login: { status: "idle", method: null },
        }),
        sdk_response: { auth_json_path: "/Users/private/.codex/auth.json" },
      },
      events: [],
    });

    await expect(api.performerStatus("conductor-1")).rejects.toMatchObject({
      code: "performer_control_protocol_invalid",
    });
  });

  it("dispatches API keys synchronously into a native Request without retaining input", async () => {
    const sentinel = "sk-browser-memory-only";
    const responseBody = {
      control_result: performerResult("performer.login", {
        readiness: readiness(),
        login: { status: "succeeded", method: "api_key" },
        account: { status: "authenticated", display_label: null },
      }),
      events: [],
    };
    let releaseFetch: (() => void) | undefined;
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => {
      releaseFetch = () => resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(responseBody),
      } as Response);
    }));
    global.fetch = fetchMock;
    let apiKey: string | null = sentinel;

    const pending = api.performerApiKeyLogin("conductor/one", () => {
      const value = apiKey;
      apiKey = null;
      return value!;
    });

    expect(apiKey).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [request, init] = fetchMock.mock.calls[0];
    expect(request).toBeInstanceOf(Request);
    expect(init).toBeUndefined();
    expect(request.url).toContain(
      "/api/v1/conductors/conductor%2Fone/performer/login",
    );
    expect(await request.clone().json()).toEqual({
      method: "api_key",
      api_key: sentinel,
    });

    releaseFetch?.();
    const result = await pending;
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it("uses the generic Performer session, config, and Check routes", async () => {
    const responses = [
      { control_result: performerResult("performer.session.delete", {
        readiness: readiness(),
        account: { status: "logged_out", display_label: null },
        login: { status: "idle", method: null },
      }), events: [] },
      { control_result: performerResult("performer.config.read", {
        configuration: {
          settings: { api_base_url: "https://api.example.test/v1" },
          source_format: "text",
          source_text: 'model = "gpt-5.4"',
        },
      }), events: [] },
      { control_result: performerResult("performer.config.write", {
        readiness: readiness(),
        configuration: {
          settings: { api_base_url: "https://api.example.test/v2" },
          source_format: null,
          source_text: null,
        },
      }), events: [] },
      { control_result: performerResult("performer.check", {
        readiness: { ...readiness(), status: "ready", last_check_status: "passed" },
        check: {
          status: "passed",
          started_at: "2026-07-13T00:00:00Z",
          finished_at: "2026-07-13T00:00:01Z",
          summary: "Structured read-only Check passed.",
        },
      }), events: [] },
    ];
    const fetchMock = vi.fn();
    for (const response of responses) {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(response),
      } as Response);
    }
    global.fetch = fetchMock;

    await api.deletePerformerSession("conductor-1", "logout");
    await api.performerConfiguration("conductor-1");
    await api.updatePerformerConfiguration("conductor-1", {
      setting: "api_base_url",
      value: "https://api.example.test/v2",
    });
    await api.checkPerformer("conductor-1");

    expect(fetchMock.mock.calls.map(([path, init]) => [path, init.method ?? "GET"]))
      .toEqual([
        ["/api/v1/conductors/conductor-1/performer/session", "DELETE"],
        ["/api/v1/conductors/conductor-1/performer/config", "GET"],
        ["/api/v1/conductors/conductor-1/performer/config", "PATCH"],
        ["/api/v1/conductors/conductor-1/performer/check", "POST"],
      ]);
  });

  it("rejects a bare control result now that the BFF envelope is frozen", async () => {
    global.fetch = mockFetch(200, performerResult("performer.config.read", {
      configuration: { settings: {}, source_format: null, source_text: null },
    }));

    await expect(api.performerConfiguration("conductor-1")).rejects.toMatchObject({
      code: "performer_control_protocol_invalid",
    });
  });

  it("rejects device challenge events that do not correlate to the result", async () => {
    const result = performerResult("performer.login", {
      readiness: readiness(),
      login: { status: "pending", method: "device_code" },
    });
    global.fetch = mockFetch(200, {
      control_result: result,
      events: [{
        protocol_version: 1,
        request_id: "another-request",
        operation: "performer.login",
        sequence: 1,
        event_kind: "login.pending",
        message: "Open another verification URL",
        verification_url: "https://phishing.example/device",
        user_code: "WRONG-CODE",
        expires_at: null,
      }],
    });

    await expect(api.performerLogin("conductor-1", { method: "device_code" }))
      .rejects.toMatchObject({ code: "performer_control_protocol_invalid" });
  });

  it("rejects login events on non-login operations", async () => {
    const result = performerResult("performer.status", {
      capabilities: {
        protocol_version: 1,
        capability_version: 1,
        performer_kind: "codex",
        display_name: "Codex",
        turn_kinds: ["plan", "execute", "gate"],
        login_methods: ["device_code"],
        supports_session_delete: true,
        editable_settings: [],
        config_source_visible: false,
        check_supported: true,
      },
      readiness: readiness(),
      account: { status: "logged_out", display_label: null },
      login: { status: "idle", method: null },
    });
    global.fetch = mockFetch(200, {
      control_result: result,
      events: [{
        protocol_version: 1,
        request_id: result.request_id,
        operation: "performer.status",
        sequence: 1,
        event_kind: "login.pending",
        message: "Wrong operation",
        verification_url: "https://example.test/device",
        user_code: "WRONG-CODE",
        expires_at: null,
      }],
    });

    await expect(api.performerStatus("conductor-1")).rejects.toMatchObject({
      code: "performer_control_protocol_invalid",
    });
  });

  it("rejects operation-specific success fields that are not allowed", async () => {
    global.fetch = mockFetch(200, {
      control_result: performerResult("performer.config.read", {
        configuration: { settings: {}, source_format: null, source_text: null },
        account: { status: "authenticated", display_label: "raw extra" },
      }),
      events: [],
    });

    await expect(api.performerConfiguration("conductor-1")).rejects.toMatchObject({
      code: "performer_control_protocol_invalid",
    });
  });

  it("accepts redacted config source", async () => {
    global.fetch = mockFetch(200, {
      control_result: performerResult("performer.config.read", {
        configuration: {
          settings: {},
          source_format: "text",
          source_text: 'api_key = "[REDACTED]"',
        },
      }),
      events: [],
    });

    const envelope = await api.performerConfiguration("conductor-1");
    expect(envelope.control_result.configuration?.source_text).toBe(
      'api_key = "[REDACTED]"',
    );
  });

  it("accepts an explicitly redacted nested secret assignment", async () => {
    const sourceText = 'http_headers = { "X-Api-Key" = "[REDACTED]" }';
    global.fetch = mockFetch(200, {
      control_result: performerResult("performer.config.read", {
        configuration: {
          settings: {},
          source_format: "text",
          source_text: sourceText,
        },
      }),
      events: [],
    });

    const envelope = await api.performerConfiguration("conductor-1");
    expect(envelope.control_result.configuration?.source_text).toBe(sourceText);
  });

  it("accepts an HTTP API base URL allowed by the shared contract", async () => {
    global.fetch = mockFetch(200, {
      control_result: performerResult("performer.config.read", {
        configuration: {
          settings: { api_base_url: "http://127.0.0.1:11434/v1" },
          source_format: null,
          source_text: null,
        },
      }),
      events: [],
    });

    const envelope = await api.performerConfiguration("conductor-1");

    expect(envelope.control_result.configuration?.settings.api_base_url).toBe(
      "http://127.0.0.1:11434/v1",
    );
  });

  it.each([
    'api_key = "raw-secret-value"',
    'http_headers = { "X-Api-Key" = "raw-secret-value" }',
    'env = { "OPENAI_API_KEY" = "raw-secret-value" }',
    "headers = { authorization = 'Bearer raw-secret-value' }",
    'config = "/tmp/private/config.toml"',
    "QUJD".repeat(40),
  ])("rejects unsafe config source: %s", async (sourceText) => {
    global.fetch = mockFetch(200, {
      control_result: performerResult("performer.config.read", {
        configuration: {
          settings: {},
          source_format: "text",
          source_text: sourceText,
        },
      }),
      events: [],
    });

    await expect(api.performerConfiguration("conductor-1")).rejects.toMatchObject({
      code: "performer_control_protocol_invalid",
    });
  });

  it("does not expose an untrusted non-2xx Performer error message", async () => {
    global.fetch = mockFetch(500, {
      error: {
        code: "provider_raw_failure",
        message: "Read /Users/private/.codex/auth.json with sk-raw-secret",
      },
    });

    await expect(api.checkPerformer("conductor-1")).rejects.toMatchObject({
      code: "performer_control_failed",
      message: "Performer control request failed",
    });
  });
});

function readiness() {
  return {
    performer_kind: "codex",
    binding_generation: 1,
    capability_version: 1,
    execution_policy_sha256: "a".repeat(64),
    status: "unchecked",
    last_check_status: "none",
    error: null,
  };
}

function performerResult(
  operation: string,
  fields: Record<string, unknown>,
) {
  return {
    protocol_version: 1,
    request_id: `web-${operation}`,
    operation,
    status: "succeeded",
    capabilities: null,
    readiness: null,
    account: null,
    login: null,
    configuration: null,
    check: null,
    error: null,
    ...fields,
  };
}
