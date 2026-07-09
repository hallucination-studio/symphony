import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/utils";
import ManagedRunsPage from "./ManagedRunsPage";
import { api } from "../api/client";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { managedRuns: vi.fn() } };
});

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe("ManagedRunsPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders managed runs and work items", async () => {
    mockApi.managedRuns.mockResolvedValue({
      runtime_group_id: "group-1",
      policy_revision: 2,
      profiles: {},
      managed_runs: {
        runs: [
          {
            run_id: "run-1",
            parent_issue_id: "issue-parent",
            issue_identifier: "LIN-123",
            state: "executing",
            active_work_item_id: "wi-1",
            plan_version: 3,
            backend_session_id: "thread-1",
            work_items: [
              {
                work_item_id: "wi-1",
                state: "in_progress",
                gate_status: "red passing",
                payload: {
                  title: "Implement managed runs",
                  objective: "Switch runtime reporting to managed run state",
                  files_likely_touched: ["packages/podium/src/podium/podium_routes_runtime_ops.py"],
                },
              },
            ],
          },
        ],
      },
    });

    renderWithProviders(<ManagedRunsPage />);

    expect(await screen.findByText("Managed Runs")).toBeInTheDocument();
    expect(screen.getByText("group-1")).toBeInTheDocument();
    expect(screen.getByText("LIN-123")).toBeInTheDocument();
    expect(screen.getByText("Implement managed runs")).toBeInTheDocument();
    expect(screen.getByText("red passing")).toBeInTheDocument();
  });

  it("renders an empty state when no managed run report exists", async () => {
    mockApi.managedRuns.mockResolvedValue({
      runtime_group_id: "group-1",
      policy_revision: 2,
      profiles: {},
      managed_runs: { runs: [] },
    });

    renderWithProviders(<ManagedRunsPage />);

    expect(await screen.findByText("No managed run report yet")).toBeInTheDocument();
  });
});
