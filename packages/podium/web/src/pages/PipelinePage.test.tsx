import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/utils";
import PipelinePage from "./PipelinePage";
import { api } from "../api/client";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { pipeline: vi.fn() } };
});

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe("PipelinePage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders mode capacity and predicted blocked calls", async () => {
    mockApi.pipeline.mockResolvedValue({
      runtime_group_id: "group-1",
      policy_revision: 2,
      profiles: {},
      pipeline: {
        graph_revision: 4,
        policy_revision: 2,
        modes: [
          { mode: "plan", active: 1, limit: 1, queued: 0, node_ids: ["issue-1"] },
          { mode: "execute", active: 0, limit: null, queued: 2, node_ids: ["issue-2"] },
          { mode: "verify", active: 0, limit: 1, queued: 0, node_ids: [] },
        ],
        predicted_call_order: [
          {
            node: "issue-2",
            predicted_position: null,
            blocked_by: ["issue-1: verify not passed"],
            earliest_mode: "execute",
            confidence: "conditional",
          },
        ],
        human_waits: [],
        runtime_waits: [],
      },
    });

    renderWithProviders(<PipelinePage />);

    expect(await screen.findByText("Graph revision")).toBeInTheDocument();
    expect(screen.getByText("group-1")).toBeInTheDocument();
    expect(screen.getByText("issue-1")).toBeInTheDocument();
    expect(screen.getByText("issue-1: verify not passed")).toBeInTheDocument();
  });

  it("renders runtime approval and tool-input waits as first-class pipeline state", async () => {
    mockApi.pipeline.mockResolvedValue({
      runtime_group_id: "group-1",
      policy_revision: 2,
      profiles: {},
      pipeline: {
        graph_revision: 4,
        policy_revision: 2,
        modes: [
          { mode: "plan", active: 0, limit: 1, queued: 0, node_ids: [] },
          { mode: "execute", active: 1, limit: null, queued: 0, node_ids: ["issue-2"] },
          { mode: "verify", active: 0, limit: 1, queued: 0, node_ids: [] },
        ],
        predicted_call_order: [],
        human_waits: [],
        runtime_waits: [
          {
            node_id: "issue-2",
            attempt_id: "exec-wait",
            mode: "execute",
            wait_kind: "approval_requested",
            status: "waiting",
            message: "Codex requested approval",
            command: "git status --short",
          },
        ],
      },
    });

    renderWithProviders(<PipelinePage />);

    expect(await screen.findByText("Runtime waits")).toBeInTheDocument();
    expect(screen.getAllByText("issue-2").length).toBeGreaterThan(0);
    expect(screen.getByText("approval_requested")).toBeInTheDocument();
    expect(screen.getByText("exec-wait")).toBeInTheDocument();
    expect(screen.getByText("git status --short")).toBeInTheDocument();
  });
});
