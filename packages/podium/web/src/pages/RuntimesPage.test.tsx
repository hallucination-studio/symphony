import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/utils";
import RuntimesPage from "./RuntimesPage";
import { api } from "../api/client";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: { runtimes: vi.fn(), instanceLogs: vi.fn(), enrollmentToken: vi.fn() },
  };
});

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

function conductorWithPerformer() {
  return {
    id: "rt-1",
    conductor_id: "rt-1",
    runtime_id: "rt-1",
    hostname: "build-box",
    label: "",
    version: "1.2.3",
    online: true,
    last_report_at: new Date().toISOString(),
    bindings: [
      {
        id: "rt-1:inst-1",
        conductor_id: "rt-1",
        user_id: "user_1",
        instance_id: "inst-1",
        name: "checkout-flow",
        linear_project: "Web Backend",
        project_slug: "web-backend",
        agent_app_user_id: "agent-42",
        pipeline_profile: "default",
        process_status: "running",
        constraint_labels: ["symphony:performer/checkout-flow", "symphony:profile/task"],
        metrics: { retries: 2, blocked: 1, pending_human: 1, failures: 0, tokens: 1500, queue_depth: 3 },
        queue: { queue_depth: 3, running: true },
      },
    ],
  };
}

describe("RuntimesPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows an empty state with a call to install", async () => {
    mockApi.runtimes.mockResolvedValue({ runtimes: [], conductors: [] });
    renderWithProviders(<RuntimesPage />);

    expect(await screen.findByText("No runtimes yet")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /install a runtime/i }),
    ).toHaveAttribute("href", "/setup/runtime");
  });

  it("renders a Conductor with its Performer, constraints and queue metrics", async () => {
    mockApi.runtimes.mockResolvedValue({
      runtimes: [],
      conductors: [conductorWithPerformer()],
    });
    renderWithProviders(<RuntimesPage />);

    // Conductor host + Performer name + a constraint value + a queue metric.
    expect(await screen.findByText("build-box")).toBeInTheDocument();
    expect(screen.getByText("checkout-flow")).toBeInTheDocument();
    expect(screen.getByText("agent-42")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByText("Human")).toBeInTheDocument();
  });

  it("opens a Performer drawer and loads its logs", async () => {
    mockApi.runtimes.mockResolvedValue({
      runtimes: [],
      conductors: [conductorWithPerformer()],
    });
    mockApi.instanceLogs.mockResolvedValue({
      logs: {
        conductor_id: "rt-1",
        instance_id: "inst-1",
        order: "desc",
        lines: ["performer boot ok", "leased dispatch"],
      },
    });
    renderWithProviders(<RuntimesPage />);

    fireEvent.click(await screen.findByText("checkout-flow"));

    await waitFor(() => expect(mockApi.instanceLogs).toHaveBeenCalled());
    expect(await screen.findByText("performer boot ok")).toBeInTheDocument();
    expect(screen.getByText("Performer logs")).toBeInTheDocument();
    expect(screen.getByText("Linear project labels")).toBeInTheDocument();
    expect(screen.getByText("symphony:performer/checkout-flow")).toBeInTheDocument();
  });

  it("flags a Performer that is missing constraints as unscoped", async () => {
    const conductor = conductorWithPerformer();
    conductor.bindings[0].agent_app_user_id = "";
    mockApi.runtimes.mockResolvedValue({ runtimes: [], conductors: [conductor] });
    renderWithProviders(<RuntimesPage />);

    expect(await screen.findByText("Unscoped")).toBeInTheDocument();
  });

  it("offers reconnect for runtimes that haven't reported yet", async () => {
    mockApi.runtimes.mockResolvedValue({
      runtimes: [
        {
          runtime_id: "rt-2",
          online: false,
          version: null,
          last_heartbeat: null,
          metadata: {},
        },
      ],
      conductors: [],
    });
    mockApi.enrollmentToken.mockResolvedValue({
      enrollment_token: "tok-drawer",
      workspace_id: "default",
      install_command: "install --token tok-drawer",
      expires_at: "2026-07-02T12:00:00Z",
    });
    renderWithProviders(<RuntimesPage />);

    fireEvent.click(await screen.findByText("rt-2"));
    fireEvent.click(
      await screen.findByRole("button", { name: /regenerate install command/i }),
    );

    await waitFor(() => expect(mockApi.enrollmentToken).toHaveBeenCalled());
    expect(await screen.findByText("install --token tok-drawer")).toBeInTheDocument();
  });
});
