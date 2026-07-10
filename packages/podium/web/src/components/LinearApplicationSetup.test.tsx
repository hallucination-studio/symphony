import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { api } from "../api/client";
import * as navigation from "../lib/navigation";
import { renderWithProviders } from "../test/utils";
import { LinearApplicationSetup } from "./LinearApplicationSetup";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      linearApplication: vi.fn(),
      linearInstallations: vi.fn(),
      saveLinearApplication: vi.fn(),
      selectDefaultLinearApplication: vi.fn(),
      startLinear: vi.fn(),
    },
  };
});

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
const defaultApplication = {
  id: "app-default",
  source: "default" as const,
  version: 3,
  client_id: "default-client",
  callback_url: "https://podium.example/api/v1/linear/oauth/callback",
};
const customApplication = {
  ...defaultApplication,
  id: "app-custom",
  source: "custom" as const,
  client_id: "customer-client",
};

describe("LinearApplicationSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.linearApplication.mockResolvedValue({ application: defaultApplication });
    mockApi.linearInstallations.mockResolvedValue({ active: null, candidate: null, revocation: null });
    mockApi.startLinear.mockResolvedValue({ authorization_url: "https://linear.example/oauth" });
  });

  it("starts in default mode without rendering customer application fields", async () => {
    const { container } = renderWithProviders(
      <LinearApplicationSetup linear={{ workspace_id: "user-1", state: "not_connected" }} />,
    );

    expect(await screen.findByRole("radio", { name: "Podium application" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.queryByLabelText("Client ID")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Client secret")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Callback URL")).not.toBeInTheDocument();
    expect(container.querySelector(".linear-installation-status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Authorize Linear" })).toBeInTheDocument();
  });

  it("reveals only the BYO credentials and Podium-owned callback", async () => {
    mockApi.saveLinearApplication.mockResolvedValue({ application: customApplication });
    const assign = vi.spyOn(navigation, "assignLocation").mockImplementation(() => undefined);
    renderWithProviders(
      <LinearApplicationSetup linear={{ workspace_id: "user-1", state: "not_connected" }} />,
    );

    fireEvent.click(await screen.findByRole("radio", { name: "Own application" }));
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "customer-client" } });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "customer-secret" } });

    const callback = screen.getByLabelText("Callback URL");
    expect(callback).toHaveAttribute("readonly");
    expect(callback).toHaveValue("https://podium.example/api/v1/linear/oauth/callback");
    fireEvent.click(screen.getByRole("button", { name: "Save and authorize" }));

    await waitFor(() =>
      expect(mockApi.saveLinearApplication).toHaveBeenCalledWith({
        client_id: "customer-client",
        client_secret: "customer-secret",
      }),
    );
    expect(await screen.findByLabelText("Client secret")).toHaveValue("");
    expect(assign).toHaveBeenCalledWith("https://linear.example/oauth");
    assign.mockRestore();
  });

  it("reopens an existing custom choice and hides it after selecting default", async () => {
    mockApi.linearApplication.mockResolvedValue({ application: customApplication });
    mockApi.selectDefaultLinearApplication.mockResolvedValue({ application: defaultApplication });
    renderWithProviders(
      <LinearApplicationSetup linear={{ workspace_id: "user-1", state: "not_connected" }} />,
    );

    expect(await screen.findByLabelText("Client ID")).toHaveValue("customer-client");
    fireEvent.click(screen.getByRole("radio", { name: "Podium application" }));

    await waitFor(() => expect(mockApi.selectDefaultLinearApplication).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText("Client ID")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Client secret")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Callback URL")).not.toBeInTheDocument();
  });

  it("shows durable denial and active polling health without exposing raw OAuth text", async () => {
    mockApi.linearInstallations.mockResolvedValue({
      active: {
        id: "installation-1",
        application_source: "default",
        state: "ready",
        actor: "app",
        organization_name: "Acme",
        app_user_id: "app-user-1",
        scope: ["read", "write", "app:assignable"],
        reconciliation_state: "healthy",
        reconciliation_retry_count: 0,
      },
      candidate: {
        id: "installation-denied",
        application_source: "default",
        state: "failed",
        actor: "",
        scope: [],
        error_code: "linear_oauth_denied",
        sanitized_reason: "Linear authorization was not approved",
        next_action: "reauthorize",
      },
      revocation: null,
    });
    renderWithProviders(
      <LinearApplicationSetup linear={{ workspace_id: "user-1", state: "connected" }} />,
      { route: "/setup/linear?linear=denied&code=linear_oauth_denied" },
    );

    expect(await screen.findByText("Linear authorization was not approved")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("read, write, app:assignable")).toBeInTheDocument();
    expect(screen.getAllByText("Healthy")).toHaveLength(2);
    expect(screen.queryByText(/User denied access/i)).not.toBeInTheDocument();
  });
});
