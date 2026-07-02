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

  it("bootstrap sends the workspace_id query param", async () => {
    const fetchMock = mockFetch(200, {
      session: { workspace_id: "default" },
      onboarding: { current_step: "linear_connect", steps: [] },
      linear: { state: "not_connected", workspace_id: "default" },
    });
    global.fetch = fetchMock;

    const result = await api.bootstrap();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/bootstrap?workspace_id=default",
      expect.anything(),
    );
    expect(result.session.workspace_id).toBe("default");
  });

  it("saveRepository POSTs a JSON body", async () => {
    const fetchMock = mockFetch(200, {
      repository: { mode: "git_url", value: "https://example.com/repo.git" },
      onboarding: { current_step: "runtime_enrollment", steps: [] },
    });
    global.fetch = fetchMock;

    await api.saveRepository("ws-1", "git_url", "https://example.com/repo.git");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      workspace_id: "ws-1",
      mode: "git_url",
      value: "https://example.com/repo.git",
    });
  });

  it("throws ApiError with the backend error code on failure", async () => {
    global.fetch = mockFetch(400, {
      error: { code: "invalid_mode", message: "bad mode" },
    });

    await expect(api.saveRepository("ws", "git_url", "x")).rejects.toMatchObject({
      status: 400,
      code: "invalid_mode",
    });
    await expect(
      api.saveRepository("ws", "git_url", "x"),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
