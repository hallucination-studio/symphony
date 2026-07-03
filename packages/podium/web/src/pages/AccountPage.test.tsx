import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/utils";
import AccountPage from "./AccountPage";
import { api } from "../api/client";
import type { AuthUser, Bootstrap } from "../api/types";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      me: vi.fn(),
      bootstrap: vi.fn(),
      startLinear: vi.fn(),
      logout: vi.fn(),
      setLinearApp: vi.fn(),
      clearLinearApp: vi.fn(),
    },
  };
});

const mockApi = api as unknown as {
  me: ReturnType<typeof vi.fn>;
  bootstrap: ReturnType<typeof vi.fn>;
  startLinear: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  setLinearApp: ReturnType<typeof vi.fn>;
  clearLinearApp: ReturnType<typeof vi.fn>;
};

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    user_id: "u_1",
    email: "user@example.com",
    workspace_id: "ws_abc",
    ...overrides,
  };
}

function bootstrap(overrides: Partial<Bootstrap> = {}): Bootstrap {
  return {
    session: { workspace_id: "ws_abc" },
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
    mockApi.me.mockResolvedValue({ user: user() });
    mockApi.bootstrap.mockResolvedValue(bootstrap());
  });

  it("renders the email and workspace id from the session", async () => {
    renderWithProviders(<AccountPage />);

    expect(await screen.findByText("user@example.com")).toBeInTheDocument();
    expect(screen.getByText("ws_abc")).toBeInTheDocument();
  });

  it("logs out via api.logout", async () => {
    mockApi.logout.mockResolvedValue({ ok: true });
    renderWithProviders(<AccountPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));

    await waitFor(() => expect(mockApi.logout).toHaveBeenCalled());
  });

  it("saves a custom Linear app and never renders the secret back", async () => {
    mockApi.setLinearApp.mockResolvedValue({
      linear_app: { client_id: "cid-123", redirect_uri: null, configured: true },
    });
    renderWithProviders(<AccountPage />);

    fireEvent.change(await screen.findByLabelText("Client ID"), {
      target: { value: "cid-123" },
    });
    fireEvent.change(screen.getByLabelText("Client secret"), {
      target: { value: "super-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save custom app" }));

    await waitFor(() =>
      expect(mockApi.setLinearApp).toHaveBeenCalledWith({
        client_id: "cid-123",
        client_secret: "super-secret",
        redirect_uri: undefined,
      }),
    );

    // After save the badge appears and the secret is nowhere in the DOM.
    expect(await screen.findByText("Custom app configured")).toBeInTheDocument();
    expect(screen.queryByText("super-secret")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("super-secret")).not.toBeInTheDocument();
  });

  it("switches to the official app via clearLinearApp", async () => {
    mockApi.setLinearApp.mockResolvedValue({
      linear_app: { client_id: "cid-123", redirect_uri: null, configured: true },
    });
    mockApi.clearLinearApp.mockResolvedValue({ ok: true, linear_app: null });
    renderWithProviders(<AccountPage />);

    fireEvent.change(await screen.findByLabelText("Client ID"), {
      target: { value: "cid-123" },
    });
    fireEvent.change(screen.getByLabelText("Client secret"), {
      target: { value: "super-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save custom app" }));

    fireEvent.click(
      await screen.findByRole("button", { name: "Use official app" }),
    );

    await waitFor(() => expect(mockApi.clearLinearApp).toHaveBeenCalled());
    expect(
      await screen.findByText("Using official Podium app"),
    ).toBeInTheDocument();
  });
});
