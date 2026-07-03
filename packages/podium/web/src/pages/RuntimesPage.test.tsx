import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/utils";
import RuntimesPage from "./RuntimesPage";
import { api } from "../api/client";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { runtimes: vi.fn(), enrollmentToken: vi.fn() } };
});

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe("RuntimesPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows an empty state with a call to install", async () => {
    mockApi.runtimes.mockResolvedValue({ runtimes: [] });
    renderWithProviders(<RuntimesPage />);

    expect(await screen.findByText("No runtimes yet")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /install a runtime/i }),
    ).toHaveAttribute("href", "/setup/runtime");
  });

  it("lists runtimes and opens a detail drawer", async () => {
    mockApi.runtimes.mockResolvedValue({
      runtimes: [
        {
          runtime_id: "rt-1",
          online: true,
          version: "1.2.3",
          last_heartbeat: new Date().toISOString(),
          metadata: { hostname: "build-box" },
        },
      ],
    });
    renderWithProviders(<RuntimesPage />);

    fireEvent.click(await screen.findByText("rt-1"));
    // Drawer shows the hostname from metadata.
    expect(await screen.findByText("build-box")).toBeInTheDocument();
  });

  it("regenerates a reconnect install command in the drawer", async () => {
    mockApi.runtimes.mockResolvedValue({
      runtimes: [
        {
          runtime_id: "rt-1",
          online: false,
          version: null,
          last_heartbeat: null,
          metadata: {},
        },
      ],
    });
    mockApi.enrollmentToken.mockResolvedValue({
      enrollment_token: "tok-drawer",
      workspace_id: "default",
      install_command: "install --token tok-drawer",
      expires_at: "2026-07-02T12:00:00Z",
    });
    renderWithProviders(<RuntimesPage />);

    fireEvent.click(await screen.findByText("rt-1"));
    fireEvent.click(await screen.findByRole("button", { name: /regenerate install command/i }));

    await waitFor(() => expect(mockApi.enrollmentToken).toHaveBeenCalled());
    expect(await screen.findByText("install --token tok-drawer")).toBeInTheDocument();
    expect(await screen.findByText("tok-drawer")).toBeInTheDocument();
  });
});
