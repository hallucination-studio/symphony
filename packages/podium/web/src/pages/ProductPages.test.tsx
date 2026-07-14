import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/utils";
import HomePage from "./HomePage";
import ManagedRunsPage from "./ManagedRunsPage";
import IntegrationsPage from "./IntegrationsPage";
import { api } from "../api/client";
import type { Bootstrap } from "../api/types";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      bootstrap: vi.fn(),
      managedRuns: vi.fn(),
      smokeCheckResult: vi.fn(),
      linearApplication: vi.fn(),
      linearInstallations: vi.fn(),
      linearProjects: vi.fn(),
      selectLinearProjects: vi.fn(),
    },
  };
});

const mockApi = api as unknown as {
  bootstrap: ReturnType<typeof vi.fn>;
  managedRuns: ReturnType<typeof vi.fn>;
  smokeCheckResult: ReturnType<typeof vi.fn>;
  linearApplication: ReturnType<typeof vi.fn>;
  linearInstallations: ReturnType<typeof vi.fn>;
  linearProjects: ReturnType<typeof vi.fn>;
  selectLinearProjects: ReturnType<typeof vi.fn>;
};

function bootstrap(overrides: Partial<Bootstrap> = {}): Bootstrap {
  return {
    session: { workspace_id: "default" },
    onboarding: {
      current_step: "scope_selection",
      completed_steps: ["linear_connect"],
      next_action: "Select the teams and projects to route",
    },
    linear: { state: "connected" },
    ...overrides,
  };
}

function managedRunsPayload() {
  return {
    conductors: [
      {
        conductor: { id: "conductor-1", name: "Bach", public_id: "k7m3p2", online: true },
        project: { id: "project-1", slug: "LIN", name: "Linear Platform" },
        binding: { state: "ready", sanitized_reason: "" },
        runtime_group_id: "group-1",
        policy_revision: 2,
        managed_runs: {
          runs: [
            {
              run_id: "run-1",
              parent_issue_id: "issue-parent",
              issue_identifier: "LIN-123",
              state: "executing",
              active_work_item_id: "task-1",
              plan_version: 3,
              backend_session_id: "thread-1",
              work_items: [
                {
                  work_item_id: "task-1",
                  state: "in_progress",
                  gate_status: "red passing",
                  payload: {
                    title: "Implement workflow",
                    objective: "Run the ordered Linear workflow",
                    files_likely_touched: ["packages/conductor/src/conductor/workflow_driver.py"],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

describe("product pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.managedRuns.mockResolvedValue({ conductors: [] });
    mockApi.smokeCheckResult.mockRejectedValue(new Error("404"));
    mockApi.linearApplication.mockResolvedValue({
      application: {
        source: "default",
        client_id: "default-client",
        callback_url: "https://podium.example/api/v1/linear/oauth/callback",
      },
    });
    mockApi.linearInstallations.mockResolvedValue({
      active: null,
      candidate: null,
      revocation: null,
    });
    mockApi.linearProjects.mockResolvedValue({
      projects: [
        {
          id: "project-1",
          name: "Platform",
          slug_id: "platform",
          selected: true,
          access_state: "ready",
          bound: true,
        },
        {
          id: "project-2",
          name: "Applications",
          slug_id: "applications",
          selected: false,
          access_state: "ready",
          bound: false,
        },
      ],
    });
    mockApi.selectLinearProjects.mockResolvedValue({ projects: [] });
  });

  it("renders the current onboarding action", async () => {
    mockApi.bootstrap.mockResolvedValue(bootstrap());
    renderWithProviders(<HomePage />);
    expect(await screen.findByText("Select the teams and projects to route")).toBeInTheDocument();
    expect(screen.getByText("1/5")).toBeInTheDocument();
  });

  it("renders the completed onboarding state", async () => {
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

  it("shows the empty managed-runs state without a report", async () => {
    mockApi.managedRuns.mockResolvedValue({ conductors: [] });
    renderWithProviders(<ManagedRunsPage />);
    expect(await screen.findByText("No managed run report yet")).toBeInTheDocument();
  });

  it("renders the current run, task, and gate summary", async () => {
    mockApi.managedRuns.mockResolvedValue(managedRunsPayload());
    renderWithProviders(<ManagedRunsPage />);
    expect(await screen.findByText("Managed Runs")).toBeInTheDocument();
    expect(screen.getByText("group-1")).toBeInTheDocument();
    expect(screen.getByText("LIN-123")).toBeInTheDocument();
    expect(screen.getByText("Implement workflow")).toBeInTheDocument();
    expect(screen.getByText("red passing")).toBeInTheDocument();
  });

  it("manages the same multi-project selection from Integrations", async () => {
    mockApi.bootstrap.mockResolvedValue(bootstrap());

    renderWithProviders(<IntegrationsPage />);

    expect(await screen.findByText("Linear projects")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /platform/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /applications/i }));
    fireEvent.click(screen.getByRole("button", { name: /save projects/i }));

    await waitFor(() =>
      expect(mockApi.selectLinearProjects).toHaveBeenCalledWith([
        "project-1",
        "project-2",
      ]),
    );
  });
});
