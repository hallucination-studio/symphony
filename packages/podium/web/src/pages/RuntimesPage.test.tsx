import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
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
});
