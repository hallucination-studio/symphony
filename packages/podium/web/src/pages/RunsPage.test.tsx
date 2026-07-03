import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "../test/utils";
import RunsPage from "./RunsPage";
import { api } from "../api/client";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { recentRuns: vi.fn() } };
});

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe("RunsPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows an empty state when there are no runs", async () => {
    mockApi.recentRuns.mockResolvedValue({ runs: [] });
    renderWithProviders(<RunsPage />);

    expect(await screen.findByText("No runs yet")).toBeInTheDocument();
  });

  it("lists runs and opens detail with the failure reason", async () => {
    mockApi.recentRuns.mockResolvedValue({
      runs: [
        {
          run_id: "run-1",
          issue_identifier: "ENG-42",
          runtime_id: "rt-1",
          status: "failed",
          started_at: "2026-07-01T10:00:00Z",
          completed_at: "2026-07-01T10:05:00Z",
          duration_seconds: 300,
          failure_reason: "Tests failed on step 3",
        },
      ],
    });
    renderWithProviders(<RunsPage />);

    fireEvent.click(await screen.findByText("ENG-42"));
    // Drawer detail shows the run id.
    expect(await screen.findByText("run-1")).toBeInTheDocument();
    // Failure reason appears in both list and drawer.
    expect(
      screen.getAllByText("Tests failed on step 3").length,
    ).toBeGreaterThan(0);
  });
});
