import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./test/utils";
import App from "./App";
import { api, ApiError } from "./api/client";

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return {
    ...actual,
    api: {
      me: vi.fn(),
      bootstrap: vi.fn(),
      recentRuns: vi.fn(),
      smokeCheckResult: vi.fn(),
    },
  };
});

const mockApi = api as unknown as {
  me: ReturnType<typeof vi.fn>;
  bootstrap: ReturnType<typeof vi.fn>;
  recentRuns: ReturnType<typeof vi.fn>;
  smokeCheckResult: ReturnType<typeof vi.fn>;
};

describe("App auth gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.recentRuns.mockResolvedValue({ runs: [] });
    mockApi.smokeCheckResult.mockRejectedValue(new Error("404"));
    mockApi.bootstrap.mockResolvedValue({
      session: { workspace_id: "ws_abc" },
      onboarding: {
        current_step: "linear_connect",
        completed_steps: [],
        next_action: "Connect Linear",
      },
      linear: { workspace_id: "ws_abc", state: "not_connected" },
    });
  });

  it("renders the login page (no sidebar) when unauthenticated", async () => {
    mockApi.me.mockRejectedValue(new ApiError(401, "no", "unauthenticated"));
    renderWithProviders(<App />, { route: "/" });

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByText("Home")).not.toBeInTheDocument();
  });

  it("renders the app shell when authenticated", async () => {
    mockApi.me.mockResolvedValue({
      user: { user_id: "u1", email: "a@b.com", workspace_id: "ws_abc" },
    });
    renderWithProviders(<App />, { route: "/" });

    // Sidebar nav links appear only inside the authenticated shell.
    expect(await screen.findByRole("navigation")).toBeInTheDocument();
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  });
});
