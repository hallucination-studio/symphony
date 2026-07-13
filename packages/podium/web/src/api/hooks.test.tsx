import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { usePerformerControl, usePerformerStatus } from "./hooks";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { queryClient, Wrapper };
}

function mockFetch(body: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as Response);
}

function mockFetchSequence(...bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    } as Response);
  }
  global.fetch = fetchMock;
}

it("caches only sanitized Performer status data", async () => {
  mockFetch({
    control_result: performerResult("performer.status", {
      capabilities: capabilities(),
      readiness: readiness(),
      account: { status: "authenticated", display_label: "Developer" },
      login: { status: "idle", method: null },
    }),
    events: [],
  });
  const { queryClient, Wrapper } = setup();

  const { result } = renderHook(() => usePerformerStatus("conductor-1"), {
    wrapper: Wrapper,
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect(queryClient.getQueryData(["performer", "conductor-1", "status"]))
    .toMatchObject({ capabilities: { performer_kind: "codex" } });
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
});

it("never places an API key in query data or mutation variables", async () => {
  const sentinel = "sk-query-cache-sentinel";
  const responseBody = {
    control_result: performerResult("performer.login", {
      readiness: readiness(),
      account: { status: "authenticated", display_label: null },
      login: { status: "succeeded", method: "api_key" },
    }),
    events: [],
  };
  let releaseFetch: (() => void) | undefined;
  global.fetch = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => {
    releaseFetch = () => resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(responseBody),
    } as Response);
  }));
  const { queryClient, Wrapper } = setup();
  const { result } = renderHook(() => usePerformerControl("conductor-1"), {
    wrapper: Wrapper,
  });
  let secret: string | null = sentinel;
  let pending: ReturnType<typeof result.current.loginWithApiKey> | undefined;

  act(() => {
    pending = result.current.loginWithApiKey(() => {
      const value = secret;
      secret = null;
      return value!;
    });
  });

  expect(secret).toBeNull();
  expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain(sentinel);
  expect(JSON.stringify(queryClient.getMutationCache().getAll())).not.toContain(sentinel);
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  releaseFetch?.();
  await act(() => pending!);
});

it("keeps config source in hook-local transient state and clears it", async () => {
  mockFetch({
    control_result: performerResult("performer.config.read", {
      configuration: {
        settings: { api_base_url: "https://api.example.test/v1" },
        source_format: "text",
        source_text: 'model = "gpt-5.4"',
      },
    }),
    events: [],
  });
  const { queryClient, Wrapper } = setup();
  const { result, unmount } = renderHook(
    () => usePerformerControl("conductor-1"),
    { wrapper: Wrapper },
  );

  await act(() => result.current.readConfiguration());
  expect(result.current.configurationSource).toBe('model = "gpt-5.4"');
  expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain("gpt-5.4");

  act(() => result.current.clearTransient());
  expect(result.current.configurationSource).toBeNull();
  unmount();
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
});

it("clears a stale device challenge before another login method", async () => {
  const deviceResult = performerResult("performer.login", {
    readiness: readiness(),
    login: { status: "pending", method: "device_code" },
  });
  const apiKeyResult = performerResult("performer.login", {
    readiness: readiness(),
    account: { status: "authenticated", display_label: null },
    login: { status: "succeeded", method: "api_key" },
  });
  mockFetchSequence(
    {
      control_result: deviceResult,
      events: [{
        protocol_version: 1,
        request_id: deviceResult.request_id,
        operation: "performer.login",
        sequence: 1,
        event_kind: "login.pending",
        message: "Open verification page",
        verification_url: "https://example.test/device",
        user_code: "ABCD-EFGH",
        expires_at: null,
      }],
    },
    { control_result: apiKeyResult, events: [] },
  );
  const { Wrapper } = setup();
  const { result } = renderHook(() => usePerformerControl("conductor-1"), {
    wrapper: Wrapper,
  });

  await act(() => result.current.login({ method: "device_code" }));
  expect(result.current.challenge?.user_code).toBe("ABCD-EFGH");

  await act(() => result.current.loginWithApiKey(() => "dummy"));
  expect(result.current.challenge).toBeNull();
});

it("clears a device challenge on logout as well as cancel", async () => {
  const deviceResult = performerResult("performer.login", {
    readiness: readiness(),
    login: { status: "pending", method: "device_code" },
  });
  const logoutResult = performerResult("performer.session.delete", {
    readiness: readiness(),
    account: { status: "logged_out", display_label: null },
    login: { status: "idle", method: null },
  });
  mockFetchSequence(
    {
      control_result: deviceResult,
      events: [{
        protocol_version: 1,
        request_id: deviceResult.request_id,
        operation: "performer.login",
        sequence: 1,
        event_kind: "login.pending",
        message: "Open verification page",
        verification_url: "https://example.test/device",
        user_code: "ABCD-EFGH",
        expires_at: null,
      }],
    },
    { control_result: logoutResult, events: [] },
  );
  const { Wrapper } = setup();
  const { result } = renderHook(() => usePerformerControl("conductor-1"), {
    wrapper: Wrapper,
  });

  await act(() => result.current.login({ method: "device_code" }));
  await act(() => result.current.deleteSession("logout"));
  expect(result.current.challenge).toBeNull();
});

function capabilities() {
  return {
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
  };
}

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

function performerResult(operation: string, fields: Record<string, unknown>) {
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
