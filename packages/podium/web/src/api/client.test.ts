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

  it("saveRepository POSTs a JSON body without workspace_id", async () => {
    const fetchMock = mockFetch(200, {
      repository: { mode: "git_url", value: "https://example.com/repo.git" },
      onboarding: { current_step: "runtime_enrollment", steps: [] },
    });
    global.fetch = fetchMock;

    await api.saveRepository("git_url", "https://example.com/repo.git");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body)).toEqual({
      mode: "git_url",
      value: "https://example.com/repo.git",
    });
  });

  it("login POSTs email + password", async () => {
    const fetchMock = mockFetch(200, {
      user: { user_id: "u1", email: "a@b.com", workspace_id: "ws_1" },
    });
    global.fetch = fetchMock;

    await api.login("a@b.com", "password123");

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/v1/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      email: "a@b.com",
      password: "password123",
    });
  });

  it("setLinearApp PUTs the credentials", async () => {
    const fetchMock = mockFetch(200, {
      linear_app: { client_id: "cid", redirect_uri: null, configured: true },
    });
    global.fetch = fetchMock;

    await api.setLinearApp({ client_id: "cid", client_secret: "sec" });

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/v1/account/linear-app");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({
      client_id: "cid",
      client_secret: "sec",
    });
  });

  it("throws ApiError with the backend error code on failure", async () => {
    global.fetch = mockFetch(400, {
      error: { code: "invalid_mode", message: "bad mode" },
    });

    await expect(api.saveRepository("git_url", "x")).rejects.toMatchObject({
      status: 400,
      code: "invalid_mode",
    });
    await expect(
      api.saveRepository("git_url", "x"),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
