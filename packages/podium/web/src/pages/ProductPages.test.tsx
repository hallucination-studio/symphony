import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/utils";
import HomePage from "./HomePage";
import ManagedRunsPage from "./ManagedRunsPage";
import IntegrationsPage from "./IntegrationsPage";
import RuntimesPage from "./RuntimesPage";
import { api } from "../api/client";
import type { Bootstrap } from "../api/types";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      bootstrap: vi.fn(),
      startLinear: vi.fn(),
      managedRuns: vi.fn(),
      smokeCheckResult: vi.fn(),
      linearApplication: vi.fn(),
      linearInstallations: vi.fn(),
      linearProjects: vi.fn(),
      selectLinearProjects: vi.fn(),
      runtimes: vi.fn(),
      enrollmentToken: vi.fn(),
      bindConductor: vi.fn(),
    },
  };
});

const mockApi = api as unknown as {
  bootstrap: ReturnType<typeof vi.fn>;
  startLinear: ReturnType<typeof vi.fn>;
  managedRuns: ReturnType<typeof vi.fn>;
  smokeCheckResult: ReturnType<typeof vi.fn>;
  linearApplication: ReturnType<typeof vi.fn>;
  linearInstallations: ReturnType<typeof vi.fn>;
  linearProjects: ReturnType<typeof vi.fn>;
  selectLinearProjects: ReturnType<typeof vi.fn>;
  runtimes: ReturnType<typeof vi.fn>;
  enrollmentToken: ReturnType<typeof vi.fn>;
  bindConductor: ReturnType<typeof vi.fn>;
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
    mockApi.runtimes.mockResolvedValue({ conductors: [], runtimes: [] });
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

  it("adds multiple named Conductors from Runtimes without revisiting Linear", async () => {
    const conductors: ReturnType<typeof conductorRecord>[] = [];
    mockApi.runtimes.mockImplementation(async () => ({ conductors, runtimes: [] }));
    mockApi.enrollmentToken.mockImplementation(async ({
      name,
      conductor_id: conductorId,
    }: { name?: string; conductor_id?: string }) => {
      const existing = conductors.find((row) => row.id === conductorId);
      const index = existing ? conductors.indexOf(existing) + 1 : conductors.length + 1;
      const conductor = existing ?? conductorRecord({
        id: `conductor-${index}`,
        name: name!,
        publicId: index === 1 ? "k7m3p2" : "v9d4s1",
        enrollmentState: "pending",
        online: false,
      });
      if (!existing) conductors.push(conductor);
      return {
        enrollment_token: `secret-token-${index}`,
        install_command: `install secret-token-${index}`,
        expires_at: "2026-07-14T12:00:00Z",
        conductor: {
          id: conductor.id,
          name: conductor.name,
          public_id: conductor.public_id,
          enrollment_state: conductor.enrollment_state,
          hostname: conductor.hostname,
          version: conductor.version,
          service_identity: conductor.service_identity,
          data_root: conductor.data_root,
          online: conductor.online,
          last_report_at: conductor.last_report_at,
          binding: conductor.binding,
        },
      };
    });

    renderWithProviders(<RuntimesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Add Conductor" }));
    fireEvent.change(screen.getByLabelText("Conductor name"), {
      target: { value: "Bach" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate install command" }));
    expect(await screen.findByText("install secret-token-1")).toBeInTheDocument();
    expect(mockApi.enrollmentToken).toHaveBeenLastCalledWith({ name: "Bach" });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue install" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate install command" }));
    expect(mockApi.enrollmentToken).toHaveBeenLastCalledWith({
      conductor_id: "conductor-1",
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(await screen.findByRole("button", { name: "Add Conductor" }));
    expect(screen.queryByText("install secret-token-1")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Conductor name"), {
      target: { value: "Mozart" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate install command" }));
    expect(await screen.findByText("install secret-token-2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(await screen.findByText("Bach-k7m3p2")).toBeInTheDocument();
    expect(screen.getByText("Mozart-v9d4s1")).toBeInTheDocument();
    expect(mockApi.startLinear).not.toHaveBeenCalled();
  });

  it("distinguishes pending, online, offline, and unbound Conductors", async () => {
    mockApi.runtimes.mockResolvedValue({
      conductors: [
        conductorRecord({
          id: "pending",
          name: "Bach",
          publicId: "k7m3p2",
          enrollmentState: "pending",
          online: false,
        }),
        conductorRecord({
          id: "online",
          name: "Mozart",
          publicId: "v9d4s1",
          enrollmentState: "enrolled",
          online: true,
          hostname: "studio-mac",
          version: "1.2.3",
        }),
        conductorRecord({
          id: "offline",
          name: "Ravel",
          publicId: "p4c8n6",
          enrollmentState: "enrolled",
          online: false,
          hostname: "build-host",
          version: "1.2.2",
        }),
      ],
      runtimes: [],
    });

    renderWithProviders(<RuntimesPage />);

    expect(await screen.findByText("Bach-k7m3p2")).toBeInTheDocument();
    expect(screen.getByText("Mozart-v9d4s1")).toBeInTheDocument();
    expect(screen.getByText("Ravel-p4c8n6")).toBeInTheDocument();
    expect(screen.getByText(/studio-mac.*v1.2.3/i)).toBeInTheDocument();
    expect(screen.getByText(/build-host.*v1.2.2/i)).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getAllByText("Unbound")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Add Conductor" })).toBeInTheDocument();
  });

  it("binds an online unbound Conductor with the shared project form", async () => {
    const conductor = conductorRecord({
      id: "conductor-1",
      name: "Bach",
      publicId: "k7m3p2",
      enrollmentState: "enrolled",
      online: true,
      hostname: "studio-mac",
      version: "1.2.3",
    });
    mockApi.runtimes.mockResolvedValue({ conductors: [conductor], runtimes: [] });
    mockApi.linearProjects.mockResolvedValue({
      projects: [{
        id: "project-1",
        name: "Platform",
        slug_id: "platform",
        selected: true,
        access_state: "ready",
        bound: false,
      }],
    });
    mockApi.bindConductor.mockResolvedValue({
      binding: {
        id: "binding-1",
        conductor_id: "conductor-1",
        linear_project_id: "project-1",
        project_name: "Platform",
        project_slug: "platform",
        state: "pending_ack",
        config_version: 1,
        acknowledged_config_version: 0,
        error_code: "",
        sanitized_reason: "",
        next_action: "wait_for_conductor_ack",
        repository: { mode: "local_path", value: "/srv/repo" },
      },
    });

    renderWithProviders(<RuntimesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Bind project with Bach-k7m3p2" }));
    fireEvent.change(await screen.findByLabelText("Linear project"), {
      target: { value: "project-1" },
    });
    fireEvent.change(screen.getByPlaceholderText("/srv/projects/repository"), {
      target: { value: "/srv/repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Bind project to Bach-k7m3p2" }));

    await waitFor(() => {
      expect(mockApi.bindConductor).toHaveBeenCalledWith("conductor-1", {
        linear_project_id: "project-1",
        repository: { mode: "local_path", value: "/srv/repo" },
      });
    });
  });
});

function conductorRecord({
  id,
  name,
  publicId,
  enrollmentState,
  online,
  hostname = "",
  version = "",
}: {
  id: string;
  name: string;
  publicId: string;
  enrollmentState: "pending" | "enrolled";
  online: boolean;
  hostname?: string;
  version?: string;
}) {
  return {
    id,
    conductor_id: id,
    name,
    public_id: publicId,
    enrollment_state: enrollmentState,
    hostname,
    label: name,
    version,
    service_identity: `symphony-conductor-${publicId}`,
    data_root: "",
    online,
    last_report_at: null,
    binding: null,
    bindings: [],
  };
}
