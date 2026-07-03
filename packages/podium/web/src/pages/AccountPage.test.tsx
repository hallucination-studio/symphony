import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/utils";
import AccountPage from "./AccountPage";
import { api } from "../api/client";
import type { Bootstrap } from "../api/types";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      bootstrap: vi.fn(),
      startLinear: vi.fn(),
    },
  };
});

const mockApi = api as unknown as {
  bootstrap: ReturnType<typeof vi.fn>;
  startLinear: ReturnType<typeof vi.fn>;
};

function bootstrap(overrides: Partial<Bootstrap> = {}): Bootstrap {
  return {
    session: { workspace_id: "default" },
    onboarding: {
      current_step: "scope_selection",
      completed_steps: ["linear_connect"],
      next_action: "Select the teams and projects to route",
    },
    linear: { workspace_id: "acme-linear", state: "connected", scope: "read" },
    ...overrides,
  };
}

describe("AccountPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the workspace id from bootstrap", async () => {
    mockApi.bootstrap.mockResolvedValue(bootstrap());
    renderWithProviders(<AccountPage />);

    expect(await screen.findByText("default")).toBeInTheDocument();
  });

  it("shows scope and a Manage in Integrations link when Linear is connected", async () => {
    mockApi.bootstrap.mockResolvedValue(bootstrap());
    renderWithProviders(<AccountPage />);

    expect(await screen.findByText("read")).toBeInTheDocument();
    const manage = screen.getByRole("link", { name: "Manage in Integrations" });
    expect(manage).toHaveAttribute("href", "/integrations");
  });

  it("shows a connect action when Linear is not connected", async () => {
    mockApi.bootstrap.mockResolvedValue(
      bootstrap({
        linear: { workspace_id: "default", state: "not_connected" },
      }),
    );
    renderWithProviders(<AccountPage />);

    expect(
      await screen.findByRole("button", { name: "Connect Linear" }),
    ).toBeInTheDocument();
  });

  it("renders the onboarding progress count", async () => {
    mockApi.bootstrap.mockResolvedValue(bootstrap());
    renderWithProviders(<AccountPage />);

    // 1 of 5 steps completed.
    expect(await screen.findByText("1/5")).toBeInTheDocument();
  });
});
