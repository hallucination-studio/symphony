import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/utils";
import HomePage from "./HomePage";
import { api } from "../api/client";
import type { Bootstrap } from "../api/types";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      bootstrap: vi.fn(),
      pipeline: vi.fn(),
      smokeCheckResult: vi.fn(),
    },
  };
});

const mockApi = api as unknown as {
  bootstrap: ReturnType<typeof vi.fn>;
  pipeline: ReturnType<typeof vi.fn>;
  smokeCheckResult: ReturnType<typeof vi.fn>;
};

function bootstrap(overrides: Partial<Bootstrap> = {}): Bootstrap {
  return {
    session: { workspace_id: "default" },
    onboarding: {
      current_step: "scope_selection",
      completed_steps: ["linear_connect"],
      next_action: "Select the teams and projects to route",
    },
    linear: { workspace_id: "default", state: "connected" },
    ...overrides,
  };
}

describe("HomePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.pipeline.mockResolvedValue({ runtime_group_id: "group-1", policy_revision: 1, pipeline: null });
    mockApi.smokeCheckResult.mockRejectedValue(new Error("404"));
  });

  it("renders onboarding steps and the next action", async () => {
    mockApi.bootstrap.mockResolvedValue(bootstrap());
    renderWithProviders(<HomePage />);

    expect(
      await screen.findByText("Select the teams and projects to route"),
    ).toBeInTheDocument();
    expect(screen.getByText("Connect Linear")).toBeInTheDocument();
    expect(screen.getByText("Choose scope")).toBeInTheDocument();
    // 1 of 5 steps completed.
    expect(screen.getByText("1/5")).toBeInTheDocument();
  });

  it("shows an all-set action when onboarding is complete", async () => {
    mockApi.bootstrap.mockResolvedValue(
      bootstrap({
        onboarding: {
          current_step: "complete",
          completed_steps: [
            "linear_connect",
            "scope_selection",
            "repository_mapping",
            "runtime_enrollment",
            "smoke_check",
          ],
          next_action: "Onboarding complete",
        },
      }),
    );
    renderWithProviders(<HomePage />);

    expect(await screen.findByText("You're all set")).toBeInTheDocument();
  });

  it("renders an empty state when there is no pipeline report", async () => {
    mockApi.bootstrap.mockResolvedValue(bootstrap());
    renderWithProviders(<HomePage />);

    expect(await screen.findByText("No pipeline report yet")).toBeInTheDocument();
  });
});
